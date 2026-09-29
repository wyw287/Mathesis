/**
 * 客户端对「坏接口」的容错自检。
 *
 * 这段代码的难点从来不是正常路径,而是各种残缺的第三方实现。
 * 用一个假服务器把这些坏情况全造出来打一遍 —— 尤其是「发完 [DONE] 却不关连接」,
 * 那个是真实观测到的挂死原因。
 *
 * 运行:npm run check:client
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chat, LlmError, resolveEndpoint } from '../src/llm/client';

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

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void;

function serve(handler: Handler): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => handler(req, res, body));
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        // closeAllConnections 是必须的:有个用例故意让连接一直开着(模拟心跳长连接),
        // 只调 close() 会等那条连接,整个测试进程就卡死在这里
        close: () => {
          server.closeAllConnections();
          server.close();
        },
      });
    });
  });
}

const sse = (res: http.ServerResponse) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
};

const frame = (delta: unknown) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;

async function call(
  url: string,
  tools?: unknown[],
  extra: { maxTokens?: number | null; reasoningEffort?: string | null; messages?: unknown[] } = {},
) {
  return chat({
    baseUrl: url,
    apiKey: 'sk-test',
    model: 'test',
    messages: extra.messages ?? [{ role: 'user', content: 'hi' }],
    tools,
    ...extra,
  });
}

async function callExpectingError(
  url: string,
  tools?: unknown[],
  extra: { maxTokens?: number | null; reasoningEffort?: string | null; messages?: unknown[] } = {},
): Promise<Error> {
  try {
    await call(url, tools, extra);
  } catch (e) {
    return e as Error;
  }
  throw new Error('本该失败却成功了');
}

const SAMPLE_TOOLS = [
  { type: 'function', function: { name: 'plot2d', description: 'x', parameters: { type: 'object' } } },
];

// ---------------------------------------------------------------

console.log('\n正常路径');

{
  const s = await serve((_req, res) => {
    sse(res);
    res.write(frame({ content: '极限' }));
    res.write(frame({ content: '不存在' }));
    res.write(frame({}, ));
    res.write('data: [DONE]\n\n');
    res.end();
  });
  const out = await call(s.url);
  ok('流式文本拼接正确', out.content === '极限不存在', `得到 "${out.content}"`);
  s.close();
}

{
  const s = await serve((_req, res) => {
    sse(res);
    res.write(frame({ content: '画个图' }));
    // tool_calls 的参数分片传,必须能拼回完整 JSON
    res.write(frame({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'plot2d', arguments: '{"view":' } }] }));
    res.write(frame({ tool_calls: [{ index: 0, function: { arguments: '{"x":[0,1]},"curves":[]}' } }] }));
    res.write('data: [DONE]\n\n');
    res.end();
  });
  const out = await call(s.url);
  ok('跨 chunk 的工具调用参数拼回完整 JSON', (() => {
    try {
      JSON.parse(out.toolCalls[0]?.argsRaw ?? '');
      return true;
    } catch {
      return false;
    }
  })(), out.toolCalls[0]?.argsRaw);
  ok('工具名解析正确', out.toolCalls[0]?.name === 'plot2d', out.toolCalls[0]?.name);
  s.close();
}

console.log('\n坏接口 —— 这些是会让人以为「发了没反应」的情况');

{
  // 关键用例:发完 [DONE] 仍然保持长连接。
  // 修复前这里会永远卡住,导致 busy 一直是 true,后续每一次发送都被静默吞掉。
  const s = await serve((_req, res) => {
    sse(res);
    res.write(frame({ content: '好' }));
    res.write('data: [DONE]\n\n');
    // 故意不 end(),模拟心跳长连接
  });
  const started = Date.now();
  const out = await Promise.race([
    call(s.url),
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error('挂死:收到 [DONE] 后没有返回')), 5000)),
  ]);
  const ms = Date.now() - started;
  ok('[DONE] 后不关连接也能立刻返回', out.content === '好' && ms < 3000, `耗时 ${ms}ms`);
  s.close();
}

{
  // 200 但 body 完全是空的
  const s = await serve((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end();
  });
  const e = await callExpectingError(s.url);
  ok('空响应报错信息里带上接口和事件数', /空响应/.test(e.message) && /数据事件/.test(e.message), e.message.slice(0, 60));
  s.close();
}

{
  // 200,但是个完全不认识的 JSON 格式
  const s = await serve((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, data: '不是 OpenAI 格式' }));
  });
  const e = await callExpectingError(s.url);
  ok('非 OpenAI 格式报错', /空响应|格式/.test(e.message), e.message.slice(0, 60));
  s.close();
}

{
  const s = await serve((_req, res) => {
    sse(res);
    res.write('data: {这不是合法 JSON\n\n'); // 半截 JSON
    res.write(frame({ content: '仍然可用' }));
    res.write('data: [DONE]\n\n');
    res.end();
  });
  const out = await call(s.url);
  ok('坏掉的 SSE 行被跳过,不影响后续', out.content === '仍然可用', `得到 "${out.content}"`);
  s.close();
}

{
  const s = await serve((_req, res) => {
    sse(res);
    res.write('data: {"error":{"message":"额度不足"}}\n\n');
    res.end();
  });
  const e = await callExpectingError(s.url);
  ok('流中间的错误对象被抛出', /额度不足/.test(e.message), e.message.slice(0, 60));
  s.close();
}

console.log('\nHTTP 错误码要说清原因');

const cases: [number, string, RegExp][] = [
  [401, '{"error":"invalid api key"}', /API Key 可能无效/],
  [403, '{"error":"forbidden"}', /认证失败/],
  [404, '{"error":"not found"}', /\/v1/],
  [429, '{"error":"rate limited"}', /限流/],
  [500, '{"error":"boom"}', /服务端错误/],
];

for (const [status, body, expected] of cases) {
  const s = await serve((_req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body);
  });
  const e = await callExpectingError(s.url);
  ok(
    `HTTP ${status} → 给出可照做的原因`,
    expected.test(e.message) && e instanceof LlmError && e.status === status,
    e.message.slice(0, 80),
  );
  s.close();
}

{
  const s = await serve((_req, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end('{"error":{"message":"tools is not supported by this model"}}');
  });
  const e = await callExpectingError(s.url, SAMPLE_TOOLS);
  ok('不支持 tool calling 时抛出专用错误(触发降级)', e.name === 'ToolUnsupportedError', e.name);
  s.close();
}

{
  // 反向用例:提到 function 但其实是参数问题 —— 不能被误判成「不支持工具」,
  // 否则一个本来正常的配置会被悄悄降级成文本模式
  const s = await serve((_req, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end('{"error":{"message":"invalid arguments for function plot2d"}}');
  });
  const e = await callExpectingError(s.url, SAMPLE_TOOLS);
  ok('工具参数类错误不被误判为「不支持工具」', e.name === 'LlmError', e.name);
  s.close();
}

{
  // 没传 tools 时,即使报文提到 tools 也不该走到降级分支
  const s = await serve((_req, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end('{"error":{"message":"tools is not supported by this model"}}');
  });
  const e = await callExpectingError(s.url);
  ok('没发 tools 时不做降级判断', e.name === 'LlmError', e.name);
  s.close();
}

console.log('\n空响应必须能定位原因 —— 诊断本身失效比报错更糟');

{
  // 推理模型把预算全烧在思维链上。接口是好的,这是最容易被误判成
  // "接口坏了 / 格式不兼容"的一种,所以诊断必须把人往正确的方向指。
  const s = await serve((_req, res) => {
    sse(res);
    for (let i = 0; i < 5; i++) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '让我想想这个问题…' } }] })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
  const e = await callExpectingError(s.url);
  ok(
    '思维链吃光预算 → 指向预算问题,并说明是接口本身没问题',
    /思维链/.test(e.message) && /接口本身是通的/.test(e.message),
    e.message.slice(0, 100),
  );
  ok('并且给出思维链字符数', /思维链长度：\d+ 字符/.test(e.message), e.message.slice(0, 160));
  // 改了设置没效果时,必须先能分清"设置没走到请求里"和"中转把它吃了"。
  // 这一行是唯一能区分两者的证据。
  ok('诊断里带出「实际发送」的参数', /实际发送：\{/.test(e.message), e.message.slice(0, 200));
  ok(
    '未设置 reasoning_effort 时,明确提示去设置里选一个',
    /没有 reasoning_effort/.test(e.message),
    e.message.slice(0, 300),
  );
  s.close();
}

{
  // delta 里是完全不认识的字段 —— 诊断要把原始报文吐出来,否则只能靠猜
  const s = await serve((_req, res) => {
    sse(res);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { 奇怪字段: '内容在这里' } }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
  const e = await callExpectingError(s.url);
  ok(
    '不认识的字段 → 诊断里带上原始报文',
    /原始报文样本/.test(e.message) && /奇怪字段/.test(e.message),
    e.message.slice(0, 160),
  );
  s.close();
}

{
  // content 字段存在但恒为空字符串 —— 中转没真正转发
  const s = await serve((_req, res) => {
    sse(res);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: '' } }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
  const e = await callExpectingError(s.url);
  ok('content 恒为空 → 指出是中转没转发', /没有真正转发/.test(e.message), e.message.slice(0, 140));
  s.close();
}

{
  // 正常响应里带推理字段时,思维链不能被混进正文
  const s = await serve((_req, res) => {
    sse(res);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '先想想…' } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '答案是 1' } }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
  const out = await call(s.url);
  ok('思维链不混进正文', out.content === '答案是 1', `得到 "${out.content}"`);
  ok('思维链长度仍被统计', out.diag.reasoningChars === 4, String(out.diag.reasoningChars));
  s.close();
}

console.log('\n思维链要和正文分开走');

{
  // 推理模型的典型形态:先长时间空推 content(或只推 reasoning_content),
  // 正文一个字都没有。界面必须能看出"它在动",同时正文不能被污染。
  const s = await serve((_req, res) => {
    sse(res);
    const parts = ['先看', '定义', '……'];
    for (const p of parts) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: p } }] })}\n\n`);
    }
    // 思考期间会有大量空的 content 分片,这是正常的,不能被当成内容
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '' } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '答案是 1' } }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });

  const reasoningDeltas: string[] = [];
  const textDeltas: string[] = [];
  const out = await chat({
    baseUrl: s.url,
    apiKey: 'sk-test',
    model: 'test',
    messages: [{ role: 'user', content: 'hi' }],
    onReasoning: (d) => reasoningDeltas.push(d),
    onText: (d) => textDeltas.push(d),
  });

  ok('思维链逐块交给 onReasoning', reasoningDeltas.join('') === '先看定义……', reasoningDeltas.join('|'));
  ok('空的 content 分片不进正文', textDeltas.join('') === '答案是 1', textDeltas.join('|'));
  ok('正文里不含思维链', out.content === '答案是 1', out.content);
  ok('思维链字数统计正确', out.diag.reasoningChars === 6, String(out.diag.reasoningChars));
  s.close();
}

{
  // reasoning 字段(OpenAI 系的叫法)也要认,不能只认 reasoning_content
  const s = await serve((_req, res) => {
    sse(res);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning: '想想' } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '好了' } }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
  const got: string[] = [];
  const out = await chat({
    baseUrl: s.url,
    apiKey: 'sk-test',
    model: 'test',
    messages: [{ role: 'user', content: 'hi' }],
    onReasoning: (d) => got.push(d),
  });
  ok('也认 reasoning 字段', got.join('') === '想想' && out.content === '好了', `${got.join('')} / ${out.content}`);
  s.close();
}

console.log('\nmax_tokens 的发送规则');

{
  const seen: string[] = [];
  const s = await serve((_req, res, body) => {
    seen.push(body);
    sse(res);
    res.write(frame({ content: '好' }));
    res.write('data: [DONE]\n\n');
    res.end();
  });

  await call(s.url, undefined, { maxTokens: 8192 });
  const withTokens = JSON.parse(seen[seen.length - 1]);
  ok('给了正数就发送 max_tokens', withTokens.max_tokens === 8192, JSON.stringify(withTokens.max_tokens));

  await call(s.url, undefined, { maxTokens: null });
  const nullTokens = JSON.parse(seen[seen.length - 1]);
  ok(
    'null 时完全不发送该字段',
    !('max_tokens' in nullTokens),
    JSON.stringify(Object.keys(nullTokens)),
  );

  await call(s.url, undefined, { maxTokens: 0 });
  const zeroTokens = JSON.parse(seen[seen.length - 1]);
  ok('0 也视为不发送(避免发一个服务商可能拒绝的值)', !('max_tokens' in zeroTokens));

  await call(s.url, undefined, { maxTokens: undefined });
  const undefTokens = JSON.parse(seen[seen.length - 1]);
  ok('undefined 时不发送', !('max_tokens' in undefTokens));

  s.close();
}

console.log('\n请求体的形状 —— 有几条是照服务商文档踩出来的');

{
  const seen: string[] = [];
  const s = await serve((_req, res, body) => {
    seen.push(body);
    sse(res);
    res.write(frame({ content: '好' }));
    res.write('data: [DONE]\n\n');
    res.end();
  });

  // DeepSeek 思考模式 + 工具调用时,tool_choice 会触发 400。
  // 而 'auto' 本来就是默认值,发了没有任何收益。
  await call(s.url, SAMPLE_TOOLS);
  const withTools = JSON.parse(seen[seen.length - 1]);
  ok('传了 tools 也不发 tool_choice', !('tool_choice' in withTools), JSON.stringify(Object.keys(withTools)));
  ok('tools 本身照常发送', Array.isArray(withTools.tools) && withTools.tools.length === 1);

  await call(s.url);
  const noTools = JSON.parse(seen[seen.length - 1]);
  ok('没传 tools 时不发该字段', !('tools' in noTools));

  s.close();
}

console.log('\nreasoning_effort 的发送规则');

{
  const seen: string[] = [];
  const s = await serve((_req, res, body) => {
    seen.push(body);
    sse(res);
    res.write(frame({ content: '好' }));
    res.write('data: [DONE]\n\n');
    res.end();
  });

  await call(s.url, undefined, { reasoningEffort: 'low' });
  ok('指定了就发送', JSON.parse(seen[seen.length - 1]).reasoning_effort === 'low');

  await call(s.url, undefined, { reasoningEffort: null });
  ok('null 时不发送(用服务商默认值,DeepSeek 是 high)', !('reasoning_effort' in JSON.parse(seen[seen.length - 1])));

  await call(s.url, undefined, { reasoningEffort: undefined });
  ok('undefined 时不发送', !('reasoning_effort' in JSON.parse(seen[seen.length - 1])));

  s.close();
}

console.log('\n用量要如实报出来 —— 字数只是估算,token 才是账');

{
  const s = await serve((_req, res) => {
    sse(res);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '想想想' } }] })}\n\n`);
    res.write(
      `data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: 'length' }],
        usage: { prompt_tokens: 1200, completion_tokens: 23000, total_tokens: 24200, completion_tokens_details: { reasoning_tokens: 22800 } },
      })}\n\n`,
    );
    res.write('data: [DONE]\n\n');
    res.end();
  });
  const e = await callExpectingError(s.url);
  ok('报告输入/输出/思维链三项 token', /输入 1200，输出 23000，其中思维链 22800/.test(e.message), e.message.slice(0, 400));
  ok('思维链占了绝大多数输出时,诊断指向思考强度', /reasoning_effort/.test(e.message));
  s.close();
}

{
  // 服务商不返回 usage 时要说明,而不是显示 undefined
  const s = await serve((_req, res) => {
    sse(res);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '想' } }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
  const e = await callExpectingError(s.url);
  ok('没有用量时明确说「未返回」', /服务商未返回用量/.test(e.message), e.message.slice(0, 300));
  s.close();
}

{
  // 实测里遇到过:中转报 reasoning_tokens: 0,但我们数出了 28800 字的思维链。
  // 显示「思维链 0」会和上一行直接打架,让人分不清哪项数据是错的。
  const s = await serve((_req, res) => {
    sse(res);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '想了很多很多' } }] })}\n\n`);
    res.write(
      `data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: 'length' }],
        usage: { prompt_tokens: 4705, completion_tokens: 8191, total_tokens: 12896, completion_tokens_details: { reasoning_tokens: 0 } },
      })}\n\n`,
    );
    res.write('data: [DONE]\n\n');
    res.end();
  });
  const e = await callExpectingError(s.url);
  ok('中转谎报思维链 0 时不显示该项,避免自相矛盾', /输入 4705，输出 8191\n/.test(e.message) && !/思维链 0/.test(e.message), e.message.slice(0, 400));
  ok('但输入输出仍然报出来(那个是可信的)', /输入 4705，输出 8191/.test(e.message));
  s.close();
}

console.log('\n请求形状自检 —— 把「对面的错」和「我们的错」分开');

{
  // 实测到的形态:一条工具结果找不到对应的工具调用。
  // 报错方是 500,措辞还是对方内部协议的术语,很容易被当成服务商抖动。
  const e = await callExpectingError('http://127.0.0.1:1/v1', undefined, {
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '好的' },
      { role: 'tool', tool_call_id: 'call_orphan', content: '结果' },
    ],
  });
  ok('孤立的工具结果在发出去之前就被拦下', /请求形状有误/.test(e.message), e.message.slice(0, 90));
  ok('并且明确说不是服务商的问题', /不是服务商的问题/.test(e.message) && /重试没有用/.test(e.message));
  ok('附上完整角色序列便于定位', /user → assistant → tool/.test(e.message), e.message.slice(0, 300));
}

{
  // 合法:一次调用两个工具,两条 tool 消息相连。
  // 只查「前一条是不是 assistant」的朴素写法会在这里误报。
  const s = await serve((_req, res) => {
    sse(res);
    res.write(frame({ content: '好' }));
    res.write('data: [DONE]\n\n');
    res.end();
  });
  const out = await chat({
    baseUrl: s.url,
    apiKey: 'sk-test',
    model: 'test',
    messages: [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'a', type: 'function', function: { name: 'plot2d', arguments: '{}' } },
          { id: 'b', type: 'function', function: { name: 'derive', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'a', content: '结果 A' },
      { role: 'tool', tool_call_id: 'b', content: '结果 B' },
    ],
  });
  ok('连续的多个工具结果不被误判', out.content === '好', out.content);
  s.close();
}

{
  // 500 里出现对方内部协议的术语时,不能再推给「服务商抖动」
  const s = await serve((_req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(
      '{"error":{"message":"unexpected `tool_use_id` found in `tool_result` blocks: call_x. ' +
        'Each `tool_result` block must have a corresponding `tool_use` block","type":"server_error"}}',
    );
  });
  const e = await callExpectingError(s.url);
  ok('500 + 工具协议术语 → 指向请求形状', /请求形状有问题/.test(e.message), e.message.slice(0, 120));
  ok('并且明确否定「重试」', /重试不会改变结果/.test(e.message));
  s.close();
}

{
  // 普通的 500 仍然应该说是服务商的问题
  const s = await serve((_req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end('{"error":"internal boom"}');
  });
  const e = await callExpectingError(s.url);
  ok('普通 500 仍归因为服务商', /服务端错误/.test(e.message) && /稍后重试/.test(e.message), e.message.slice(0, 90));
  s.close();
}

console.log('\nbaseUrl 归一化');

{
  const cases: [string, string][] = [
    ['https://api.deepseek.com/v1', 'https://api.deepseek.com/v1/chat/completions'],
    ['https://api.deepseek.com/v1/', 'https://api.deepseek.com/v1/chat/completions'],
    ['https://api.deepseek.com', 'https://api.deepseek.com/chat/completions'],
    ['http://localhost:11434/v1', 'http://localhost:11434/v1/chat/completions'],
    [
      'https://proxy.example.com/v1/chat/completions',
      'https://proxy.example.com/v1/chat/completions',
    ],
  ];
  let allOk = true;
  for (const [input, want] of cases) {
    const got = resolveEndpoint(input);
    if (got !== want) {
      allOk = false;
      console.log(`       "${input}" → "${got}",期望 "${want}"`);
    }
  }
  ok('各种形态的 baseUrl 都拼对', allOk);
}

console.log('\n工具调用 id 与请求序列');

{
  // 有些中转会给同一轮的多个调用发同一个 id。我们这边看不出来,
  // 但翻译成 Anthropic 格式时两个同 id 的 tool_use 会被直接拒绝,
  // 而且报错会说"tool_result 找不到对应的 tool_use",指向完全错误的方向。
  const s = await serve((_req, res) => {
    sse(res);
    res.write(frame({ tool_calls: [{ index: 0, id: 'dup', function: { name: 'plot2d', arguments: '{}' } }] }));
    res.write(frame({ tool_calls: [{ index: 1, id: 'dup', function: { name: 'derive', arguments: '{}' } }] }));
    res.write('data: [DONE]\n\n');
    res.end();
  });
  const out = await call(s.url, SAMPLE_TOOLS);
  const ids = out.toolCalls.map((t) => t.id);
  ok('重复的工具调用 id 被重编号', ids.length === 2 && ids[0] !== ids[1], JSON.stringify(ids));
  ok('重编号保留原 id 可读性', ids[0] === 'dup' && ids[1].startsWith('dup'), JSON.stringify(ids));
  s.close();
}

{
  // 缺 id 的调用也要补上,而且不能互相撞
  const s = await serve((_req, res) => {
    sse(res);
    res.write(frame({ tool_calls: [{ index: 0, function: { name: 'plot2d', arguments: '{}' } }] }));
    res.write(frame({ tool_calls: [{ index: 1, function: { name: 'derive', arguments: '{}' } }] }));
    res.write('data: [DONE]\n\n');
    res.end();
  });
  const out = await call(s.url, SAMPLE_TOOLS);
  const ids = out.toolCalls.map((t) => t.id);
  ok('缺 id 时补上且互不相同', ids.every(Boolean) && new Set(ids).size === ids.length, JSON.stringify(ids));
  s.close();
}

{
  // 形状类 500:光说"请求形状有问题"没用,得把真正的请求序列摆出来 ——
  // 否则只能反复猜"是不是漏传了 tool_use"、"是不是 id 对不上"
  const s = await serve((_req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end('{"error":{"message":"unexpected tool_use_id found in tool_result blocks"}}');
  });
  const e = await callExpectingError(s.url, SAMPLE_TOOLS, {
    messages: [
      { role: 'system', content: '很长很长的系统提示' },
      { role: 'user', content: '帮我画个图' },
      {
        role: 'assistant',
        content: '',
        reasoning_content: '想了一下',
        tool_calls: [{ id: 'a', type: 'function', function: { name: 'plot2d', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'a', content: '已绘制' },
    ],
  });
  ok('诊断里带出请求的消息序列', /我们发出去的消息序列/.test(e.message), e.message.slice(0, 160));
  ok('序列标出 tool_calls 和它的 id', /tool_calls=\[plot2d@a\]/.test(e.message), e.message.slice(0, 400));
  ok('序列标出工具结果的对应 id', /tool_call_id=a/.test(e.message), '');
  ok('空的 content 被显式标出(它是可疑点之一)', /content=""/.test(e.message), '');
  ok('思维链只报字数,不糊满屏幕', /reasoning=4字/.test(e.message), '');
  s.close();
}

console.log(`\n${pass} 通过, ${fail} 失败\n`);
// 显式退出:假服务器可能还留着句柄,不能让它们把进程吊住
process.exit(fail ? 1 : 0);
