/**
 * Agent 循环自检。
 *
 * 这是唯一一个跑**完整循环**的测试:模型 → 工具/续写 → 状态。
 * 循环里的判断(该不该续写、该不该再调一轮)是最容易写出死循环的地方,
 * 而它们此前完全没有覆盖。
 *
 * 用假服务器代替真实接口。运行:npm run check:agent
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { useSession } from '../src/store/session';
import { ensureSystemMessage, send } from '../src/llm/agent';
import { putImage } from '../src/lib/blob-store';
import { installIndexedDB } from './fake-idb';

const PIXELS = 'data:image/png;base64,iVBORw0KGgo=';
const img = (id: string) => ({ id, w: 10, h: 10, mime: 'image/png', bytes: 4 });

let pass = 0;
let fail = 0;

function ok(name: string, cond: boolean, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

type Reply = {
  content?: string;
  reasoning?: string;
  finish: string;
  toolCalls?: unknown[];
  /** 模拟服务商回的那份用量。真实接口里它跟在最后一个 chunk 上。 */
  usage?: { prompt?: number; completion?: number };
};

/** 按顺序对每个请求回一个预设的响应。 */
function serve(replies: Reply[]) {
  const requests: unknown[] = [];
  let i = 0;
  return new Promise<{ url: string; requests: unknown[]; close: () => void }>((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          requests.push(JSON.parse(body));
        } catch {
          requests.push(body);
        }
        const reply = replies[Math.min(i++, replies.length - 1)];
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const frame = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
        if (reply.reasoning) frame({ choices: [{ delta: { reasoning_content: reply.reasoning } }] });
        if (reply.content) frame({ choices: [{ delta: { content: reply.content } }] });
        if (reply.toolCalls) frame({ choices: [{ delta: { tool_calls: reply.toolCalls } }] });
        frame({ choices: [{ delta: {}, finish_reason: reply.finish }] });
        if (reply.usage) {
          frame({ choices: [], usage: { prompt_tokens: reply.usage.prompt, completion_tokens: reply.usage.completion } });
        }
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        requests,
        close: () => {
          server.closeAllConnections();
          server.close();
        },
      });
    });
  });
}

/**
 * 等异步水合完成。
 *
 * 这件事在测试里是必须的:persist 的 merge 会**整体替换**活工作集,
 * 而水合是异步的。如果测试在它完成之前就写了状态,merge 落地时会把那些写入
 * 全部抹掉 —— 表现为"消息凭空消失",而且和被测代码毫无关系。
 *
 * (生产里由 App 的 hydrated 门控挡住,用户操作不可能早于水合。)
 */
function waitHydrated(): Promise<void> {
  if (useSession.getState().hydrated) return Promise.resolve();
  return new Promise((resolve) => {
    const unsub = useSession.subscribe((s) => {
      if (s.hydrated) {
        unsub();
        resolve();
      }
    });
  });
}

async function reset(url: string) {
  await waitHydrated();
  useSession.setState({
    messages: [],
    apiHistory: [],
    pendingEvents: [],
    busy: false,
    status: null,
    // 画布也要清 —— 上个用例留下的 artifact 会让下一个用例的断言失真
    artifacts: [],
    runtime: {},
    interactions: {},
    focusId: undefined,
  });
  useSession.getState().setSettings({ baseUrl: url, apiKey: 'sk-test', model: 'test', maxTokens: null, toolsEnabled: true });
}

const messages = () => useSession.getState().messages;
const lastAssistant = () => [...messages()].reverse().find((m) => m.role === 'assistant');

// 测试会故意触发各种失败,而产品代码会如实把它们记进控制台。
// 那些输出是给线上排障用的,在这里只会淹掉断言结果 —— 滤掉。
const realWarn = console.warn;
const realError = console.error;
const isNoise = (a: unknown) =>
  typeof a === 'string' && (a.includes('[zustand persist middleware]') || a.includes('[mathesis] 请求失败'));
console.warn = (...args: unknown[]) => {
  if (isNoise(args[0]) || args.some(isNoise)) return;
  realWarn(...args);
};
console.error = (...args: unknown[]) => {
  if (isNoise(args[0])) return;
  realError(...args);
};

// ---------------------------------------------------------------

async function main() {

  console.log('\n正文被截断 → 自动续写');

  {
    const s = await serve([
      { content: '前半段。', finish: 'length' },
      { content: '后半段。', finish: 'stop' },
    ]);
    await reset(s.url);
    await send({ text: '讲一下' });

    ok('确实发了第二次请求', s.requests.length === 2, `发了 ${s.requests.length} 次`);
    const second = JSON.stringify(s.requests[1] ?? {});
    ok('/继续/ 指令进入了第二次请求', second.includes('接着往下写'), second.slice(0, 120));
    ok('续写时明确要求不要重复', second.includes('不要重复'), '');
    ok(
      '两段正文拼在同一条展示消息里',
      lastAssistant()?.content === '前半段。后半段。',
      JSON.stringify(lastAssistant()?.content),
    );
    ok('有一条提示告诉学生发生了续写', messages().some((m) => m.role === 'notice' && /自动请求继续/.test(m.content)));
    ok('「继续」没有伪装成学生说的话', !messages().some((m) => m.role === 'user' && /继续|接着往下写/.test(m.content)));
    s.close();
  }

  console.log('\n思维链烧光预算 → 带 tools 时值得再给一次机会');

  {
    // DeepSeek 的规则:请求带 tools 时,历史的 reasoning_content **会拼进上下文**。
    // 也就是说模型看得到自己上一轮想到哪儿 —— 再给一份预算它可能接着往下想。
    // 不带 tools 时 reasoning_content 会被忽略、不进上下文,那时重试才是纯浪费。
    const s = await serve([{ reasoning: '想了很多很多', finish: 'length' }]);
    await reset(s.url);
    await send({ text: '讲一下' });

    ok('会重试,且封顶(1 次首答 + 3 次重试)', s.requests.length === 4, `发了 ${s.requests.length} 次`);

    // 这条是整个重试能不能成立的关键:必须把上一轮的思维链带回去。
    // 不带的话模型看不到自己想到哪儿了,重试就只是白白重跑一遍。
    const second = JSON.stringify(s.requests[1] ?? {});
    ok('重试请求里带上了上一轮的 reasoning_content', second.includes('想了很多很多'), second.slice(0, 200));

    ok(
      '最终停下时如实报告',
      messages().some((m) => m.role === 'notice' && /思维链/.test(m.content)),
    );
    s.close();
  }

  {
    // 不带 tools:reasoning_content 会被忽略、不进上下文,重试毫无意义 —— 一次就停。
    const s = await serve([{ reasoning: '想了很多很多', finish: 'length' }]);
    await reset(s.url);
    useSession.getState().setSettings({ toolsEnabled: false });
    await send({ text: '讲一下' });

    ok('不带 tools 时不重试(推理进不了上下文,重跑没有意义)', s.requests.length === 1, `发了 ${s.requests.length} 次`);
    s.close();
  }

  console.log('\n续写次数有上限');

  {
    // 每一轮都返回正文但都被截断 —— 必须停下来,不能无限续。
    const s = await serve([{ content: '一段。', finish: 'length' }]);
    await reset(s.url);
    await send({ text: '讲一下' });

    ok('续写次数封顶(1 次首答 + 3 次续写)', s.requests.length === 4, `发了 ${s.requests.length} 次`);
    ok('停下时明确告诉学生', messages().some((m) => m.role === 'notice' && /仍然被截断/.test(m.content)));
    s.close();
  }

  console.log('\n历史里的 reasoning_content 必须完整回传');

  {
    // DeepSeek 的规则:只要请求带 tools,历史里**所有**轮次的 reasoning_content
    // 都要完整回传,不管那一轮有没有真的调用工具 —— 漏一个就 400。
    // 之前只在「本轮有工具调用」时带,没有工具调用的那条终端消息漏了,这是个真 bug。
    const s = await serve([
      { reasoning: '第一轮的思考', content: '第一轮回答', finish: 'stop' },
      { reasoning: '第二轮的思考', content: '第二轮回答', finish: 'stop' },
    ]);
    await reset(s.url);
    await send({ text: '第一个问题' });
    await send({ text: '第二个问题' });

    const second = JSON.stringify(s.requests[1] ?? {});
    ok('第二轮请求带上了第一轮的 reasoning_content', second.includes('第一轮的思考'), second.slice(0, 300));
    ok('并且没有把它塞进 content', !second.includes('"content":"第一轮的思考"'), '');
    s.close();
  }

  console.log('\n删除必须让模型知道');

  {
    // 删除是唯一一条不走工具调用的画布变更:创建和修改模型都能在工具结果里看到,
    // 删除走 UI 按钮直接改 store。不告诉它的话,下一轮它只看到目录里少了一项,
    // 分不清"被删了"和"从没存在过"。
    const s = await serve([{ content: '好', finish: 'stop' }]);
    await reset(s.url);
    const id = useSession.getState().addArtifact({ kind: 'quiz', question: '这个极限存在吗?' }, '测验：这个极限存在吗?', 'ai');
    useSession.getState().pushEvent({ type: 'remove', artifactId: id, title: '测验：这个极限存在吗?' });
    useSession.getState().removeArtifact(id);
    await send({ text: '继续' });

    const sent = JSON.stringify(s.requests[0] ?? {});
    ok('删除作为一条学生操作告诉模型', sent.includes('删掉了'), sent.slice(0, 400));
    // 事件自带的 title 必须用上 —— 去 store 查已经查不到了
    ok('用的是删除时的标题(此时 artifact 已不在画布上)', sent.includes('这个极限存在吗'), '');
    ok('目录里确实已经没有它了', !JSON.parse(sent).messages.at(-1).content.includes(`[${id}]`), '');
    s.close();
  }

  console.log('\n交互记录要进目录 —— 这是模型唯一能"看到学习者"的地方');

  {
    const s = await serve([{ content: '好', finish: 'stop' }]);
    await reset(s.url);
    const id = useSession
      .getState()
      .addArtifact({ kind: 'plot2d', view: { x: [0, 1] }, curves: [{ type: 'explicit', expr: 'x' }] }, 'y = x', 'ai');
    const store = useSession.getState();
    for (let i = 0; i < 3; i++) store.pushEvent({ type: 'paramChange', artifactId: id, param: 'a', value: i });
    store.pushEvent({ type: 'stepConfused', artifactId: id, stepId: 's4' });
    store.pushEvent({ type: 'stepConfused', artifactId: id, stepId: 's4' });
    store.drainEvents(); // 清掉待发事件,只看目录里带没带上

    await send({ text: '看看' });
    const content = JSON.parse(JSON.stringify(s.requests[0])).messages.at(-1).content as string;

    ok('拖参数的次数进了目录', content.includes('拖过 3 次参数'), content.slice(0, 400));
    ok('标记不懂的步骤进了目录', content.includes('s4 标记不懂'), content.slice(0, 400));
    ok('同一步骤标记两次只记一次', !content.includes('s4/s4'), content.slice(0, 400));
    s.close();
  }

  {
    // 从没交互过的条目不加标注 —— 否则目录会被一堆"没碰过"撑爆
    const s = await serve([{ content: '好', finish: 'stop' }]);
    await reset(s.url);
    useSession.getState().addArtifact({ kind: 'quiz', question: 'q' }, '测验：q', 'ai');
    await send({ text: '看看' });
    const content = JSON.parse(JSON.stringify(s.requests[0])).messages.at(-1).content as string;
    ok('没交互过的条目不标注', !content.includes('·'), content.slice(0, 300));
    s.close();
  }

  console.log('\n工具调用');
  {
    const s = await serve([
      {
        content: '',
        finish: 'tool_calls',
        toolCalls: [{ index: 0, id: 'c1', function: { name: 'plot2d', arguments: '{"view":{"x":[0,1]},"curves":[{"type":"explicit","expr":"x"}]}' } }],
      },
      { content: '画好了。', finish: 'stop' },
    ]);
    await reset(s.url);
    await send({ text: '画个图' });

    ok('工具调用后回到模型继续', s.requests.length === 2, `发了 ${s.requests.length} 次`);
    ok('画布上出现了一个 artifact', useSession.getState().artifacts.length === 1);
    ok('工具结果被回传给了模型', JSON.stringify(s.requests[1]).includes('已绘制'), '');
    ok('最终正文落到了展示消息里', lastAssistant()?.content === '画好了。', JSON.stringify(lastAssistant()?.content));
    s.close();
  }

  {
    // 工具参数写坏了:错误要回给模型让它自己改,而不是崩掉
    const s = await serve([
      { content: '', finish: 'tool_calls', toolCalls: [{ index: 0, id: 'c1', function: { name: 'plot2d', arguments: '{"view":{"x":[5,-5]},"curves":[]}' } }] },
      { content: '我改了一下。', finish: 'stop' },
    ]);
    await reset(s.url);
    await send({ text: '画个图' });

    const second = JSON.stringify(s.requests[1] ?? {});
    ok('校验失败作为工具结果回给模型', second.includes('参数校验失败'), second.slice(0, 160));
    ok('没有因为模型写错参数就崩掉', useSession.getState().artifacts.length === 0);
    s.close();
  }

  console.log('\n工具参数写坏时,发给 API 的仍必须是合法 JSON');

  {
    // 实测到的 500:模型写第二个工具调用时被长度上限截断,arguments 是没闭合的 JSON。
    // 中转要把它解析成结构化输入来构造 tool_use,解析失败就把那一块整个丢了 ——
    // 于是我们的 tool_result 悬空,报错说"tool_result 缺少对应的 tool_use",
    // 指向完全错误的方向(看起来像我们漏传了调用)。
    const s = await serve([
      {
        content: '',
        finish: 'tool_calls',
        toolCalls: [
          { index: 0, id: 'c1', function: { name: 'plot2d', arguments: '{"view":{"x":[0,1]' } },
        ],
      },
      { content: '我重试一下。', finish: 'stop' },
    ]);
    await reset(s.url);
    await send({ text: '画个图' });

    // 假服务器已经把 body 解析过了
    const second = s.requests[1] as any;
    const assistant = second.messages[second.messages.length - 2];
    const toolMsg = second.messages[second.messages.length - 1];

    const sentArgs = assistant?.tool_calls?.[0]?.function?.arguments;
    ok('发给 API 的 arguments 是合法 JSON', (() => {
      try {
        JSON.parse(sentArgs);
        return true;
      } catch {
        return false;
      }
    })(), String(sentArgs));

    ok('tool_call_id 仍然对得上,没有悬空', toolMsg?.tool_call_id === assistant?.tool_calls?.[0]?.id, String(toolMsg?.tool_call_id));

    // 关键:我们自己仍然按**原始字符串**解析,所以模型拿到的还是有信息量的那条错误。
    // 如果这里也用了替换后的 {},模型只会看到"缺 view"之类,不知道是自己 JSON 写坏了。
    ok('模型仍被告知是 JSON 写坏了,而不是字段缺失', /不是合法 JSON/.test(toolMsg?.content ?? ''), String(toolMsg?.content).slice(0, 60));
    s.close();
  }

  console.log('\n图片:发给模型的是 content 数组');

  {
    const s = await serve([{ content: '我看到了这张图', finish: 'stop' }]);
    const idb = installIndexedDB();
    await putImage('img-1', PIXELS);
    await reset(s.url);
    useSession.getState().setSettings({ visionEnabled: true });

    await send({ text: '这道题怎么做', images: [img('img-1')] });

    const last = (s.requests[0] as any).messages.at(-1);
    ok('最后一条的 content 是数组', Array.isArray(last?.content), JSON.stringify(last?.content).slice(0, 80));
    ok('第一块是文本,而且带着学生的话', last?.content?.[0]?.type === 'text' && String(last.content[0].text).includes('这道题怎么做'), JSON.stringify(last?.content?.[0]).slice(0, 80));
    // URL 必须是**库里存的那一份**,不是别的东西拼出来的
    ok('第二块是图片,URL 就是存进去的那份', last?.content?.[1]?.type === 'image_url' && last.content[1].image_url.url === PIXELS, JSON.stringify(last?.content?.[1]).slice(0, 80));
    ok('展示消息里也带着引用', messages()[0]?.images?.[0]?.id === 'img-1', JSON.stringify(messages()[0]?.images));
    idb.uninstall();
    s.close();
  }

  {
    // 只发图不打字。此前有两处闸门会让它根本发不出去:
    // send 里的空消息判断,和输入框按钮的 disabled。
    const s = await serve([{ content: '收到', finish: 'stop' }]);
    const idb = installIndexedDB();
    await putImage('img-2', PIXELS);
    await reset(s.url);
    useSession.getState().setSettings({ visionEnabled: true });

    await send({ images: [img('img-2')] });

    ok('只发图不打字也真的发出去了', (s.requests as unknown[]).length === 1, String((s.requests as unknown[]).length));
    ok('而且没被标成一次画布操作', messages()[0]?.content === '', JSON.stringify(messages()[0]?.content));
    const text = (s.requests[0] as any).messages.at(-1)?.content?.[0]?.text ?? '';
    ok('告诉模型这是"只发了图",别让它去猜画布', String(text).includes('只发了一张图片'), String(text).slice(-60));
    idb.uninstall();
    s.close();
  }

  {
    // 开关关着:图片存下来了,但不发。沉默是不行的 ——
    // 模型会对着"这道题怎么做"硬答,或者假装自己看见了图。
    const s = await serve([{ content: '我看不到图片', finish: 'stop' }]);
    const idb = installIndexedDB();
    await putImage('img-3', PIXELS);
    await reset(s.url);
    useSession.getState().setSettings({ visionEnabled: false });

    await send({ text: '这道题怎么做', images: [img('img-3')] });

    ok('关着的时候一个 image_url 都不发', !JSON.stringify(s.requests[0]).includes('image_url'));
    const last = (s.requests[0] as any).messages.at(-1);
    ok('但明确说了它看不到', typeof last?.content === 'string' && last.content.includes('你看不到'), String(last?.content).slice(-80));
    ok('图片本身仍然留在消息里(没被丢掉)', messages()[0]?.images?.[0]?.id === 'img-3');
    idb.uninstall();
    s.close();
  }

  {
    // 刷新之后:apiHistory 是不落盘的,重建时图片必须从 blob 库重新拼回来。
    // 这是"图片必须挂在 ChatMessage 上"那条设计的验收点。
    const s = await serve([{ content: '好', finish: 'stop' }]);
    const idb = installIndexedDB();
    await putImage('img-4', PIXELS);
    await reset(s.url);
    useSession.getState().setSettings({ visionEnabled: true });

    await send({ text: '第一轮', images: [img('img-4')] });

    useSession.setState({ apiHistory: [] }); // 模拟一次载入
    await ensureSystemMessage();

    const rebuilt = (useSession.getState().apiHistory as any[]).find((m) => m.role === 'user');
    ok('重建之后图片又挂回去了', Array.isArray(rebuilt?.content) && rebuilt.content.some((p: any) => p.type === 'image_url' && p.image_url.url === PIXELS), JSON.stringify(rebuilt?.content).slice(0, 100));
    // 关键的一点:重建用的是消息原本的 content,不能再过一遍 composeUserContent,
    // 否则画布目录和"学生说:"会被重复注入进历史
    const textBlock = rebuilt?.content?.find((p: any) => p.type === 'text')?.text ?? '';
    ok('没有把这一轮的话重复注入一遍', !String(textBlock).includes('学生说：'), String(textBlock).slice(0, 80));
    idb.uninstall();
    s.close();
  }

  console.log('\n上下文用量 —— 让"我该换会话了吗"看得见');

  {
    const s = await serve([{ content: '好', finish: 'stop', usage: { prompt: 4321, completion: 6 } }]);
    await reset(s.url);
    useSession.setState({ contextTokens: null });

    await send({ text: '你好' });
    ok('用响应里的 usage 记下了上下文大小', useSession.getState().contextTokens === 4321, String(useSession.getState().contextTokens));
    s.close();
  }

  {
    // 拿不到 usage 时**不能把已有的数字抹掉**:界面上那个数一旦闪过 0,
    // 学生只会以为上下文被清空了,而实际上什么都没发生。
    const s = await serve([{ content: '好', finish: 'stop' }]);
    await reset(s.url);
    useSession.setState({ contextTokens: 999 });

    await send({ text: '你好' });
    ok('服务商没给 usage 时保持原值', useSession.getState().contextTokens === 999, String(useSession.getState().contextTokens));
    s.close();
  }

  {
    // 换会话要归零 —— 那是另一份历史,长度完全不相干
    const s = await serve([{ content: '好', finish: 'stop', usage: { prompt: 5000 } }]);
    await reset(s.url);
    await send({ text: '你好' });
    ok('先有一个数', useSession.getState().contextTokens === 5000);

    useSession.getState().newSession();
    ok('开新会话后归零(还不知道它有多长)', useSession.getState().contextTokens === null, String(useSession.getState().contextTokens));
    s.close();
  }

  console.log(`\n${pass} 通过, ${fail} 失败\n`);

}

main();
