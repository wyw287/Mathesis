import { useEffect, useState } from 'react';
import { Canvas } from './components/Canvas';
import { Chat } from './components/Chat';
import { Settings } from './components/Settings';
import { reconcileArtifacts } from './kinds/registry';
import { useSession } from './store/session';

export function App() {
  const [showSettings, setShowSettings] = useState(false);
  const configured = useSession((s) => !!s.settings.apiKey.trim());

  /**
   * 把从 localStorage 载入的数据对齐到当前这份代码:跑 schema 迁移 + 重算标题。
   *
   * 这件事必须在 UI 侧做,不能在 store 的 persist merge 里 —— 它要认识所有 kind,
   * 而渲染器又依赖 store,放进 store 会形成
   * store → 注册表 → kind 模块 → store 的环。
   *
   * 代价是首帧会闪一下旧标题,可忽略;换来的是 store 不需要认识任何 kind。
   */
  useEffect(() => {
    const { artifacts } = useSession.getState();
    const fixed = reconcileArtifacts(artifacts);
    if (fixed !== artifacts) useSession.setState({ artifacts: fixed });
  }, []);

  const clearChat = () => {
    // 只清对话,不清画布 —— 画布上的东西是持久对象,不是对话的附属品
    useSession.setState({ messages: [], apiHistory: [], pendingEvents: [] });
  };

  return (
    <div className="app">
      <header className="topbar">
        <h1>Mathesis</h1>
        <span className="sub">对话驱动的数学画布</span>
        <div className="spacer" />
        <button className="ghost-btn" onClick={clearChat}>
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
