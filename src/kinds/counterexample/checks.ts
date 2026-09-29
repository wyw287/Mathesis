/**
 * 反例工作台的条件求值。
 *
 * 核心不是"能不能算",而是**算出来的和验不了的必须分开显示**。
 * 有些前提(连续、可导、一致收敛)在数值上根本没法验证;把它们和算出来的
 * 挤成同一个对勾,等于给学生一个假的确定性 —— 那比不做检查更糟。
 *
 * 所以状态有三种,而不是布尔:
 *   pass     算出来成立的
 *   fail     算出来不成立的
 *   asserted 模型声称成立,我们验不了
 */
import { safeEval, sampleExplicit } from '../../lib/math';
import type { CounterexampleCheck, CounterexampleSpec } from '../../types/artifact';

export type CheckStatus = 'pass' | 'fail' | 'asserted';

export interface CheckOutcome {
  status: CheckStatus;
  /** 一句话说明算出来是什么,让学生能核对,而不是只看到一个对勾 */
  detail: string;
}

export interface Verdict {
  hypothesesOk: boolean;
  conclusionOk: boolean;
  /** 前提和结论都站得住 —— 也就是找到了一个反例 */
  found: boolean;
  /** 其中有多少条是"模型声称"的。大于零时界面必须说明。 */
  assertedCount: number;
}

const SAMPLES = 160;

const OP_SYMBOL: Record<string, string> = {
  eq: '=',
  ne: '≠',
  gt: '>',
  lt: '<',
  ge: '≥',
  le: '≤',
};

/** 保留几位有效数字就够了,多余的小数只会干扰阅读。 */
function fmt(n: number): string {
  if (!Number.isFinite(n)) return '无定义';
  if (n === 0) return '0';
  const abs = Math.abs(n);
  if (abs >= 1e5 || abs < 1e-4) return n.toExponential(2);
  return String(Number(n.toPrecision(6)));
}

function checkNumeric(
  check: Extract<CounterexampleCheck, { kind: 'numeric' }>,
  scope: Record<string, number>,
): CheckOutcome {
  const v = safeEval(check.expr, scope);
  const shown = `${fmt(v)} ${OP_SYMBOL[check.op]} ${fmt(check.value)}`;
  if (!Number.isFinite(v)) {
    return { status: 'fail', detail: '在当前参数下无法求值' };
  }
  const tol = check.tol ?? 1e-6;
  const ok = {
    eq: Math.abs(v - check.value) <= tol,
    ne: Math.abs(v - check.value) > tol,
    gt: v > check.value,
    lt: v < check.value,
    ge: v >= check.value - tol,
    le: v <= check.value + tol,
  }[check.op];
  return { status: ok ? 'pass' : 'fail', detail: shown };
}

function checkSampled(
  check: Extract<CounterexampleCheck, { kind: 'sampled' }>,
  scope: Record<string, number>,
): CheckOutcome {
  const ys = sampleExplicit(check.expr, check.over, scope, SAMPLES)
    .map((p) => p.y)
    .filter(Number.isFinite);

  // 采不到点通常意味着这个式子在区间上大部分地方无定义 —— 那本身就是个信号,
  // 不能默默当成"通过"
  if (ys.length < 2) return { status: 'fail', detail: '在这个区间上几乎处处无法求值' };

  const hasPos = ys.some((y) => y > 0);
  const hasNeg = ys.some((y) => y < 0);
  const [lo, hi] = check.over;

  switch (check.property) {
    case 'positive':
      return hasPos && !hasNeg
        ? { status: 'pass', detail: `在 [${fmt(lo)}, ${fmt(hi)}] 上恒正` }
        : { status: 'fail', detail: hasNeg ? '区间内出现了负值' : '区间内出现了非正值' };
    case 'negative':
      return hasNeg && !hasPos
        ? { status: 'pass', detail: `在 [${fmt(lo)}, ${fmt(hi)}] 上恒负` }
        : { status: 'fail', detail: hasPos ? '区间内出现了正值' : '区间内出现了非负值' };
    case 'signChanges':
      return hasPos && hasNeg
        ? { status: 'pass', detail: `区间内既有正值也有负值(最小值 ${fmt(Math.min(...ys))},最大值 ${fmt(Math.max(...ys))})` }
        : { status: 'fail', detail: hasPos ? '区间内全是非负值' : '区间内全是非正值' };
    case 'increasing': {
      const bad = ys.findIndex((y, i) => i > 0 && y < ys[i - 1]);
      return bad < 0
        ? { status: 'pass', detail: `在 [${fmt(lo)}, ${fmt(hi)}] 上单调不减` }
        : { status: 'fail', detail: '区间内出现了下降' };
    }
    case 'decreasing': {
      const bad = ys.findIndex((y, i) => i > 0 && y > ys[i - 1]);
      return bad < 0
        ? { status: 'pass', detail: `在 [${fmt(lo)}, ${fmt(hi)}] 上单调不增` }
        : { status: 'fail', detail: '区间内出现了上升' };
    }
  }
}

export function evaluateCheck(
  check: CounterexampleCheck,
  scope: Record<string, number>,
): CheckOutcome {
  switch (check.kind) {
    case 'asserted':
      return { status: 'asserted', detail: '模型声称成立,但这条在数值上没法验证' };
    case 'numeric':
      return checkNumeric(check, scope);
    case 'sampled':
      return checkSampled(check, scope);
  }
}

/**
 * 整体判定。
 *
 * `asserted` 算作"满足"—— 否则一条"处处连续"就会让任何反例都无法成立。
 * 但它被**单独计数**,界面必须把它说出来。这是这个 kind 最重要的一条规则:
 * 找到的反例有多可靠,学生要能自己判断。
 */
export function evaluateAll(
  spec: CounterexampleSpec,
  scope: Record<string, number>,
): { hypotheses: CheckOutcome[]; conclusion: CheckOutcome; verdict: Verdict } {
  const hypotheses = spec.hypotheses.map((c) => evaluateCheck(c, scope));
  const conclusion = evaluateCheck(spec.conclusion, scope);

  const satisfied = (o: CheckOutcome) => o.status === 'pass' || o.status === 'asserted';
  const hypothesesOk = hypotheses.every(satisfied);
  const conclusionOk = satisfied(conclusion);
  const assertedCount =
    hypotheses.filter((o) => o.status === 'asserted').length +
    (conclusion.status === 'asserted' ? 1 : 0);

  return {
    hypotheses,
    conclusion,
    verdict: { hypothesesOk, conclusionOk, found: hypothesesOk && conclusionOk, assertedCount },
  };
}
