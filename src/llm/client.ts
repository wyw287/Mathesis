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
    /**
     * 机器可读的错误类别。
     *
     * 给 agent 循环判断"这个失败值不值得重试"用的。靠 message 匹配太脆 ——
     * 文案会改,而重试策略不该跟着文案一起坏。
     */
    readonly code?: 'empty_response' | 'bad_request_shape',
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

/**
 * 发出去之前先检查消息序列的形状。
 *
 * 起因是一条实测到的 HTTP 500:
 *
 *   unexpected `tool_use_id` found in `tool_result` blocks: call_xx.
 *   Each `tool_result` block must have a corresponding `tool_use` block
 *   in the previous message.
 *
 * 两个陷阱叠在一起:报错措辞是**对方内部协议的术语**(`tool_use` / `tool_result`
 * 是 Anthropic 的叫法,不是 OpenAI 的),而外壳是 500 —— 于是诊断会把人引向
 * "服务商抖动,稍后重试",而真实原因是**我们的历史里有一条工具结果找不到
 * 对应的工具调用**,重试多少次都一样。
 *
 * 自己先查一遍,能把"对方的错"和"我们的错"当场分开。
 */
function assertMessageShape(messages: unknown[]): void {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] as any;
    if (m?.role !== 'tool') continue;

    // 往前找最近的一条非 tool 消息。不能只看 i-1 —— 一次回复里调用两个工具时,
    // 合法的序列是 assistant(tool_calls:[a,b]) → tool(a) → tool(b),
    // 第二个工具结果的前一条就是 tool。只查相邻会把正常情况判成错误。
    let j = i - 1;
    while (j >= 0 && (messages[j] as any)?.role === 'tool') j--;
    const prev = messages[j] as any;

    const ids = new Set<string>((prev?.tool_calls ?? []).map((tc: any) => tc?.id));
    if (prev?.role !== 'assistant' || !ids.has(m.tool_call_id)) {
      throw new LlmError(
        `请求形状有误:第 ${i} 条是工具结果(tool_call_id=${m.tool_call_id}),` +
          `但它前面找不到包含这个调用的 assistant 消息。\n\n` +
          `这是客户端的问题,不是服务商的问题 —— 重试没有用。\n` +
          `完整历史:${messages.map((x: any) => x?.role).join(' → ')}`,
        undefined,
        undefined,
        'bad_request_shape',
      );
    }
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

/** 服务商报的 token 用量。比字数精确得多 —— 字数只能估,这个能直接对账。 */
export interface TokenUsage {
  prompt?: number;
  completion?: number;
  reasoning?: number;
  total?: number;
}

export interface ChatDiag {
  endpoint: string;
  status: number | null;
  contentType: string;
  sseEvents: number;
  bytes: number;
  elapsedMs: number;
  /** 前几条原始 data 行。判断"是不是 OpenAI 兼容格式"时,这是唯一的实证。 */
  sample: string[];
  /** 所有 delta 里出现过的字段名。取到空内容时,先看这里缺了什么。 */
  fields: string[];
  /** 思维链字段的字符数。R1 类模型会把整个预算烧在这里,正文一个字都不剩。 */
  reasoningChars: number;
  /**
   * 实际发出去的参数。
   *
   * 有了它才能回答"我在设置里改了,到底生效没有" —— 尤其是中转可能
   * **静默丢弃**它不认识的参数(DeepSeek 对不认识的参数就是静默忽略)。
   * 没有这一项,改了没效果时完全无从判断是设置没生效还是参数无效。
   */
  sent: Record<string, unknown>;
  usage: TokenUsage | null;
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
  /** 输出上限。null / 省略 = 不发送该字段,由服务商决定默认值。 */
  maxTokens?: number | null;
  /** 思考强度。null / 省略 = 不发送,由服务商决定(DeepSeek 默认 high)。 */
  reasoningEffort?: string | null;
  signal?: AbortSignal;
  onText?: (delta: string) => void;
  /** 推理模型的思维链增量。和正文分开走,不混进 onText。 */
  onReasoning?: (delta: string) => void;
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

/**
 * 把请求的消息序列压成几行。
 *
 * 形状类报错时**这是唯一能定位的证据**。错误信息说"需要看原始报文",但指的是
 * 响应体;而被怀疑的恰恰是**请求**。没有这个,就只能反复猜"是不是漏传了
 * tool_use"、"是不是 id 对不上"。
 *
 * 只摘结构,不摘正文 —— 要判断的是形状,不是内容。
 */
export function describeMessages(messages: unknown[]): string {
  return messages
    .map((raw, i) => {
      const m = (raw ?? {}) as Record<string, any>;
      const bits: string[] = [];
      const content = m.content;
      if (typeof content === 'string') {
        bits.push(content ? `content="${content.slice(0, 30)}…"` : `content=""(空)`);
      } else if (Array.isArray(content)) {
        bits.push(`content=[${content.length} 块]`);
      }
      if (Array.isArray(m.tool_calls)) {
        bits.push(
          `tool_calls=[${m.tool_calls.map((t: any) => `${t?.function?.name}@${t?.id ?? '无id'}`).join(', ')}]`,
        );
      }
      if (m.tool_call_id) bits.push(`tool_call_id=${m.tool_call_id}`);
      if (typeof m.reasoning_content === 'string' && m.reasoning_content) {
        bits.push(`reasoning=${m.reasoning_content.length}字`);
      }
      return `  [${i}] ${m.role ?? '?'} ${bits.join(' ')}`;
    })
    .join('\n');
}

/** 把 HTTP 状态码翻译成用户能照着做的动作。 */
function explainStatus(
  status: number,
  endpoint: string,
  body: string,
  messages: unknown[] = [],
): string {
  const tail = body ? `\n\n接口返回：${body.slice(0, 400)}` : '';

  // 有些 5xx 其实是**我们的请求形状不合规**,对方只是用服务器错误的壳把话带回来。
  // 报错措辞还常常是对方内部协议的术语(不同协议对工具调用的叫法不一样),
  // 照着字面理解会以为是服务商抖动,然后一直重试 —— 那是错的。
  if (status >= 500 && /tool_use|tool_result|tool_call/i.test(body)) {
    return (
      `请求格式被服务端拒绝（HTTP ${status}）。\n\n` +
      '注意:虽然状态码是服务器错误,但这段话描述的是**我们发出去的请求形状有问题** —— ' +
      '重试不会改变结果。\n' +
      '报错里用的是服务商内部协议的术语(各家对工具调用的叫法不同),' +
      '说明它在把 OpenAI 格式翻译成自己的格式时对不上号。\n\n' +
      `我们发出去的消息序列(共 ${messages.length} 条)：\n` +
      (messages.length ? describeMessages(messages) : '  (未提供)') +
      tail
    );
  }

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

  // 形状不对就别发出去了 —— 对面只会用 500 和一个别人的术语把问题带回来。
  assertMessageShape(opts.messages);

  const diag: ChatDiag = {
    endpoint,
    status: null,
    contentType: '',
    sseEvents: 0,
    bytes: 0,
    elapsedMs: 0,
    sample: [],
    fields: [],
    reasoningChars: 0,
    sent: {},
    usage: null,
  };

  const payload: Record<string, unknown> = { model: opts.model, messages: opts.messages, stream: true };
  if (opts.tools && opts.tools.length) {
    // 刻意不发 tool_choice。'auto' 本来就是默认值,发了没有任何收益,
    // 但 DeepSeek 思考模式 + 工具调用时会因为它返回 400(见其思考模式文档)。
    payload.tools = opts.tools;
  }
  // 只有明确给了正数才发送。留空就完全不提这个字段,
  // 让服务商用自己的默认值 —— 发一个它不接受的值会被直接 400 拒绝。
  if (typeof opts.maxTokens === 'number' && opts.maxTokens > 0) {
    payload.max_tokens = opts.maxTokens;
  }
  // 同上,只有明确指定才发送。各家取值集合不一样,发错会被拒。
  if (opts.reasoningEffort) {
    payload.reasoning_effort = opts.reasoningEffort;
  }

  // 记录实际发出去的东西。"设置改了没效果"是这个产品最容易卡住的一类问题,
  // 而它只有两种成因:设置没走到这里,或者中转把它吃了。这一项能区分两者。
  diag.sent = {
    model: opts.model,
    stream: true,
    tools: opts.tools?.length ?? 0,
    ...(payload.max_tokens !== undefined ? { max_tokens: payload.max_tokens } : {}),
    ...(payload.reasoning_effort !== undefined ? { reasoning_effort: payload.reasoning_effort } : {}),
  };

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
    throw new LlmError(explainStatus(res.status, endpoint, body, opts.messages), res.status, body);
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
    const stream = await fromStreaming(res, opts.onText, opts.signal, opts.onReasoning);
    diag.sseEvents = stream.sseEvents;
    diag.bytes = stream.bytes;
    diag.sample = stream.sample;
    diag.fields = stream.fields;
    diag.reasoningChars = stream.reasoningChars;
    diag.usage = stream.usage;
    outcome = {
      content: stream.content,
      toolCalls: stream.toolCalls,
      finishReason: stream.finishReason,
      diag,
    };

    if (stream.truncated) {
      throw new LlmError(
        `${STALL_MS / 1000} 秒内没有收到任何新数据,已中断。\n\n` +
          `期间收到 ${stream.sseEvents} 个数据事件、${stream.bytes} 字节。\n` +
          (stream.sseEvents === 0
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
    throw new LlmError(explainEmpty(outcome), undefined, undefined, 'empty_response');
  }

  return outcome;
}

function usageLine(u: TokenUsage | null, reasoningChars: number): string {
  if (!u || (u.completion === undefined && u.reasoning === undefined)) return '· 服务商未返回用量\n';
  const parts: string[] = [];
  if (u.prompt !== undefined) parts.push(`输入 ${u.prompt}`);
  if (u.completion !== undefined) parts.push(`输出 ${u.completion}`);
  // 有些中转不报 reasoning_tokens,永远是 0。而此时我们已经数出了几万字的思维链 ——
  // 显示 "思维链 0" 会和上面那行直接打架,让人怀疑哪一项是错的。宁可不显示。
  if (u.reasoning !== undefined && !(u.reasoning === 0 && reasoningChars > 0)) {
    parts.push(`其中思维链 ${u.reasoning}`);
  }
  return `· 实际用量：${parts.join('，')}\n`;
}

function explainEmpty(o: ChatOutcome): string {
  const d = o.diag;
  const head =
    '模型返回了空响应（既没有文字也没有工具调用）。\n\n' +
    `· 接口：${d.endpoint}\n` +
    `· HTTP ${d.status}，Content-Type: ${d.contentType || '(空)'}\n` +
    `· 实际发送：${JSON.stringify(d.sent)}\n` +
    `· 收到 ${d.sseEvents} 个数据事件、${d.bytes} 字节\n` +
    `· delta 里出现过的字段：${d.fields.length ? d.fields.join(', ') : '(一个都没有)'}\n` +
    `· 思维链长度：${d.reasoningChars} 字符\n` +
    usageLine(d.usage, d.reasoningChars) +
    `· finish_reason: ${o.finishReason ?? '(无)'}\n\n`;

  // 最容易被误判成"接口坏了"的一种:推理模型把预算全烧在思维链上。
  // 接口其实是好的,是预算和思考强度的问题 —— 诊断必须说清楚,否则会让人去查错方向。
  if (d.reasoningChars > 0) {
    const effort = d.sent.reasoning_effort;
    return (
      head +
      `接口本身是通的 —— 模型确实在输出,只是全花在思维链上了(${d.reasoningChars} 字),\n` +
      '还没开始写正文/调工具就用完了预算。\n\n' +
      (effort
        ? `你已经设了 reasoning_effort=${effort} 并成功发出去。如果字数没有明显下降,\n` +
          '说明中转没有把它转发给模型(DeepSeek 对不认识的参数是静默忽略,不报错)。\n\n'
        : '注意上面「实际发送」里没有 reasoning_effort —— 去设置里选一个再试。\n\n') +
      '可以试的方向：\n' +
      '· 换一个**窄**的问题。宽泛的"详细解释一下 X"会让它长篇规划;\n' +
      '  "画个 y = sin(1/x) 看看 x→0" 这种一次工具调用就能完成,思考量小得多。\n' +
      '· 设置里把思考强度调到 low。\n' +
      '· 把输出上限留空(不发送),让服务商用它的默认值。'
    );
  }
  if (d.sseEvents === 0) {
    return head + '一个数据事件都没有 —— 接口返回了 200,但 body 是空的或不认识的格式。';
  }
  if (!d.fields.length) {
    return head + '事件里没有 choices[0].delta 字段 —— 响应格式不是 OpenAI 兼容的。';
  }
  if (d.fields.includes('content')) {
    return head + 'delta 里有 content 字段,但收到的全是空字符串 —— 中转很可能没有真正转发模型的输出。';
  }
  return head + `事件里有 delta,但没有 content 字段。原始报文样本：\n\n${d.sample.join('\n')}`;
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
  sample: string[];
  fields: string[];
  reasoningChars: number;
  usage: TokenUsage | null;
}

/** 各家的 usage 字段名不完全一致,能取到多少取多少。 */
function extractUsage(u: any): TokenUsage {
  if (!u || typeof u !== 'object') return {};
  const details = u.completion_tokens_details ?? u.output_tokens_details ?? {};
  return {
    prompt: u.prompt_tokens ?? u.input_tokens,
    completion: u.completion_tokens ?? u.output_tokens,
    reasoning: details.reasoning_tokens ?? u.reasoning_tokens,
    total: u.total_tokens,
  };
}

async function fromStreaming(
  res: Response,
  onText?: (d: string) => void,
  signal?: AbortSignal,
  onReasoning?: (d: string) => void,
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
  // 思维链单独累计,不混进正文 —— 但要计数,因为"烧光预算在思考上"是一种
  // 真实且会表现为"模型什么都没说"的失败
  let reasoningChars = 0;
  /** delta 里出现过的字段名。取到空内容时,这是第一个该看的地方。 */
  const fields = new Set<string>();
  /** 前几条原始 data 行,用来实证"是不是 OpenAI 兼容格式" */
  const sample: string[] = [];
  /** 服务商报的用量。通常在最后一个 chunk 里,也可能一直都没有。 */
  let usage: TokenUsage | null = null;
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
    if (sample.length < 4) sample.push(data.length > 500 ? `${data.slice(0, 500)}…` : data);
    if (json.usage) usage = extractUsage(json.usage);
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
      const reasoning =
        typeof m.reasoning_content === 'string'
          ? m.reasoning_content
          : typeof m.reasoning === 'string'
            ? m.reasoning
            : '';
      if (reasoning) {
        reasoningChars += reasoning.length;
        onReasoning?.(reasoning);
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
    for (const k of Object.keys(delta)) fields.add(k);
    if (typeof delta.content === 'string' && delta.content) {
      content += delta.content;
      onText?.(delta.content);
    }
    // 推理模型(DeepSeek-R1 / flash、QwQ、GLM 这类)把思维链放在单独的字段里。
    // 不混进正文 —— 这个产品的主体是画布,几万字思维链糊进对话只会淹没它。
    // 但必须交出去,而且要计数:烧光输出预算在思考上,表面看就是"模型什么都没说"。
    const chunk =
      typeof delta.reasoning_content === 'string'
        ? delta.reasoning_content
        : typeof delta.reasoning === 'string'
          ? delta.reasoning
          : '';
    if (chunk) {
      reasoningChars += chunk.length;
      onReasoning?.(chunk);
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

  /**
   * 保证每个工具调用有**唯一**的 id。
   *
   * 有些中转会给同一轮的多个调用发同一个 id(或者干脆不发)。这在我们这边看不出来,
   * 但翻译成 Anthropic 格式时,两个同 id 的 `tool_use` 会被直接拒绝 ——
   * 而且报错说的是"tool_result 找不到对应的 tool_use",指向完全错误的方向。
   *
   * 重编号是安全的:assistant 的 tool_calls 和随后的 tool 结果用的是同一个值。
   */
  const usedIds = new Set<string>();
  for (const [index, tc] of toolCalls.entries()) {
    let id = tc.id || `call_${index}`;
    if (usedIds.has(id)) {
      let n = 1;
      while (usedIds.has(`${id}_${n}`)) n++;
      id = `${id}_${n}`;
    }
    tc.id = id;
    usedIds.add(id);
  }

  // 累积到了工具调用但函数名始终没来 —— 这是接口兼容性问题,值得单独说清楚
  if (!toolCalls.length && acc.size > 0) {
    throw new LlmError(
      `接口发来了 ${acc.size} 个工具调用,但都没有函数名。\n` +
        '这通常说明该中转对 tool calling 的实现不兼容。可以在设置里关掉「使用工具调用」再试。',
    );
  }

  return {
    content,
    toolCalls,
    finishReason,
    sseEvents,
    bytes,
    truncated,
    sample,
    fields: [...fields],
    reasoningChars,
    usage,
  };
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
  maxTokens?: number | null;
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
