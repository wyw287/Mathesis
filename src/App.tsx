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
  const contextTokens = useSession((s) => s.contextTokens);
  const hasArtifacts = useSession((s) => s.artifacts.length > 0);

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
  const clearCanvas = () => useSession.getState().clearCanvas();

  return (
    <div className="app">
      <header className="topbar">
        <h1>Mathesis</h1>
        <SessionMenu />
        {contextTokens !== null && (
          // 在此之前,学生完全不知道自己离模型的上下文上限还有多远 ——
          // 只能等撞上去那一刻看到一个报错。这一格就是把那件事提前摆出来。
          <span
            className="ctx-meter"
            title={
              '最近一次请求发出去的输入 token 数。会话越长它越大 ——\n' +
              '每一轮都会重发目前为止的全部对话,其中还包括模型的完整思维链。\n' +
              '撞到模型的上限时请求会直接被拒,那时点「清空对话」或开一个新会话。'
            }
          >
            上下文 {fmtTokens(contextTokens)}
          </span>
        )}
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
        <button
          className="ghost-btn"
          onClick={clearCanvas}
          // 画布本来就空的时候没什么可清的 —— 灰掉比点了没反应清楚
          disabled={busy || !hasArtifacts}
          title="把画布上的东西全删掉。对话不动。"
        >
          清空画布
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

/**
 * 12_300 → "12.3k"。
 *
 * 刻意只留一位小数:这个数要回答的是"我该换会话了吗",看出量级就够了,
 * 精确到个位反而更难读。
 */
function fmtTokens(n: number): string {
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`;
}
