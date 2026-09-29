import { useState } from 'react';
import type { CanvasEvent, DerivationSpec, GapKind } from '../../types/artifact';
import { Latex } from '../../renderers/Latex';
import { Markdown, MathBlock } from '../../renderers/Markdown';

interface Props {
  spec: DerivationSpec;
  artifactId: string;
  emit: (e: CanvasEvent) => void;
}

/**
 * gap → 徽章。这是整个渲染器里最重要的部分:
 * 学生自学时最大的困难不是看不懂某一步,而是看不出哪一步重要、哪一步是被跳过的。
 * 把这些用颜色和标签显式标出来,是通用讲题助手做不到的事。
 */
const GAP_META: Record<GapKind, { label: string; hint: string; cls: string }> = {
  technical: { label: '技术性', hint: '套定义或代数变形,略过不影响理解', cls: 'gap-technical' },
  substantive: { label: '关键', hint: '证明在这里干活,值得停下来看', cls: 'gap-substantive' },
  unjustified: { label: '未证明', hint: '这一步被省略或没有证明,不要默认它成立', cls: 'gap-unjustified' },
  assumption: { label: '假设', hint: '这一步引入了一个假设', cls: 'gap-assumption' },
};

export function Derivation({ spec, artifactId, emit }: Props) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [shown, setShown] = useState(spec.collapsed ? 2 : spec.steps.length);

  const toggle = (id: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
        emit({ type: 'stepExpand', artifactId, stepId: id });
      }
      return next;
    });
  };

  const visible = spec.steps.slice(0, shown);

  return (
    <div className="derivation">
      {spec.statement && (
        <div className="derive-statement">
          <MathBlock tex={spec.statement} />
        </div>
      )}
      {spec.given && spec.given.length > 0 && (
        <ul className="derive-given">
          {spec.given.map((g, i) => (
            <li key={i}>
              <MathBlock tex={g} />
            </li>
          ))}
        </ul>
      )}

      <ol className="derive-steps">
        {visible.map((s, i) => {
          const gap = s.gap ? GAP_META[s.gap] : null;
          return (
            <li key={s.id} className={`step ${gap?.cls ?? ''}`}>
              <div className="step-head">
                <span className="step-no">{i + 1}</span>
                <div className="step-body">
                  <Latex tex={s.latex} display />
                </div>
              </div>

              <div className="step-meta">
                <span className="step-reason">{s.reason}</span>
                {gap && (
                  <span className={`gap-badge ${gap.cls}`} title={gap.hint}>
                    {gap.label}
                  </span>
                )}
                {s.from && s.from.length > 0 && <span className="step-from">← {s.from.join(', ')}</span>}
              </div>

              <div className="step-actions">
                {s.detail && (
                  <button className="link-btn" onClick={() => toggle(s.id)}>
                    {open.has(s.id) ? '收起' : '展开说明'}
                  </button>
                )}
                {/* 学生的求救信号。这是唯一一个必须立刻触发模型调用的事件。 */}
                <button className="link-btn ask" onClick={() => emit({ type: 'stepConfused', artifactId, stepId: s.id })}>
                  这步不懂
                </button>
              </div>

              {open.has(s.id) && s.detail && (
                <div className="step-detail">
                  <Markdown source={s.detail} />
                </div>
              )}
            </li>
          );
        })}
      </ol>

      {shown < spec.steps.length && (
        <button className="ghost-btn" onClick={() => setShown(spec.steps.length)}>
          展开剩余 {spec.steps.length - shown} 步
        </button>
      )}
    </div>
  );
}
