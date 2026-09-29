import { useState } from 'react';
import type { Settings as SettingsShape } from '../store/session';
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
        maxTokens: draft.maxTokens,
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

        <label className="field">
          <span>思考强度 (reasoning_effort)</span>
          <select
            value={draft.reasoningEffort ?? ''}
            onChange={(e) =>
              setDraft({ ...draft, reasoningEffort: (e.target.value || null) as SettingsShape['reasoningEffort'] })
            }
          >
            <option value="">不发送（用服务商默认值）</option>
            <option value="low">low — 少想一点</option>
            <option value="high">high — 默认档</option>
            <option value="max">max — 尽力</option>
          </select>
          <small>
            只对推理模型有效。DeepSeek 的思考模式<strong>默认就是 high</strong>,
            所以留空等于 high。
            <br />
            如果遇到「思考很久然后被截断、正文一个字都没有」,调到 <code>low</code>{' '}
            往往比调大输出上限更有效——问题不是空间不够,是想得太久。
            <br />
            各家取值不一样（OpenAI 还有 none / minimal / xhigh),所以这里只给通用的三档。
          </small>
        </label>

        <label className="field">
          <span>输出上限 (max_tokens)</span>
          <input
            type="number"
            min={0}
            step={1024}
            value={draft.maxTokens ?? ''}
            onChange={(e) => {
              const v = e.target.value.trim();
              setDraft({ ...draft, maxTokens: v === '' ? null : Math.max(0, Number(v)) });
            }}
            placeholder="留空 = 用服务商默认值"
          />
          <small>
            <strong>建议留空。</strong>留空就不发送这个字段,由服务商用自己的默认值。
            <br />
            注意一个反直觉的机制:很多服务商的推理模型让<strong>思维链和正文共享</strong>
            这一份预算,而思维链动辄写掉几万 token。所以<strong>填一个偏小的值比不填更糟</strong>
            ——它会把思考一起掐断,表现为回复一片空白。
            <br />
            只有出现"回答说到一半被截断"时才需要填,常见值 32768 / 65536。
          </small>
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

        <label className="field row">
          <input
            type="checkbox"
            checked={draft.visionEnabled}
            onChange={(e) => setDraft({ ...draft, visionEnabled: e.target.checked })}
          />
          <span>当前模型支持图片输入</span>
        </label>
        <small className="field-note">
          <strong>默认关。</strong>关着的时候粘贴的截图仍然会存到本地、也能在对话里回看，
          只是<strong>不发给模型</strong> —— 发送时会明确告诉它「你看不到这张图」，
          免得它对着「这道题怎么做」硬答，或者假装自己看见了。
          <br />
          需要视觉模型（gpt-4o、qwen-vl 之类）。DeepSeek 的 chat / reasoner 不吃图片，
          多数第三方中转也不支持，所以默认关是安全的。
        </small>

        <p className="warn">
          API Key 只存在这台浏览器里（本地数据库，明文），不会上传到任何服务器。
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
