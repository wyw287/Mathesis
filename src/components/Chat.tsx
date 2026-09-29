import { useEffect, useRef, useState } from 'react';
import { useSession, type ChatMessage, type MessageImage } from '../store/session';
import { Markdown } from '../renderers/Markdown';
import { deleteImages, getDataUrl, putImage } from '../lib/blob-store';
import { MAX_IMAGES, prepareImage } from '../lib/image';

const OPENERS = [
  '用 ε-δ 语言说明 sin(1/x) 在 0 处为什么没有极限，并画出它在 0 附近的图像',
  '给一个可导但导数不连续的例子，画出函数和它的导数对比',
  '为什么在度量空间里「序列紧」和「紧致」等价？把用到的选择公理标出来',
  '用滑块演示 a 变化时 y = x² + a·x 的顶点轨迹',
];

/** 输入框里待发送的一张图。`dataUrl` 只用来画缩略图 —— 像素已经进库了。 */
interface Attachment {
  meta: MessageImage;
  dataUrl: string;
}

export function Chat() {
  const messages = useSession((s) => s.messages);
  const busy = useSession((s) => s.busy);
  const visionOn = useSession((s) => s.settings.visionEnabled);
  const activeSessionId = useSession((s) => s.activeSessionId);
  const [text, setText] = useState('');
  const [images, setImages] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  useEffect(() => {
    // 切会话把草稿丢掉,否则上一道题的截图会被带进新会话。
    //
    // 刻意**不在这里删掉那些像素**:学生可能只是切过去看一眼就切回来。
    // 它们变成孤儿,由下次载入时的全量扫描收走 —— 那本来就是那条兜底存在的原因。
    setImages([]);
    setNotice(null);
  }, [activeSessionId]);

  /**
   * 收下一批文件。
   *
   * 先 `putImage` 再进 state:反过来的话,渲染时会有一个瞬间去查一张还没存进去的图。
   * 中途失败(格式不支持、太大、存不下)只把消息显示出来,不静默吞掉。
   */
  const addFiles = async (files: File[]) => {
    // 这是单次交互(粘贴/拖拽/选择)里的快照,足够准:三种入口不会同时发生
    const room = MAX_IMAGES - images.length;
    if (room <= 0) {
      setNotice(`一条消息最多带 ${MAX_IMAGES} 张图。`);
      return;
    }
    if (files.length > room) setNotice(`一条消息最多带 ${MAX_IMAGES} 张图,多余的没有加进来。`);

    for (const f of files.slice(0, room)) {
      try {
        const p = await prepareImage(f);
        await putImage(p.id, p.dataUrl);
        const meta: MessageImage = { id: p.id, w: p.w, h: p.h, mime: p.mime, bytes: p.bytes };
        setImages((prev) => [...prev, { meta, dataUrl: p.dataUrl }]);
      } catch (e) {
        setNotice((e as Error).message);
      }
    }
  };

  const removeImage = (id: string) => {
    setImages((prev) => prev.filter((a) => a.meta.id !== id));
    // 还没发出去,这份像素此刻没人引用 —— 直接删掉,不用等下次载入的全量扫描
    void deleteImages([id]);
  };

  const submit = async (value: string) => {
    const v = value.trim();
    const attached = images;
    // 只发图不打字是合法的,所以不能只看文字
    if ((!v && !attached.length) || busy) return;
    setText('');
    setImages([]);
    setNotice(null);
    const { send } = await import('../llm/agent');
    abortRef.current = new AbortController();
    await send({
      text: v,
      images: attached.map((a) => a.meta),
      signal: abortRef.current.signal,
    });
  };

  const pickFiles = (list: FileList | null) => {
    if (list?.length) void addFiles([...list]);
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
            {m.images && m.images.length > 0 && <MessageImages images={m.images} />}
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

      <div
        className={dragging ? 'composer drag' : 'composer'}
        onDragOver={(e) => {
          // 只认文件。选中一段文字往里拖不该让整个输入框亮起来。
          if (!e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault(); // 不拦的话浏览器会直接打开这个文件,页面就没了
          setDragging(false);
          pickFiles(e.dataTransfer.files);
        }}
      >
        {images.length > 0 && (
          <div className="composer-images">
            {images.map((a) => (
              <div className="image-chip" key={a.meta.id}>
                <img src={a.dataUrl} alt="待发送的图片" />
                <button className="image-remove" title="移除" onClick={() => removeImage(a.meta.id)}>
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
        {images.length > 0 && !visionOn && (
          // 不说的话学生会以为模型看见了
          <div className="composer-hint">
            图片会存在本地。当前没有开启「当前模型支持图片输入」，发送时只会告诉模型它看不到。
          </div>
        )}
        {notice && <div className="composer-hint">{notice}</div>}

        <div className="composer-row">
          <textarea
            value={text}
            rows={2}
            placeholder="问点什么，或者把题目截图粘进来…（Enter 发送，Shift+Enter 换行）"
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => {
              const files = [...e.clipboardData.items]
                .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
                .map((it) => it.getAsFile())
                .filter((f): f is File => f !== null);
              // **只有真吃到图才拦。** 无条件 preventDefault 会把正常粘贴文字也打断。
              if (!files.length) return;
              e.preventDefault();
              void addFiles(files);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void submit(text);
              }
            }}
          />
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              const list = e.target.files;
              // 先清空:同一个文件选第二次也要能再次触发 change
              pickFiles(list);
              e.target.value = '';
            }}
          />
          <button
            className="ghost-btn attach-btn"
            title="添加图片（也可以直接粘贴或拖进来）"
            onClick={() => fileRef.current?.click()}
          >
            ▦
          </button>
          {busy ? (
            <button className="ghost-btn" onClick={() => abortRef.current?.abort()}>
              停止
            </button>
          ) : (
            <button
              className="primary-btn"
              onClick={() => void submit(text)}
              disabled={!text.trim() && !images.length}
            >
              发送
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** 消息里的图片。像素从 blob 库里异步取 —— 它不在消息里,只存了一个 id。 */
function MessageImages({ images }: { images: MessageImage[] }) {
  return (
    <div className="msg-images">
      {images.map((im) => (
        <StoredImage key={im.id} id={im.id} w={im.w} h={im.h} />
      ))}
    </div>
  );
}

function StoredImage({ id, w, h }: { id: string; w: number; h: number }) {
  const [url, setUrl] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void getDataUrl(id).then((u) => {
      if (!cancelled) setUrl(u);
    });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (url === undefined) return null;
  // 读不到要**说出来**。留白的话学生会以为是自己看漏了,而实际上图真的没了。
  if (url === null) return <span className="msg-image-lost">图片已丢失（{w}×{h}）</span>;
  return <img className="msg-image" src={url} alt="学生附的图片" />;
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
