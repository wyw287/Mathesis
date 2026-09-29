import { useState } from 'react';
import { useSession } from '../store/session';

interface Props {
  onClose: () => void;
}

const PRESETS = [
  { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { label: 'Moonshot', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { label: '本地 Ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:14b' },
];

export function Settings({ onClose }: Props) {
  const settings = useSession((s) => s.settings);
  const setSettings = useSession((s) => s.setSettings);
  const [draft, setDraft] = useState(settings);
  const [testing, setTesting] = useState(false);
  const [probe, setProbe] = useState<{ ok: boolean; text: string } | null>(null);

  const save = () => {
    setSettings({
      ...draft,
      baseUrl: draft.baseUrl.trim().replace(/\/+$/, ''),
      apiKey: draft.apiKey.trim(),
      model: draft.model.trim(),
    });
    onClose();
  };

  /**
   * 单发一个最小请求,把失败原因原样带回来。
   * 有这颗按钮,就不用靠反复发消息去猜是 URL 错了、Key 错了还是 CORS 拦了。
   */
  const test = async () => {
    setTesting(true);
    setProbe(null);
    try {
      const { testConnection } = await import('../llm/client');
      const r = await testConnection({
        baseUrl: draft.baseUrl.trim(),
        apiKey: draft.apiKey.trim(),
        model: draft.model.trim(),
      });
      setProbe(
        r.ok
          ? { ok: true, text: `✓ 连接成功（${r.elapsedMs}ms）\n接口：${r.endpoint}\n模型回复：${r.sample}` }
          : { ok: false, text: `✗ 失败\n接口：${r.endpoint}\n\n${r.reason}` },
      );
    } catch (e) {
      setProbe({ ok: false, text: `✗ 测试本身出错：${(e as Error).message}` });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>设置</h2>

        <div className="presets">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              className={draft.baseUrl === p.baseUrl ? 'chip on' : 'chip'}
              onClick={() => setDraft({ ...draft, baseUrl: p.baseUrl, model: p.model })}
            >
              {p.label}
            </button>
          ))}
        </div>

        <label className="field">
          <span>API Base URL</span>
          <input
            value={draft.baseUrl}
            onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
            placeholder="https://api.deepseek.com/v1"
            spellCheck={false}
          />
          <small>
            走 OpenAI 兼容协议。如果服务商要求带 <code>/v1</code>，请写进这里；结尾的{' '}
            <code>/chat/completions</code> 会自动补上。
          </small>
        </label>

        <label className="field">
          <span>API Key</span>
          <input
            type="password"
            value={draft.apiKey}
            onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
            placeholder="sk-…"
            spellCheck={false}
          />
        </label>

        <label className="field">
          <span>模型</span>
          <input
            value={draft.model}
            onChange={(e) => setDraft({ ...draft, model: e.target.value })}
            placeholder="deepseek-chat"
            spellCheck={false}
          />
        </label>

        <label className="field row">
          <input
            type="checkbox"
            checked={draft.toolsEnabled}
            onChange={(e) => setDraft({ ...draft, toolsEnabled: e.target.checked })}
          />
          <span>使用工具调用 (tool calling)</span>
        </label>
        <small className="field-note">
          关掉后会切换到「模型输出带标记的文本块」模式。画布功能仍然可用，
          但生成的可视化内容可靠性会下降。接口不支持工具调用时会自动切换到这里。
        </small>

        <p className="warn">
          API Key 只存在这台浏览器的 localStorage 里，不会上传到任何服务器。
          但这也意味着：不要在公用电脑上填。
        </p>

        <div className="modal-actions">
          <button className="ghost-btn" onClick={onClose}>
            取消
          </button>
          <button className="ghost-btn" onClick={() => void test()} disabled={testing || !draft.apiKey.trim() || !draft.baseUrl.trim()}>
            {testing ? '测试中…' : '测试连接'}
          </button>
          <button className="primary-btn" onClick={save}>
            保存
          </button>
        </div>

        {probe && (
          <pre className={probe.ok ? 'probe ok' : 'probe bad'}>
            {probe.text}
          </pre>
        )}
      </div>
    </div>
  );
}
