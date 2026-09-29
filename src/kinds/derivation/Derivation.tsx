import { useEffect, useState } from 'react';
import { verifyStep, type Verdict, type VerifyStatus } from '../../lib/cas';
import type { CanvasEvent, DerivationSpec, DerivationStep, GapKind, StepCheck } from '../../types/artifact';
import { Latex } from '../../renderers/Latex';
import { Markdown, MathBlock } from '../../renderers/Markdown';

interface Props {
  spec: DerivationSpec;
  artifactId: string;
  /** 内容被改过就重新校对 —— 结果不能跟着旧的一步留在屏幕上 */
  rev: number;
  emit: (e: CanvasEvent) => void;
}

/**
 * gap → 徽章。这是整个渲染器里最重要的部分:
 * 学生自学时最大的困难不是看不懂某一步,而是看不出哪一步重要、哪一步是被跳过的。
 */
const GAP_META: Record<GapKind, { label: string; hint: string; cls: string }> = {
  technical: { label: '技术性', hint: '套定义或代数变形,略过不影响理解', cls: 'gap-technical' },
  substantive: { label: '关键', hint: '证明在这里干活,值得停下来看', cls: 'gap-substantive' },
  unjustified: { label: '未证明', hint: '这一步被省略或没有证明,不要默认它成立', cls: 'gap-unjustified' },
  assumption: { label: '假设', hint: '这一步引入了一个假设', cls: 'gap-assumption' },
};

/**
 * 核对结果 → 徽章。
 *
 * `~` 表示"CAS 化简不出来" —— 和"错了"是**两回事**。实测发现 nerdamer 认不出
 * `sin(2x) = 2sin(x)cos(x)`,那一步是对的。混为一谈会冤枉正确的步骤,
 * 而冤枉比漏报伤害大得多。
 */
const VERIFY_META: Record<VerifyStatus, { mark: string; label: string; cls: string }> = {
  confirmed: { mark: '✓', label: '已核对', cls: 'vf-confirmed' },
  differs: { mark: '✗', label: '与上一步不等', cls: 'vf-differs' },
  unconfirmed: { mark: '~', label: '化简不出来', cls: 'vf-unconfirmed' },
  unavailable: { mark: '–', label: '没法核对', cls: 'vf-unavailable' },
};

/** 这一步该和哪一步比。省略 against 就是比上一步 —— 但上一步可能是文字性的。 */
function resolveAgainst(steps: DerivationStep[], index: number, check: StepCheck): string | null {
  if (check.against) {
    return steps.find((s) => s.id === check.against)?.check?.expr ?? null;
  }
  return steps[index - 1]?.check?.expr ?? null;
}

export function Derivation({ spec, artifactId, rev, emit }: Props) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [shown, setShown] = useState(spec.collapsed ? 2 : spec.steps.length);
  const [verdicts, setVerdicts] = useState<Record<string, Verdict>>({});
  const [checking, setChecking] = useState(false);

  /**
   * 逐条核对。
   *
   * 一步步来、每步之间让出一帧:一次典型核对是几毫秒,但病态表达式能到几百毫秒
   * (实测),整条推导一次算完会把界面冻住。
   */
  useEffect(() => {
    if (!spec.steps.some((s) => s.check)) {
      setVerdicts({});
      return;
    }
    let cancelled = false;
    const out: Record<string, Verdict> = {};
    setVerdicts({});
    setChecking(true);

    void (async () => {
      for (let i = 0; i < spec.steps.length; i++) {
        const step = spec.steps[i];
        if (!step.check) continue;

        const against = resolveAgainst(spec.steps, i, step.check);
        let verdict: Verdict;
        if (against === null) {
          verdict = {
            status: 'unavailable',
            note: step.check.against
              ? `要比较的那一步（${step.check.against}）没有提供可核对的式子`
              : '上一步是文字性的,没有可核对的式子 —— 用 against 指明和哪一步比',
          };
        } else {
          try {
            verdict = await verifyStep({
              expr: step.check.expr,
              against,
              relation: step.check.relation,
              vars: step.check.vars,
            });
          } catch (e) {
            verdict = { status: 'unavailable', note: `核对时出错：${(e as Error).message}` };
          }
        }

        if (cancelled) return;
        out[step.id] = verdict;
        setVerdicts({ ...out });
        // 让出一帧,否则整条推导会一次性阻塞主线程
        await new Promise((r) => setTimeout(r, 0));
      }
      if (!cancelled) setChecking(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [spec, rev]);

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

      {checking && <div className="derive-checking">正在逐条核对…</div>}

      <ol className="derive-steps">
        {visible.map((s, i) => {
          const gap = s.gap ? GAP_META[s.gap] : null;
          const verdict = verdicts[s.id];
          const flagged = verdict?.status === 'differs';
          return (
            <li key={s.id} className={`step ${gap?.cls ?? ''} ${flagged ? 'step-flagged' : ''}`}>
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
                {verdict && <VerifyBadge verdict={verdict} />}
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

function VerifyBadge({ verdict }: { verdict: Verdict }) {
  const meta = VERIFY_META[verdict.status];
  return (
    <span className={`verify-badge ${meta.cls}`} title={verdict.note}>
      {meta.mark} {meta.label}
    </span>
  );
}
