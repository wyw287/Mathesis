import { useEffect, useRef, useState } from 'react';
import { useSession } from '../store/session';
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
            {m.role === 'notice' ? (
              // 错误信息是我自己拼的,里面有排版用的换行和缩进 —— 按纯文本原样显示,
              // 不走 Markdown,免得内容里的符号被当成标记吃掉
              m.content
            ) : m.role === 'assistant' && m.content === '' && busy ? (
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
      <span className="status-time">{secs}s</span>
      {secs >= 20 && <span className="hint">若一直停在这里，点「停止」再试</span>}
    </div>
  );
}

function Prose({ text }: { text: string }) {
  return <Markdown source={text} />;
}
