/**
 * OpenAI 兼容的 chat completions 客户端。
 *
 * 之所以只走 OpenAI 兼容协议:产品形态是 BYOK(用户自填 apiKey + baseUrl),
 * 目标用户可能接 DeepSeek、Kimi、GLM、本地 Ollama,或各种第三方中转。
 *
 * 这里有一半代码是错误处理。原因是这类客户端最难的不是发请求,而是**请求失败时
 * 用户看到什么** —— 一个只写「请求失败」的客户端会让人无从下手,因为可能的
 * 原因横跨 URL 拼错、CORS、Key 无效、中转不支持工具、流挂死五种。
 */

/** 多久没收到任何数据就判定为挂死。reasoning 模型首 token 可能很慢,给足时间。 */
const STALL_MS = 60_000;

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

export class ToolUnsupportedError extends Error {
  constructor(body: string) {
    super(`该接口似乎不支持 tool calling：${body.slice(0, 300)}`);
    this.name = 'ToolUnsupportedError';
  }
}

export interface ToolCall {
  id: string;
  name: string;
  argsRaw: string;
}

export interface ChatDiag {
  endpoint: string;
  status: number | null;
  contentType: string;
  sseEvents: number;
  bytes: number;
  elapsedMs: number;
}

export interface ChatOutcome {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
  diag: ChatDiag;
}

export interface ChatOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: unknown[];
  tools?: unknown[];
  signal?: AbortSignal;
  onText?: (delta: string) => void;
  onPhase?: (phase: string) => void;
}

/**
 * 用户粘贴的 baseUrl 形态很杂:可能是 https://api.deepseek.com,
 * 可能带 /v1,也可能直接把完整的 /chat/completions 粘进来。统一处理。
 */
export function resolveEndpoint(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  if (!base) throw new LlmError('设置里的 API Base URL 是空的。');
  if (/\/chat\/completions$/.test(base)) return base;
  return `${base}/chat/completions`;
}

/**
 * 判断这条错误是不是在说「我不支持工具调用」。
 *
 * 这个判断必须严格:误判的代价是把一个本来正常的配置悄悄降级成文本模式,
 * 用户会以为是自己环境有问题。所以要求**同时**出现工具相关词和否定词,
 * 光有 "tool" 不算 —— 否则一条 "invalid arguments for function plot2d"
 * 也会被当成不支持工具。
 */
const TOOLISH = /\b(tools?|function[_ ]?calls?)\b/i;
const NEGATIVE =
  /not\s+support|unsupported|does\s+not\s+support|unknown\s+(field|parameter|argument|property)|unrecognized|not\s+available|no\s+such/i;

function looksLikeToolUnsupported(status: number, body: string): boolean {
  if (status !== 400 && status !== 404 && status !== 422 && status !== 500) return false;
  return TOOLISH.test(body) && NEGATIVE.test(body);
}

/** 把 HTTP 状态码翻译成用户能照着做的动作。 */
function explainStatus(status: number, endpoint: string, body: string): string {
  const tail = body ? `\n\n接口返回：${body.slice(0, 400)}` : '';
  switch (status) {
    case 401:
    case 403:
      return `认证失败（HTTP ${status}）。API Key 可能无效、过期,或者这个 Key 没有该模型的权限。${tail}`;
    case 404:
      return (
        `接口不存在（HTTP 404）：${endpoint}\n\n` +
        '最常见的原因是 baseUrl 路径不对。检查一下：\n' +
        '· OpenAI / DeepSeek 等通常要在末尾带上 /v1\n' +
        '· 有些中转给的是完整地址,那就整条粘进来(结尾 /chat/completions 不会再重复拼)\n' +
        '· 本地 Ollama 是 http://localhost:11434/v1' +
        tail
      );
    case 429:
      return `被限流了（HTTP 429）。稍等一下再试,或者换个 Key。${tail}`;
    case 400:
      return (
        `请求被拒绝（HTTP 400）。常见原因：模型名写错、或者该模型不支持 tool calling。${tail}`
      );
    case 500:
    case 502:
    case 503:
    case 504:
      return `服务端错误（HTTP ${status}），通常是服务商那边的问题,可以稍后重试。${tail}`;
    default:
      return `请求失败（HTTP ${status}）${tail}`;
  }
}

export async function chat(opts: ChatOptions): Promise<ChatOutcome> {
  const started = Date.now();
  const endpoint = resolveEndpoint(opts.baseUrl);

  const diag: ChatDiag = {
    endpoint,
    status: null,
    contentType: '',
    sseEvents: 0,
    bytes: 0,
    elapsedMs: 0,
  };

  const payload: Record<string, unknown> = { model: opts.model, messages: opts.messages, stream: true };
  if (opts.tools && opts.tools.length) {
    payload.tools = opts.tools;
    payload.tool_choice = 'auto';
  }

  opts.onPhase?.(`正在请求 ${hostOf(endpoint)}`);

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.apiKey}` },
      body: JSON.stringify(payload),
      signal: opts.signal,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    // fetch 抛 TypeError 时拿不到状态码,浏览器也不会告诉你是不是 CORS ——
    // 只能把三种可能一起列出来让用户自己排查
    throw new LlmError(
      `无法连接 ${endpoint}\n\n原始错误：${(e as Error).message || '(空)'}\n\n` +
        '可能的原因：\n' +
        '① baseUrl 拼错了,或者服务商需要带 /v1\n' +
        '② 该服务商不允许从浏览器直接调用（CORS）。这种情况要么换一个支持的中转,\n' +
        '   要么自己在本地跑一个代理。浏览器控制台（F12）里会有一条 CORS 相关的红色报错,\n' +
        '   如果有,就基本可以确定是这一条。\n' +
        '③ 网络不通,或者本地服务没启动（比如 Ollama）。',
    );
  }

  diag.status = res.status;
  diag.contentType = res.headers.get('content-type') ?? '';

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (opts.tools?.length && looksLikeToolUnsupported(res.status, body)) {
      throw new ToolUnsupportedError(body);
    }
    throw new LlmError(explainStatus(res.status, endpoint, body), res.status, body);
  }

  opts.onPhase?.('已连接,等待模型输出');

  let outcome: ChatOutcome;
  if (diag.contentType.includes('application/json')) {
    // 有些中转无视 stream 参数,直接返回整体 JSON
    let json: unknown;
    try {
      json = await res.json();
    } catch (e) {
      throw new LlmError(`接口返回的 JSON 无法解析：${(e as Error).message}`);
    }
    outcome = { ...fromNonStreaming(json), diag };
  } else {
    const { content, toolCalls, finishReason, sseEvents, bytes, truncated } = await fromStreaming(
      res,
      opts.onText,
      opts.signal,
    );
    diag.sseEvents = sseEvents;
    diag.bytes = bytes;
    outcome = { content, toolCalls, finishReason, diag };

    if (truncated) {
      throw new LlmError(
        `${STALL_MS / 1000} 秒内没有收到任何新数据,已中断。\n\n` +
          `期间收到 ${sseEvents} 个数据事件、${bytes} 字节。\n` +
          (sseEvents === 0
            ? '一个事件都没收到,说明请求发出去了但对面没有开始回应 —— 可能是模型名写错、' +
              '余额不足,或者这个中转不真正支持流式（试着在设置里关掉后重试）。'
            : '收到了一部分就停了,可能是服务商超时。'),
        undefined,
        undefined,
      );
    }
  }

  diag.elapsedMs = Date.now() - started;

  if (!outcome.content && !outcome.toolCalls.length) {
    throw new LlmError(explainEmpty(outcome));
  }

  return outcome;
}

function explainEmpty(o: ChatOutcome): string {
  const d = o.diag;
  return (
    '模型返回了空响应（既没有文字也没有工具调用）。\n\n' +
    `· 接口：${d.endpoint}\n` +
    `· HTTP ${d.status}，Content-Type: ${d.contentType || '(空)'}\n` +
    `· 收到 ${d.sseEvents} 个数据事件、${d.bytes} 字节\n` +
    `· finish_reason: ${o.finishReason ?? '(无)'}\n\n` +
    (d.sseEvents === 0
      ? '一个数据事件都没有 —— 接口返回了 200,但 body 是空的或不认识的格式。'
      : '有数据事件但没解析出内容 —— 可能是这个接口的响应格式不是 OpenAI 兼容的。')
  );
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

function fromNonStreaming(json: any): Omit<ChatOutcome, 'diag'> {
  const choice = json?.choices?.[0];
  const msg = choice?.message ?? {};
  const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((tc: any, i: number) => ({
    id: tc.id ?? `call_${i}`,
    name: tc.function?.name ?? '',
    argsRaw: tc.function?.arguments ?? '{}',
  }));
  if (json?.error) throw new LlmError(json.error.message ?? JSON.stringify(json.error).slice(0, 300));
  return {
    content: typeof msg.content === 'string' ? msg.content : '',
    toolCalls,
    finishReason: choice?.finish_reason ?? null,
  };
}

interface StreamResult {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
  sseEvents: number;
  bytes: number;
  /** 因为长时间收不到数据而被中断 */
  truncated: boolean;
}

async function fromStreaming(
  res: Response,
  onText?: (d: string) => void,
  signal?: AbortSignal,
): Promise<StreamResult> {
  const reader = res.body?.getReader();
  if (!reader) {
    throw new LlmError('响应没有 body。可能是浏览器或中间代理把流吃掉了。');
  }

  const decoder = new TextDecoder();
  let buf = '';
  let content = '';
  let finishReason: string | null = null;
  let sseEvents = 0;
  let bytes = 0;
  let sawDone = false;
  let truncated = false;
  // tool_calls 的参数是跨 chunk 分片传的,必须按 index 累积再整体 JSON.parse
  const acc = new Map<number, ToolCall>();

  const handleLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(':')) return; // 注释行 / keep-alive
    if (!trimmed.startsWith('data:')) return;
    const data = trimmed.slice(5).trim();
    // [DONE] 是**终止信号**,不是可忽略的心跳。以前这里漏了处理,
    // 遇到发完 [DONE] 仍然保持长连接的接口就会永远等下去。
    if (data === '[DONE]') {
      sawDone = true;
      return;
    }
    if (!data) return;

    let json: any;
    try {
      json = JSON.parse(data);
    } catch {
      return; // 半截 JSON / 非 SSE 噪声
    }
    sseEvents++;
    if (json.error) throw new LlmError(json.error.message ?? '上游返回错误', undefined, data);

    const choice = json.choices?.[0];
    if (!choice) return;

    // 有的接口把整体响应塞进一个 data 事件,用 message 而不是 delta
    if (choice.message && !choice.delta) {
      const m = choice.message;
      if (typeof m.content === 'string' && m.content) {
        content += m.content;
        onText?.(m.content);
      }
      for (const tc of m.tool_calls ?? []) {
        acc.set(acc.size, {
          id: tc.id ?? `call_${acc.size}`,
          name: tc.function?.name ?? '',
          argsRaw: tc.function?.arguments ?? '{}',
        });
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
      return;
    }

    const delta = choice.delta ?? {};
    if (typeof delta.content === 'string' && delta.content) {
      content += delta.content;
      onText?.(delta.content);
    }
    for (const tc of delta.tool_calls ?? []) {
      const idx: number = typeof tc.index === 'number' ? tc.index : 0;
      const cur = acc.get(idx) ?? { id: '', name: '', argsRaw: '' };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name += tc.function.name;
      if (tc.function?.arguments) cur.argsRaw += tc.function.arguments;
      acc.set(idx, cur);
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  };

  const consume = (text: string, final: boolean) => {
    buf += text;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      handleLine(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
    if (final && buf) handleLine(buf);
  };

  for (;;) {
    if (sawDone) break;
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });

    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await withStallTimeout(reader, STALL_MS);
    } catch (e) {
      if ((e as Error).name === 'StallError') {
        truncated = !sawDone;
        await reader.cancel().catch(() => {});
        break;
      }
      throw e;
    }

    if (chunk.done) {
      if (buf) consume('', true);
      break;
    }
    if (chunk.value) {
      bytes += chunk.value.byteLength;
      consume(decoder.decode(chunk.value, { stream: true }), false);
    }
  }

  // 收到 [DONE] 就主动把流关掉。不关的话这条连接会一直挂着 ——
  // 在浏览器里表现为一个永不结束的请求,DevTools 里能看到它一直处于 pending。
  await reader.cancel().catch(() => {});

  const toolCalls = [...acc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v)
    .filter((tc) => tc.name);
  for (const tc of toolCalls) if (!tc.id) tc.id = `call_${Math.random().toString(36).slice(2)}`;

  // 累积到了工具调用但函数名始终没来 —— 这是接口兼容性问题,值得单独说清楚
  if (!toolCalls.length && acc.size > 0) {
    throw new LlmError(
      `接口发来了 ${acc.size} 个工具调用,但都没有函数名。\n` +
        '这通常说明该中转对 tool calling 的实现不兼容。可以在设置里关掉「使用工具调用」再试。',
    );
  }

  return { content, toolCalls, finishReason, sseEvents, bytes, truncated };
}

class StallError extends Error {
  constructor() {
    super('stall');
    this.name = 'StallError';
  }
}

function withStallTimeout<T>(reader: ReadableStreamDefaultReader<T>, ms: number): Promise<ReadableStreamReadResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    reader.read(),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new StallError()), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * 设置页的「测试连接」:只发一个最小请求,把失败原因原样带回来。
 * 有这个按钮,用户就不用靠反复发消息来猜问题了。
 */
export async function testConnection(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
}): Promise<{ ok: true; endpoint: string; elapsedMs: number; sample: string } | { ok: false; endpoint: string; reason: string }> {
  let endpoint = '';
  const started = Date.now();
  try {
    endpoint = resolveEndpoint(opts.baseUrl);
  } catch (e) {
    return { ok: false, endpoint: '(无效)', reason: (e as Error).message };
  }
  try {
    const out = await chat({
      ...opts,
      messages: [{ role: 'user', content: '回复两个字：可以' }],
    });
    return {
      ok: true,
      endpoint,
      elapsedMs: Date.now() - started,
      sample: out.content.slice(0, 60) || '(空)',
    };
  } catch (e) {
    return { ok: false, endpoint, reason: e instanceof Error ? e.message : String(e) };
  }
}
