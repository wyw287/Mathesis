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

async function call(url: string, tools?: unknown[]) {
  return chat({
    baseUrl: url,
    apiKey: 'sk-test',
    model: 'test',
    messages: [{ role: 'user', content: 'hi' }],
    tools,
  });
}

async function callExpectingError(url: string, tools?: unknown[]): Promise<Error> {
  try {
    await call(url, tools);
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

console.log(`\n${pass} 通过, ${fail} 失败\n`);
// 显式退出:假服务器可能还留着句柄,不能让它们把进程吊住
process.exit(fail ? 1 : 0);
