import { useState } from 'react';
import { Canvas } from './components/Canvas';
import { Chat } from './components/Chat';
import { Settings } from './components/Settings';
import { useSession } from './store/session';

export function App() {
  const [showSettings, setShowSettings] = useState(false);
  const configured = useSession((s) => !!s.settings.apiKey.trim());

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
