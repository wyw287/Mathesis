import { useEffect, useRef, useState } from 'react';
import { useSession, type ChatMessage } from '../store/session';
import { Markdown } from '../renderers/Markdown';

const OPENERS = [
  '用 ε-δ 语言说明 sin(1/x) 在 0 处为什么没有极限，并画出它在 0 附近的图像',
  '给一个可导但导数不连续的例子，画出函数和它的导数对比',
  '为什么在度量空间里「序列紧」和「紧致」等价？把用到的选择公理标出来',
  '用滑块演示 a 变化时 y = x² + a·x 的顶点轨迹',
];

export function Chat() {
  const messages = useSession((s) => s.messages);
  const busy = useSession((s) => s.busy);
  const [text, setText] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  const submit = async (value: string) => {
    const v = value.trim();
    if (!v || busy) return;
    setText('');
    const { send, ensureSystemMessage } = await import('../llm/agent');
    ensureSystemMessage();
    abortRef.current = new AbortController();
    await send({ text: v, signal: abortRef.current.signal });
  };

  return (
    <div className="chat">
      <div className="messages" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="openers">
            <p className="hint">试试这些：</p>
            {OPENERS.map((o) => (
              <button key={o} className="opener" onClick={() => submit(o)}>
                {o}
              </button>
            ))}
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`msg msg-${m.role}`}>
            {m.reasoning && <ReasoningBlock message={m} busy={busy} />}
            {m.role === 'notice' ? (
              // 错误信息是我自己拼的,里面有排版用的换行和缩进 —— 按纯文本原样显示,
              // 不走 Markdown,免得内容里的符号被当成标记吃掉
              m.content
            ) : m.role === 'assistant' && m.content === '' && busy && !m.reasoning ? (
              // 已经有思维链时不再显示光标点 —— 上面的折叠块已经在证明它在动了
              <span className="typing">
                <i />
                <i />
                <i />
              </span>
            ) : (
              <Prose text={m.content} />
            )}
          </div>
        ))}
      </div>

      <StatusLine />

      <div className="composer">
        <textarea
          value={text}
          rows={2}
          placeholder="问点什么，或者让学生画一张图…（Enter 发送，Shift+Enter 换行）"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void submit(text);
            }
          }}
        />
        {busy ? (
          <button className="ghost-btn" onClick={() => abortRef.current?.abort()}>
            停止
          </button>
        ) : (
          <button className="primary-btn" onClick={() => void submit(text)} disabled={!text.trim()}>
            发送
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * 请求可能跑几十秒。没有这行状态,学生看到的只是界面没反应 —— 上次的「发了没回应」
 * 有一部分就是这个原因:分不清「在等」和「死了」。
 */
function StatusLine() {
  const status = useSession((s) => s.status);
  const [, tick] = useState(0);

  useEffect(() => {
    if (!status) return;
    const t = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [status]);

  if (!status) return null;
  const secs = Math.round((Date.now() - status.startedAt) / 1000);
  return (
    <div className="status-line">
      <span className="spinner" />
      <span>{status.phase}</span>
      {status.reasoningChars ? (
        <span className="status-chars">已 {status.reasoningChars.toLocaleString()} 字</span>
      ) : null}
      <span className="status-time">{secs}s</span>
      {secs >= 20 && <span className="hint">若一直停在这里，点「停止」再试</span>}
    </div>
  );
}

/**
 * 思维链折叠块。
 *
 * 默认收起不是客气 —— 一万多字的思考过程展开会把对话流完全淹没,而学生要的是
 * 画布和结论。但它也不该被丢掉:对数学教学来说,"老师是怎么想到这一步的"
 * 本身就是内容。
 */
function ReasoningBlock({ message, busy }: { message: ChatMessage; busy: boolean }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const hasContent = !!message.content;

  useEffect(() => {
    // 没有正文时,思维链就是这次唯一的产出。此时自动展开 ——
    // 否则学生看到的是一个错误提示加一个折着的块,什么都读不到。
    // 只在结束时动手一次,之后用户自己折起来不会被覆盖。
    if (ref.current && !busy && !hasContent) ref.current.open = true;
  }, [busy, hasContent]);

  return (
    <details className="reasoning" ref={ref}>
      <summary>
        思维过程 · {message.reasoning!.length.toLocaleString()} 字
        {busy && !hasContent && <span className="reasoning-live"> · 思考中…</span>}
      </summary>
      <div className="reasoning-body">{message.reasoning}</div>
    </details>
  );
}

function Prose({ text }: { text: string }) {
  return <Markdown source={text} />;
}
