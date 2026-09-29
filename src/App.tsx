import { useEffect, useState } from 'react';
import { Canvas } from './components/Canvas';
import { Chat } from './components/Chat';
import { SessionMenu } from './components/SessionMenu';
import { Settings } from './components/Settings';
import { reconcileArtifacts } from './kinds/registry';
import { useSession, type SessionData } from './store/session';

export function App() {
  const [showSettings, setShowSettings] = useState(false);
  const configured = useSession((s) => !!s.settings.apiKey.trim());
  const hydrated = useSession((s) => s.hydrated);
  const busy = useSession((s) => s.busy);
  const storageTier = useSession((s) => s.storageTier);

  /**
   * 把载入的数据对齐到当前这份代码:跑 schema 迁移 + 重算标题。
   *
   * 两件事让它必须在 UI 侧、且必须在**水合之后**:
   *   · 它要认识所有 kind,而渲染器依赖 store —— 放进 store 会形成
   *     store → 注册表 → kind 模块 → store 的环。
   *   · 存储是异步的,首帧根本没有数据。之前这个 effect 依赖 `[]` 只在挂载时
   *     跑一次,异步水合之后它早就跑完了 —— 结果是**永远不会重算**,标题
   *     会一直停在旧值上。
   *
   * **所有会话都要过一遍**,不只是当前那个:迁移导入的会话、以及每个非当前
   * 会话的画布,否则它们的标题永远不重算。
   */
  useEffect(() => {
    if (!hydrated) return;
    const { sessions, artifacts } = useSession.getState();

    let changed = false;
    const nextSessions: Record<string, SessionData> = {};
    for (const [id, sess] of Object.entries(sessions)) {
      const fixed = reconcileArtifacts(sess.artifacts);
      if (fixed !== sess.artifacts) changed = true;
      nextSessions[id] = fixed === sess.artifacts ? sess : { ...sess, artifacts: fixed };
    }
    // 活工作集也要一起对齐(水合时它与当前会话的记录是同一个引用,但别依赖这点)
    const flat = reconcileArtifacts(artifacts);
    if (flat !== artifacts) changed = true;

    if (!changed) return;
    useSession.setState({ sessions: nextSessions, artifacts: flat });
  }, [hydrated]);

  // 水合完成前不渲染主界面:此时 store 里还是初始的空会话,
  // 渲染出来会闪一下"没有会话",而且任何交互都会被随后的 merge 覆盖掉。
  if (!hydrated) {
    return <div className="boot">载入中…</div>;
  }

  const clearChat = () => useSession.getState().clearConversation();

  return (
    <div className="app">
      <header className="topbar">
        <h1>Mathesis</h1>
        <SessionMenu />
        {storageTier === 'memory' && (
          // 说清楚,而不是默默降级 —— 用户以为在被保存、结果丢了一整段学习记录,
          // 是比"存不了"严重得多的失败。
          <span className="storage-warn" title="IndexedDB 不可用(可能开了无痕模式,或被别的标签页占住)">
            存储不可用,本次内容不会被保存
          </span>
        )}
        <div className="spacer" />
        <button className="ghost-btn" onClick={clearChat} disabled={busy}>
          清空对话
        </button>
        <button className={configured ? 'ghost-btn' : 'primary-btn'} onClick={() => setShowSettings(true)}>
          {configured ? '设置' : '先填 API Key'}
        </button>
      </header>

      <main className="layout">
        <section className="pane pane-chat">
          <Chat />
        </section>
        <section className="pane pane-canvas">
          <Canvas />
        </section>
      </main>

      {showSettings && <Settings onClose={() => setShowSettings(false)} />}
    </div>
  );
}
