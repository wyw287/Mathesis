import { useMemo } from 'react';
import { Latex } from '../../renderers/Latex';
import { Markdown } from '../../renderers/Markdown';
import type { CanvasEvent, CounterexampleCheck, CounterexampleSpec } from '../../types/artifact';
import { Plot2D } from '../plot2d/Plot2D';
import { evaluateAll, type CheckOutcome } from './checks';

interface Props {
  spec: CounterexampleSpec;
  /** 当前参数值。滑块一动它就会变,检查项跟着重算。 */
  scope: Record<string, number>;
  artifactId: string;
  rev: number;
  onParam: (name: string, value: number) => void;
  emit: (e: CanvasEvent) => void;
}

/**
 * 三种状态用**三个不同的符号**,不是一个对勾一个叉。
 *
 * `~` 表示"模型声称成立但系统验不了"。它必须和 `✓` 看起来不一样 ——
 * 混在一起就等于给学生一个假的确定性,那比不做检查更糟。
 */
const MARK: Record<CheckOutcome['status'], string> = {
  pass: '✓',
  fail: '✗',
  asserted: '~',
};

export function Counterexample({ spec, scope, artifactId, rev, onParam, emit }: Props) {
  const { hypotheses, conclusion, verdict } = useMemo(() => evaluateAll(spec, scope), [spec, scope]);

  const confirm = () =>
    emit({
      type: 'answer',
      artifactId,
      response: { text: `我找到了反例:${spec.found ?? '当前这组参数'}` },
    });

  return (
    <div className="ce">
      <div className="ce-claim">
        <span className="ce-claim-tag">待反驳</span>
        <Label text={spec.claim} />
      </div>

      {/* 候选对象就是一张普通的 plot2d —— 参数、曲线、缩放全都复用 */}
      <Plot2D
        spec={spec.plot}
        scope={scope}
        artifactId={artifactId}
        rev={rev}
        emit={emit}
        onParam={onParam}
      />

      <div className="ce-checks">
        <div className="ce-group">前提(反例必须都满足)</div>
        {spec.hypotheses.map((c, i) => (
          <CheckRow key={c.id} check={c} outcome={hypotheses[i]} />
        ))}
        <div className="ce-group">结论不成立</div>
        <CheckRow check={spec.conclusion} outcome={conclusion} />
      </div>

      <div className={verdict.found ? 'ce-verdict found' : 'ce-verdict'}>
        {verdict.found ? (
          <>
            <div className="ce-verdict-main">
              <strong>反例成立。</strong>
              <Label text={spec.found ?? '当前这组参数下,前提全部满足而结论不成立。'} />
            </div>
            {verdict.assertedCount > 0 && (
              // 说清楚哪些没验证过。学生要能自己判断这个反例有多可靠。
              <div className="ce-caveat">
                其中 {verdict.assertedCount} 条是模型声称的,系统没法验证 ——
                它们在上面的标记是 ~ 而不是 ✓。
              </div>
            )}
            <button className="primary-btn ce-confirm" onClick={confirm}>
              就它了
            </button>
          </>
        ) : (
          <div className="ce-verdict-main">
            {!verdict.hypothesesOk ? (
              <span>还有前提没满足。</span>
            ) : (
              <span>前提都满足了,但结论仍然成立 —— 换个参数试试。</span>
            )}
            <span className="hint">拖动下面的滑块找。</span>
          </div>
        )}
      </div>
    </div>
  );
}

function CheckRow({ check, outcome }: { check: CounterexampleCheck; outcome: CheckOutcome }) {
  return (
    <div className={`ce-check ${outcome.status}`}>
      <span className="ce-mark">{MARK[outcome.status]}</span>
      <span className="ce-label">
        <Label text={check.label} />
      </span>
      <span className="ce-detail">{outcome.detail}</span>
    </div>
  );
}

/**
 * 标签里可能是散文夹公式(带 `$`),也可能整句就是 LaTeX(不带 `$`)。
 * 模型两种写法都会用,所以两种都得认。
 */
function Label({ text }: { text: string }) {
  return text.includes('$') ? <Markdown source={text} /> : <Latex tex={text} />;
}
