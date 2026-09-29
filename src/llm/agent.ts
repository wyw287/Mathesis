/**
 * Agent 循环:把学生的一次输入变成「文本 + 画布变更」。
 *
 * 三件事在这里定型:
 *  1. 上下文注入 —— 每轮只把画布**目录**送进去,不是全部 spec
 *  2. 工具执行的失败处理 —— 校验错误回给模型让它自己改,而不是白屏
 *  3. 降级 —— 中转不支持 tool calling 时自动切文本模式,并记住这个事实
 */
import { useSession, type ApiMessage } from '../store/session';
import type { CanvasArtifact, CanvasEvent } from '../types/artifact';
import { TOOLS, toOpenAiTools, toolByName, toolsAsText, type ToolContext } from '../tools';
import { parseSpec, titleFor } from '../tools/specs';
import { ToolInputError } from '../tools/validate';
import { LlmError, ToolUnsupportedError, chat, type ToolCall } from './client';
import { FALLBACK_INSTRUCTION, extractArtifactBlocks, stripArtifactBlocks } from './fallback';
import { SYSTEM_PROMPT } from './prompt';

const MAX_TOOL_ROUNDS = 6;

// ------------------------------------------------------------------ 上下文

/** 目录项 + 一行要点。要点让模型不必 read_artifact 就知道哪里有洞。 */
function indexLine(a: CanvasArtifact): string {
  let extra = '';
  if (a.spec.kind === 'derivation') {
    const marked = a.spec.steps.filter((s) => s.gap).map((s) => `${s.id}:${s.gap}`);
    if (marked.length) extra = `  步骤${a.spec.steps.length} [${marked.join(' ')}]`;
  }
  return `[${a.id}] ${a.spec.kind}  ${a.title}${extra}`;
}

function artifactIndexText(): string {
  const { artifacts, focusId } = useSession.getState();
  if (!artifacts.length) return '[画布]\n(空)';
  const focus = focusId && artifacts.some((a) => a.id === focusId) ? `\n[学生当前聚焦] ${focusId}` : '';
  return `[画布]\n${artifacts.map(indexLine).join('\n')}${focus}`;
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
  }
}

/** 组装这一轮实际发给模型的内容。展示给学生的仍是原文。 */
function composeUserContent(text: string, events: CanvasEvent[]): string {
  const blocks = [artifactIndexText()];
  if (events.length) blocks.push(`[学生刚才在画布上的操作]\n${events.map(describeEvent).join('\n')}`);
  blocks.push(text.trim() ? `学生说：${text.trim()}` : '（学生没有输入文字，只是在画布上操作）');
  return blocks.join('\n\n');
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
    if (out.patched) useSession.getState().patchArtifact(out.patched.id, out.patched.patch);
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

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const msgId = store().pushMessage({ role: 'assistant', content: '' });
    const collected: string[] = [];
    let firstChunk = true;

    const outcome = await chat({
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      model: settings.model,
      messages: store().apiHistory,
      tools: opts.toolsMode ? toOpenAiTools() : undefined,
      signal: opts.signal,
      onPhase: setStatus,
      onText: (d) => {
        if (firstChunk) {
          firstChunk = false;
          setStatus('正在输出');
        }
        collected.push(d);
        store().appendToMessage(msgId, d);
      },
    });

    if (!outcome.toolCalls.length) {
      // 文本模式:从正文里把 artifact 块抠出来变成真正的画布对象
      if (!opts.toolsMode) {
        const full = collected.join('');
        const ids = materializeBlocks(full);
        const cleaned = stripArtifactBlocks(full);
        useSession.setState((s) => ({
          messages: s.messages.map((m) => (m.id === msgId ? { ...m, content: cleaned, artifactIds: ids } : m)),
        }));
        opts.onArtifacts?.(ids);
      }
      store().pushApi({ role: 'assistant', content: collected.join('') });
      return;
    }

    // 有工具调用:把助手这轮(可能带文字)记进协议历史,再逐个执行
    store().pushApi({
      role: 'assistant',
      content: outcome.content || null,
      tool_calls: outcome.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.argsRaw || '{}' },
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
  if (!text.trim() && !events.length) return;

  // 展示层只显示学生自己打的字和结构性事件,不显示注入的上下文
  const displayParts: string[] = [];
  if (text.trim()) displayParts.push(text.trim());
  for (const e of events) {
    if (e.type === 'stepConfused' || e.type === 'answer') displayParts.push(describeEvent(e));
  }
  store.pushMessage({ role: 'user', content: displayParts.join('\n') || '(画布操作)' });
  store.pushApi({ role: 'user', content: composeUserContent(text, events) });

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

/** 首次进入或重置对话时调用:把 system 消息放进协议历史。 */
export function ensureSystemMessage(): void {
  const store = useSession.getState();
  const toolsMode = store.settings.toolsEnabled;
  const api = store.apiHistory;
  if (api.length && (api[0] as any)?.role === 'system') {
    useSession.setState({ apiHistory: [{ role: 'system', content: buildSystemPrompt(toolsMode) }, ...api.slice(1)] });
    return;
  }
  store.pushApi({ role: 'system', content: buildSystemPrompt(toolsMode) } as ApiMessage);
}
