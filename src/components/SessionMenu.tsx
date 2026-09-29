import { useEffect, useRef, useState } from 'react';
import { useSession } from '../store/session';
import type { SessionData } from '../store/session';

/**
 * 会话切换器。顶部栏下拉,不动现有两栏布局。
 *
 * **`busy` 时整个禁用。** 这不只是体验取舍:agent 的写入按「当前活跃会话」落点,
 * 请求跑一半切走的话,后续的工具产出和消息会全部写进另一个会话。
 * 禁用切换让「当前活跃会话」在请求期间恒定,那个 bug 就不可能发生。
 *
 * 代价是推理模型思考的几十秒里不能切 —— 可接受,`busy` 期间本来也只有一个
 * 「停止」按钮可点。
 */
export function SessionMenu() {
  const sessions = useSession((s) => s.sessions);
  const activeId = useSession((s) => s.activeSessionId);
  const busy = useSession((s) => s.busy);

  const [open, setOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  // 生成开始就收起来 —— 否则会留下一个点不动的浮层
  useEffect(() => {
    if (busy) setOpen(false);
  }, [busy]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const active = sessions[activeId] as SessionData | undefined;
  const list = Object.values(sessions)
    .filter((s) => showArchived || !s.archived)
    // 最近动过的排前面。updatedAt 在切换时会刷新,所以也是"最近用过"的顺序。
    .sort((a, b) => b.updatedAt - a.updatedAt);

  const store = () => useSession.getState();

  const pick = (id: string) => {
    store().switchSession(id);
    setOpen(false);
  };

  const startRename = (s: SessionData) => {
    setEditingId(s.id);
    setDraft(s.title);
  };

  const commitRename = () => {
    if (editingId) store().renameSession(editingId, draft);
    setEditingId(null);
  };

  const remove = (s: SessionData) => {
    const others = Object.values(sessions).filter((x) => x.id !== s.id).length;
    const note =
      others === 0
        ? '\n\n这是最后一个会话,删掉之后会自动新建一个空的。'
        : '\n\n里面的对话和画布会一起消失,无法恢复。';
    if (!window.confirm(`删除会话「${s.title}」?${note}`)) return;
    store().deleteSession(s.id);
  };

  return (
    <div className="session-menu" ref={rootRef}>
      <button
        className="session-trigger"
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        title={busy ? '正在生成,结束后才能切换会话' : '切换会话'}
      >
        <span className="session-trigger-name">{active?.title ?? '会话'}</span>
        <span className="session-caret">▾</span>
      </button>

      {open && (
        <div className="session-pop">
          <div className="session-list">
            {list.map((s) => (
              <div key={s.id} className={s.id === activeId ? 'session-item on' : 'session-item'}>
                {editingId === s.id ? (
                  <input
                    className="session-rename"
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename();
                      if (e.key === 'Escape') setEditingId(null);
                    }}
                  />
                ) : (
                  <button className="session-pick" onClick={() => pick(s.id)}>
                    <span className="session-item-title">{s.title}</span>
                    {s.archived && <span className="session-badge">已归档</span>}
                  </button>
                )}

                <span className="session-actions">
                  <button onClick={() => startRename(s)} title="重命名">
                    ✎
                  </button>
                  <button
                    onClick={() => (s.archived ? store().unarchiveSession(s.id) : store().archiveSession(s.id))}
                    title={s.archived ? '取消归档' : '归档(内容保留,从列表收起)'}
                  >
                    {s.archived ? '↩' : '⤓'}
                  </button>
                  <button onClick={() => remove(s)} title="删除">
                    ✕
                  </button>
                </span>
              </div>
            ))}
            {!list.length && <div className="session-empty">没有会话</div>}
          </div>

          <div className="session-foot">
            <button
              onClick={() => {
                store().newSession();
                setOpen(false);
              }}
            >
              + 新建会话
            </button>
            <button onClick={() => setShowArchived((v) => !v)}>
              {showArchived ? '隐藏已归档' : '显示已归档'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
