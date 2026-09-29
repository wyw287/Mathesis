/**
 * Agent 循环:把学生的一次输入变成「文本 + 画布变更」。
 *
 * 三件事在这里定型:
 *  1. 上下文注入 —— 每轮只把画布**目录**送进去,不是全部 spec
 *  2. 工具执行的失败处理 —— 校验错误回给模型让它自己改,而不是白屏
 *  3. 降级 —— 中转不支持 tool calling 时自动切文本模式,并记住这个事实
 */
import { useSession, type ApiMessage, type InteractionStats, type MessageImage } from '../store/session';
import type { CanvasArtifact, CanvasEvent } from '../types/artifact';
import { TOOLS, toOpenAiTools, toolByName, toolsAsText, type ToolContext } from '../tools';
import { parseSpec, titleFor } from '../kinds/registry';
import { ToolInputError } from '../lib/validate';
import { getDataUrl } from '../lib/blob-store';
import { LlmError, ToolUnsupportedError, chat, type ChatOutcome, type ToolCall } from './client';
import { FALLBACK_INSTRUCTION, extractArtifactBlocks, stripArtifactBlocks } from './fallback';
import { SYSTEM_PROMPT } from './prompt';

const MAX_TOOL_ROUNDS = 6;
/** 因输出上限被截断时,最多自动续写几次。和工具轮次共用同一个循环预算。 */
const MAX_CONTINUES = 3;

/**
 * 续写指令。
 *
 * 明确说「不要重复」很重要 —— 否则模型经常把已经写过的开头再写一遍,
 * 白烧一轮。加 [系统] 前缀是为了让它明白这不是学生说的话。
 */
const CONTINUE_INSTRUCTION =
  '[系统] 上一条回复因为达到输出上限被截断了,不是你说完了。' +
  '请从断点处接着往下写,不要重复已经输出过的内容,也不要重新开头。';

/**
 * 是否要把思维链随 assistant 消息回传。
 *
 * DeepSeek 的规则按请求里有没有 `tools` 分岔,而且方向相反:
 *
 *   · **不带 tools** —— 历史里的 reasoning_content 不需要回传;
 *     即使传了也会被忽略,**不会拼进上下文**。所以传了无害,只是浪费字节。
 *   · **带 tools** —— **必须完整回传**(即使那一轮没有实际调用工具),
 *     因为它会被拼进上下文。漏传会直接 400。
 *
 * 而我们的循环默认就带 tools,所以只有一种正确做法:**有就带上**。
 * 之前只在「本轮有工具调用」时带,终端那条 assistant 消息漏了 —— 那是错的。
 */
function reasoningField(reasoningText: string): Record<string, string> {
  return reasoningText ? { reasoning_content: reasoningText } : {};
}

// ------------------------------------------------------------------ 上下文

/** 目录项 + 一行要点。要点让模型不必 read_artifact 就知道哪里有洞。 */
function indexLine(a: CanvasArtifact, stats: InteractionStats | undefined): string {
  let extra = '';
  if (a.spec.kind === 'derivation') {
    const marked = a.spec.steps.filter((s) => s.gap).map((s) => `${s.id}:${s.gap}`);
    if (marked.length) extra = `  步骤${a.spec.steps.length} [${marked.join(' ')}]`;
  }
  return `[${a.id}] ${a.spec.kind}  ${a.title}${extra}${interactionNote(stats)}`;
}

/**
 * 学生对这张图做过什么。
 *
 * 这是模型唯一能"看到学习者"的地方 —— 在此之前它只能看到画布。没有这些,
 * 主动引导就无从谈起:不知道学生卡在哪,就没法决定该加速、换路径还是出题。
 *
 * 只在**真有过交互**时才标注。没标注的含义是"没做过交互操作",不等于"没看过"
 * —— 这两者的区别写进了系统提示词,免得模型把扫一眼当成没兴趣。
 */
function interactionNote(s: InteractionStats | undefined): string {
  if (!s) return '';
  const bits: string[] = [];
  if (s.confusedSteps.length) bits.push(`${s.confusedSteps.join('/')} 标记不懂`);
  if (s.paramChanges > 0) bits.push(`拖过 ${s.paramChanges} 次参数`);
  if (s.expandedSteps.length) bits.push(`展开过 ${s.expandedSteps.join('/')}`);
  if (s.answers > 0) bits.push(`作答 ${s.answers} 次`);
  return bits.length ? `  · ${bits.join('，')}` : '';
}

function artifactIndexText(): string {
  const { artifacts, focusId, interactions } = useSession.getState();
  if (!artifacts.length) return '[画布]\n(空)';
  const focus = focusId && artifacts.some((a) => a.id === focusId) ? `\n[学生当前聚焦] ${focusId}` : '';
  return `[画布]\n${artifacts.map((a) => indexLine(a, interactions[a.id])).join('\n')}${focus}`;
}

function titleOf(id: string): string {
  return useSession.getState().artifacts.find((a) => a.id === id)?.title ?? id;
}

function round2(n: number): string {
  return Number.isFinite(n) ? String(Math.round(n * 100) / 100) : String(n);
}

/** 画布事件 → 自然语言。学生看到的是自己拖了滑块,模型看到的是这句话。 */
function describeEvent(e: CanvasEvent): string {
  switch (e.type) {
    case 'paramChange':
      return `把「${titleOf(e.artifactId)}」的参数 ${e.param} 拖到了 ${round2(e.value)}`;
    case 'pointDrag':
      return `把「${titleOf(e.artifactId)}」的点 ${e.point} 拖到了 (${round2(e.xy[0])}, ${round2(e.xy[1])})`;
    case 'stepConfused':
      return `在「${titleOf(e.artifactId)}」的第 ${e.stepId} 步点了「这步不懂」`;
    case 'stepExpand':
      return `展开了「${titleOf(e.artifactId)}」的第 ${e.stepId} 步的说明`;
    case 'select':
      return `选中了「${titleOf(e.artifactId)}」${e.target ? ` 里的 ${e.target}` : ''}`;
    case 'answer':
      return `在「${titleOf(e.artifactId)}」作答：${e.response.choice ?? e.response.text ?? ''}`;
    case 'viewport':
      return `缩放了「${titleOf(e.artifactId)}」的视野到 x∈[${round2(e.view.x[0])}, ${round2(e.view.x[1])}]`;
    case 'orbit':
      return `转动了「${titleOf(e.artifactId)}」的视角`;
    case 'remove':
      // 用事件自带的 title,不能走 titleOf —— 事件被读到时 artifact 已经不在了
      return `删掉了「${e.title}」`;
  }
}

/**
 * 组装这一轮实际发给模型的内容。展示给学生的仍是原文。
 *
 * `hasImages` 只影响"没有文字"时那句占位说明 —— 只发了一张图,却告诉模型
 * "学生只是在画布上操作",它会去猜画布上发生了什么,而学生想问的其实是图。
 */
function composeUserContent(text: string, events: CanvasEvent[], hasImages = false): string {
  const blocks = [artifactIndexText()];
  if (events.length) blocks.push(`[学生刚才在画布上的操作]\n${events.map(describeEvent).join('\n')}`);
  const empty = hasImages ? '（学生只发了一张图片，没有文字）' : '（学生没有输入文字，只是在画布上操作）';
  blocks.push(text.trim() ? `学生说：${text.trim()}` : empty);
  return blocks.join('\n\n');
}

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/**
 * 给一段**已经拼好的**文本挂上图片。
 *
 * 刻意和 `composeUserContent` 分开:那个负责"这一轮要说的话"(注入画布目录、
 * 加"学生说:"前缀),这个只管形状。重建历史时用的是消息原本的文本,
 * 绝不能再过一遍 `composeUserContent` —— 那会把目录和前缀重复注入一遍。
 *
 * 没有图片时**原样返回那个字符串**。不是偷懒:绝大多数请求都没有图片,
 * 而 content 数组在有些中转上走的是另一条代码路径,能不改变形状就不改变。
 */
async function attachImages(
  text: string,
  images: MessageImage[],
  visionOn: boolean,
): Promise<string | ContentPart[]> {
  if (!images.length) return text;

  if (!visionOn) {
    // 沉默不行:模型会对着"这道题怎么做"硬答,或者假装自己看见了图。
    // 明确告诉它看不到,它才会请学生改用文字。
    return (
      `${text}\n\n[学生附上了 ${images.length} 张图片,但当前设置里没有开启` +
      '「当前模型支持图片输入」,你看不到它们。请明确告诉学生你看不到,并请他改用文字描述。]'
    );
  }

  const parts: ContentPart[] = [{ type: 'text', text }];
  let lost = 0;
  for (const im of images) {
    const url = await getDataUrl(im.id);
    // 读不到就跳过。**绝不能拿空 URL 占位** —— 那会被服务端当成坏参数直接 400。
    if (!url) {
      lost++;
      continue;
    }
    parts.push({ type: 'image_url', image_url: { url } });
  }
  if (lost) parts.push({ type: 'text', text: `[有 ${lost} 张图片已经丢失,读不出来了]` });
  return parts;
}

// -------------------------------------------------------------- 工具执行

interface ToolRunResult {
  content: string;
  artifactIds: string[];
}

function runTool(tc: ToolCall): ToolRunResult {
  const tool = toolByName(tc.name);
  if (!tool) {
    return { content: `没有名为 "${tc.name}" 的工具。可用工具：${TOOLS.map((t) => t.name).join(', ')}`, artifactIds: [] };
  }

  let args: unknown;
  try {
    args = JSON.parse(tc.argsRaw || '{}');
  } catch (e) {
    return {
      content: `参数不是合法 JSON（${(e as Error).message}）。请重新调用，确保 arguments 是合法 JSON。`,
      artifactIds: [],
    };
  }

  const ctx: ToolContext = {
    artifacts: useSession.getState().artifactIndex(),
    focus: useSession.getState().focusId,
    readArtifact: (id) => useSession.getState().getArtifact(id),
  };

  try {
    const out = tool.run(args, ctx);
    const ids: string[] = [];
    for (const c of out.created ?? []) {
      ids.push(useSession.getState().addArtifact(c.spec, c.title, 'ai'));
    }
    if (out.patched) {
      useSession.getState().patchArtifact(out.patched.id, out.patched.patch, out.patched.title);
    }
    return { content: out.message, artifactIds: ids };
  } catch (e) {
    // 校验失败是模型的输入错误,不是系统故障 —— 原样回给它,让它自己修
    if (e instanceof ToolInputError) {
      return { content: `参数校验失败：${e.message}\n请修正后重新调用 ${tc.name}。`, artifactIds: [] };
    }
    return { content: `工具执行出错：${(e as Error).message}`, artifactIds: [] };
  }
}

// ------------------------------------------------------------------ 主循环

interface LoopOptions {
  signal?: AbortSignal;
  toolsMode: boolean;
  /** 文本模式下拉取文本块时用 */
  onArtifacts?: (ids: string[]) => void;
}

async function runLoop(opts: LoopOptions): Promise<void> {
  const store = () => useSession.getState();
  const settings = store().settings;
  const setStatus = (p: string | null) => useSession.getState().setStatus(p);

  /** 续写时复用同一条展示消息,让被截断的回复看起来仍是一个整体。 */
  let carryMsgId: string | null = null;
  let continues = 0;

  /**
   * 被截断时尝试自动续写。返回 true 表示已安排好下一轮,调用方应当 continue。
   *
   * **只在真的产出了正文时才续写。** 这是这个功能唯一关键的约束,因为推理模型
   * 被截断有两种情况,长得一模一样但性质完全相反:
   *
   *   · 正文写了一半被切断 → 续写有效,接上就完事了。
   *   · 思维链写到一半被切断、正文一个字没有 → 见下面「空响应重试」那条分支。
   *
   * 这里只管第一种(有正文可续)。第二种走的是另一条路,因为它的前提完全不同:
   * 那时 `chat()` 会先抛空响应错误,重试与否取决于推理能不能进上下文。
   */
  function maybeContinue(produced: string, msgId: string): boolean {
    if (!produced.trim() || continues >= MAX_CONTINUES) return false;
    continues++;
    // 「继续」只进协议历史,不进展示 —— 不能让学生看到一句自己没说过的话
    store().pushApi({ role: 'user', content: CONTINUE_INSTRUCTION });
    carryMsgId = msgId;
    if (continues === 1) {
      store().pushMessage({
        role: 'notice',
        content: `回复达到输出上限被截断,已自动请求继续（最多 ${MAX_CONTINUES} 次）。`,
      });
    }
    return true;
  }

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    // 显式标注类型:carryMsgId 会被赋成 msgId,而 msgId 又来自 carryMsgId,
    // 不写的话 TS 推不出来(循环推断)。
    const msgId: string = carryMsgId ?? store().pushMessage({ role: 'assistant', content: '' });
    carryMsgId = null;
    const collected: string[] = [];
    let firstChunk = true;
    let reasoningChars = 0;
    let reasoningStarted = false;
    /** 这一轮的完整思维链。要随 assistant 消息回传 —— 见下面 pushApi 处的说明。 */
    let reasoningText = '';
    // 思考期间每来一个字就写一次 store 会把渲染打爆(实测一次回复有 8000+ 个分片)。
    // 状态行本来就每秒重绘一次,所以按时间节流就够了。
    let lastStatusAt = 0;

    let outcome: ChatOutcome | undefined;
    let emptyError: LlmError | undefined;
    try {
      outcome = await chat({
        baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      model: settings.model,
      messages: store().apiHistory,
      tools: opts.toolsMode ? toOpenAiTools() : undefined,
      maxTokens: settings.maxTokens,
      reasoningEffort: settings.reasoningEffort,
      signal: opts.signal,
      onPhase: setStatus,
      onReasoning: (d) => {
        reasoningChars += d.length;
        reasoningText += d;
        store().appendReasoning(msgId, d);
        const now = Date.now();
        if (!reasoningStarted) {
          // 第一次收到思维链:切到"思考中"。这一次会重置 startedAt,
          // 于是计时从开始思考算起 —— 阶段变了,重新计时是合理的。
          reasoningStarted = true;
          lastStatusAt = now;
          setStatus('思考中');
          useSession.getState().setReasoningChars(reasoningChars);
        } else if (now - lastStatusAt > 500) {
          lastStatusAt = now;
          useSession.getState().setReasoningChars(reasoningChars);
        }
      },
      onText: (d) => {
        if (firstChunk) {
          firstChunk = false;
          setStatus('正在输出');
        }
        collected.push(d);
        store().appendToMessage(msgId, d);
      },
      });
    } catch (e) {
      // 空响应单独留一条路:它可能只是"预算全烧在思考上",值得再给一次机会。
      // 其余错误照常往上抛,交给 send() 的降级和上报逻辑。
      if (e instanceof LlmError && e.code === 'empty_response') emptyError = e;
      else throw e;
    }

    // 空响应。这里不立刻失败 —— 有一种情况值得再给一次机会:
    // 推理模型把整份预算烧在思维链上、正文一个字没来得及写。
    //
    // 关键在于我们的循环**总是带 tools**,而 DeepSeek 在带 tools 的请求里
    // 会把历史的 reasoning_content **拼进上下文**。也就是说模型看得到自己
    // 上一轮想到哪儿了 —— 再给一份预算,它有可能接着往下想并写出正文。
    //
    // 这不是无根据的乐观:没有 tools 时 reasoning_content 会被忽略、不进上下文,
    // 那时续写确实只是白白重跑一遍,所以那种情况必须直接失败。
    if (!outcome) {
      if (emptyError && opts.toolsMode && reasoningText && continues < MAX_CONTINUES) {
        continues++;
        store().pushApi({ role: 'assistant', content: '', ...reasoningField(reasoningText) });
        store().pushApi({ role: 'user', content: CONTINUE_INSTRUCTION });
        carryMsgId = msgId;
        if (continues === 1) {
          store().pushMessage({
            role: 'notice',
            content: '模型把预算用在了思考上,已自动再给一次机会接着想。',
          });
        }
        continue;
      }
      throw emptyError;
    }

    if (!outcome.toolCalls.length) {
      const produced = collected.join('');

      // 文本模式:从正文里把 artifact 块抠出来变成真正的画布对象
      if (!opts.toolsMode) {
        const ids = materializeBlocks(produced);
        const cleaned = stripArtifactBlocks(produced);
        useSession.setState((s) => ({
          messages: s.messages.map((m) => (m.id === msgId ? { ...m, content: cleaned, artifactIds: ids } : m)),
        }));
        opts.onArtifacts?.(ids);
      }
      store().pushApi({ role: 'assistant', content: produced, ...reasoningField(reasoningText) });

      if (outcome.finishReason === 'length' && maybeContinue(produced, msgId)) continue;

      // 被长度上限截断的回复看起来和正常回复一模一样 —— 说到一半停住,
      // 学生只会以为老师讲完了。必须显式说出来。
      if (outcome.finishReason === 'length') {
        store().pushMessage({
          role: 'notice',
          content: produced.trim()
            ? `连续续写 ${MAX_CONTINUES} 次仍然被截断,已停下。\n建议在「设置」里把输出上限调大。`
            : '这次回复的预算全花在思维链上了,没有正文可以续写。\n' +
              '自动续写在这里没有用 —— 模型不会接着上次的思考继续,它会从头再想一遍,\n' +
              '然后撞上同一个上限。那只会烧掉 N 倍的预算换来同一个结果。\n' +
              '真正的解法是把输出上限调大,或者把问题拆小。',
        });
      }
      return;
    }

    // 有工具调用:把助手这轮(可能带文字)记进协议历史,再逐个执行
    store().pushApi({
      role: 'assistant',
      // 必须用空字符串而不是 null。DeepSeek 思考模式 + 工具调用时,null 会 400。
      content: outcome.content || '',
      // 思维链要随消息回传。理由见 reasoningField。
      ...reasoningField(reasoningText),
      tool_calls: outcome.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        // safeArguments 而不是 tc.argsRaw:坏 JSON 会让中转丢掉整个 tool_use,
        // 报错却指向"tool_result 缺少对应的 tool_use"。理由见该函数的注释。
        function: { name: tc.name, arguments: safeArguments(tc.argsRaw) },
      })),
    });

    const ids: string[] = [];
    const names = outcome.toolCalls.map((tc) => tc.name).join('、');
    setStatus(`正在执行：${names}`);
    for (const tc of outcome.toolCalls) {
      const r = runTool(tc);
      ids.push(...r.artifactIds);
      store().pushApi({ role: 'tool', tool_call_id: tc.id, content: r.content });
    }
    if (ids.length) {
      useSession.setState((s) => ({
        messages: s.messages.map((m) =>
          m.id === msgId ? { ...m, artifactIds: [...(m.artifactIds ?? []), ...ids] } : m,
        ),
      }));
    }
  }

  store().pushMessage({
    role: 'notice',
    content: `连续 ${MAX_TOOL_ROUNDS} 轮工具调用仍未收敛，已停下。可以换个说法再试一次。`,
  });
}

/** 把文本模式下的 artifact 块变成画布对象。坏块静默跳过。 */
function materializeBlocks(text: string): string[] {
  const ids: string[] = [];
  for (const block of extractArtifactBlocks(text)) {
    try {
      const spec = parseSpec(block.spec);
      ids.push(useSession.getState().addArtifact(spec, titleFor(spec), 'ai'));
    } catch {
      // 模型写坏了 spec,当普通文本留在对话里 —— 它自己看得见,下次会改
    }
  }
  return ids;
}

// -------------------------------------------------------------- 对外接口

export interface SendOptions {
  text?: string;
  /** 由画布事件触发(如「这步不懂」),不是学生打的字 */
  eventDriven?: CanvasEvent[];
  /** 学生贴进来的图片。像素在 blob 库里,这里只是引用。 */
  images?: MessageImage[];
  signal?: AbortSignal;
}

export async function send(opts: SendOptions = {}): Promise<void> {
  const store = useSession.getState();
  if (store.busy) {
    // 以前这里是静默 return。结果是:上一条请求如果卡住了,后面每一次发送都毫无反应,
    // 学生完全不知道发生了什么 —— 这比报错更糟。
    store.pushMessage({
      role: 'notice',
      content:
        '上一条消息还在处理中,这条没有发出去。等它结束,或者点「停止」。\n' +
        '如果它已经卡了很久没有动静,点「停止」就能恢复。',
    });
    return;
  }

  const settings = store.settings;
  if (!settings.apiKey.trim()) {
    store.pushMessage({ role: 'notice', content: '还没有配置 API Key。点右上角「设置」填上 API Key 和 Base URL。' });
    return;
  }
  if (!settings.model.trim()) {
    store.pushMessage({ role: 'notice', content: '还没有填模型名。点右上角「设置」补上。' });
    return;
  }

  const events = [...store.drainEvents(), ...(opts.eventDriven ?? [])];
  const text = opts.text ?? '';
  const images = opts.images ?? [];
  if (!text.trim() && !events.length && !images.length) return;

  // **必须在 pushMessage 之前。** 历史为空时它会从展示用的 messages 重建协议历史
  // (带图片的要从 blob 库重新拼出来),放在 push 之后就会把这一轮新消息重复计一次。
  //
  // 放在 send 里而不是让每个调用方自己调,是因为调用方有两个
  // (Chat 的输入框、ArtifactCard 的「这步不懂」),而后者此前漏了 ——
  // 那一轮请求根本没有系统提示词。
  await ensureSystemMessage();

  // 展示层只显示学生自己打的字和结构性事件,不显示注入的上下文
  const displayParts: string[] = [];
  if (text.trim()) displayParts.push(text.trim());
  for (const e of events) {
    if (e.type === 'stepConfused' || e.type === 'answer') displayParts.push(describeEvent(e));
  }
  store.pushMessage({
    role: 'user',
    // 只发图不打字是合法的,不能标成一次画布操作
    content: displayParts.join('\n') || (images.length ? '' : '(画布操作)'),
    images: images.length ? images : undefined,
  });
  store.pushApi({
    role: 'user',
    content: await attachImages(
      composeUserContent(text, events, images.length > 0),
      images,
      useSession.getState().settings.visionEnabled,
    ),
  });

  useSession.setState({ busy: true });
  useSession.getState().setStatus('准备请求');
  try {
    await runLoop({ signal: opts.signal, toolsMode: settings.toolsEnabled });
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      useSession.getState().pushMessage({ role: 'notice', content: '已停止。' });
      return;
    }
    if (e instanceof ToolUnsupportedError) {
      // 记住这个接口不支持工具,后面不再重试
      useSession.getState().setSettings({ toolsEnabled: false });
      useSession.getState().pushMessage({
        role: 'notice',
        content: '当前接口不支持工具调用，已切换到文本模式。画布功能仍可用，但生成可视化内容的可靠性会降低。可在设置里改回来。',
      });
      try {
        await runLoop({ signal: opts.signal, toolsMode: false });
      } catch (e2) {
        reportError(e2);
      }
      return;
    }
    reportError(e);
  } finally {
    useSession.setState({ busy: false, status: null });
  }
}

function reportError(e: unknown): void {
  console.error('[mathesis] 请求失败', e);
  const msg =
    e instanceof LlmError
      ? e.message
      : e instanceof Error
        ? `${e.message}\n\n${e.stack?.split('\n').slice(0, 3).join('\n') ?? ''}`
        : String(e);
  // 预设换行的错误信息按原样展示,不做折叠 —— 用户需要的就是原因本身
  useSession.getState().pushMessage({ role: 'notice', content: msg });
}

/** 系统提示词(按模式拼) */
export function buildSystemPrompt(toolsMode: boolean): string {
  return toolsMode ? SYSTEM_PROMPT : `${SYSTEM_PROMPT}\n${FALLBACK_INSTRUCTION}\n\n## 可用 spec 说明\n\n${toolsAsText()}`;
}

/**
 * 发给 API 的工具调用参数必须是**合法 JSON**,哪怕内容完全不对。
 *
 * 起因是一条实测的 500:模型在写第二个工具调用时被长度上限截断,`arguments`
 * 是个没闭合的 JSON 字符串。中转在翻译时要把它**解析成结构化输入**来构造
 * 自己的 tool_use 块,解析失败就把那一块整个丢了 —— 于是我们随后发过去的
 * tool_result 找不到对应调用,报错说"tool_result 缺少对应的 tool_use",
 * **指向完全错误的方向**(看起来像我们漏传了调用)。
 *
 * 换成 `{}` 之后,中转能正常翻译;而**我们自己仍然拿原始字符串去解析**,
 * 所以模型收到的还是"参数不是合法 JSON,请重新调用"那条有信息量的错误 ——
 * 那本来就是设计好要回给它的。
 */
function safeArguments(raw: string): string {
  const s = (raw ?? '').trim();
  if (!s) return '{}';
  try {
    JSON.parse(s);
    return s;
  } catch {
    return '{}';
  }
}

/**
 * 保证发给模型的历史里有一条最新的 system 消息,必要时从对话重建历史。
 *
 * 历史为空但对话还在,有两种情况:刷新了页面,或者刚切到另一个会话。
 * 这时从 `messages` 重建一份"贫化"历史,让模型至少知道聊过什么。
 *
 * **两条必须守住的约束:**
 *
 * 一、**只在历史为空时重建。** 否则「切走再切回」会把富含工具上下文的实时历史
 * 覆盖成贫化版 —— 那是不可逆的降级。
 *
 * 二、**绝不试图还原 `tool_calls`。** DeepSeek 的规则是:请求带 tools 时,历史里
 * assistant 的 `reasoning_content` 必须完整回传,漏传直接 400。而 reasoning 是
 * 故意不落盘的,所以还原 `tool_calls` 必然缺 reasoning、**必然 400**。
 * 重建只产出普通文本消息。
 *
 * 三、**图片是唯一一个需要重新取回来的东西。** 它和 reasoning 一样不在这份历史里,
 * 但不一样的是它落在 blob 库里、并没有丢 —— 所以带图的消息要重新拼成 content
 * 数组。这也是这个函数变成 `async` 的唯一原因。
 *
 * 由 `send()` 在 push 这一轮新消息**之前**调用,所以这里看到的 messages 都是
 * 已经完成的轮次。
 */
export async function ensureSystemMessage(): Promise<void> {
  const store = useSession.getState();
  // 按**当前**的设置拼 —— toolsEnabled 可能已因 ToolUnsupportedError 被降级改过
  const system: ApiMessage = { role: 'system', content: buildSystemPrompt(store.settings.toolsEnabled) };
  const api = store.apiHistory;

  if (api.length && (api[0] as any)?.role === 'system') {
    useSession.setState({ apiHistory: [system, ...api.slice(1)] });
    return;
  }
  if (api.length) {
    useSession.setState({ apiHistory: [system, ...api] });
    return;
  }

  // 带图的消息要把图片重新挂回去 —— 像素在 blob 库里,而 apiHistory 是不落盘的。
  // 不过这里用的是消息**原本的** content,不能再过一遍 composeUserContent:
  // 那会把画布目录和"学生说:"前缀重复注入进历史。
  const visionOn = store.settings.visionEnabled;
  const rebuilt: ApiMessage[] = [];
  for (const m of store.messages) {
    if (m.role === 'notice') continue; // notice 是界面提示,模型不该看到
    rebuilt.push({
      role: m.role,
      content: await attachImages(m.content, m.images ?? [], visionOn),
    });
  }
  useSession.setState({ apiHistory: [system, ...rebuilt] });
}
