/**
 * 表达式求值与采样。
 *
 * 用 mathjs 而不是 new Function：模型的输出是不可信输入,和用户输入同级。
 * mathjs 的 parser 只看得到自己的数学命名空间,拿不到 window / globalThis,
 * 而且它认 `^` 作幂运算 —— 模型写 `x^2` 是常态,JS 里那会算成异或。
 */
import { compile, type EvalFunction } from 'mathjs';

const cache = new Map<string, EvalFunction>();

/** 会被 mathjs 当作赋值/定义/多语句的东西,一律拒绝。 */
const UNSAFE = /(^|[^=!<>])=([^=]|$)|;|\bimport\b|\bdef\b|\bfunction\b|\[|\]|\{|\}/;

export class ExprError extends Error {}

function assertSafe(expr: string): void {
  if (UNSAFE.test(expr)) {
    throw new ExprError(`表达式只允许是单个数学式子,不支持赋值、函数定义或多语句: ${expr}`);
  }
}

export function compileExpr(expr: string): EvalFunction {
  const hit = cache.get(expr);
  if (hit) return hit;
  assertSafe(expr);
  let fn: EvalFunction;
  try {
    fn = compile(expr);
  } catch (e) {
    throw new ExprError(`无法解析表达式 ${expr}：${(e as Error).message}`);
  }
  cache.set(expr, fn);
  return fn;
}

export function evalExpr(expr: string, scope: Record<string, number>): number {
  const v = compileExpr(expr).evaluate(scope);
  return typeof v === 'number' ? v : Number(v);
}

/** 求值失败 / 无定义 / 非有限,统一返回 NaN,由调用方决定怎么断线。 */
export function safeEval(expr: string, scope: Record<string, number>): number {
  try {
    const v = evalExpr(expr, scope);
    return Number.isFinite(v) ? v : NaN;
  } catch {
    return NaN;
  }
}

export interface SampledPoint {
  x: number;
  y: number;
}

/**
 * 采样一条显式曲线。返回的点列里,NaN 是**有意保留的断点标记** ——
 * 渲染层遇到 NaN 就断开折线,这样 1/x 在 0 附近不会连出一条竖直假线。
 */
export function sampleExplicit(
  expr: string,
  domain: [number, number],
  params: Record<string, number>,
  samples: number,
): SampledPoint[] {
  const [a, b] = domain;
  const n = Math.max(2, Math.min(samples, 4000));
  const out: SampledPoint[] = [];
  for (let i = 0; i < n; i++) {
    const x = a + ((b - a) * i) / (n - 1);
    out.push({ x, y: safeEval(expr, { ...params, x }) });
  }
  return out;
}

export function sampleParametric(
  xe: string,
  ye: string,
  tRange: [number, number],
  params: Record<string, number>,
  samples: number,
): SampledPoint[] {
  const [a, b] = tRange;
  const n = Math.max(2, Math.min(samples, 4000));
  const out: SampledPoint[] = [];
  for (let i = 0; i < n; i++) {
    const t = a + ((b - a) * i) / (n - 1);
    const scope = { ...params, t };
    out.push({ x: safeEval(xe, scope), y: safeEval(ye, scope) });
  }
  return out;
}

/** 数值范围,忽略 NaN。空集合返回 undefined。 */
export function finiteRange(vals: number[]): [number, number] | undefined {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of vals) {
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return lo <= hi ? [lo, hi] : undefined;
}

/** 取整到一个好看的刻度步长。 */
export function niceStep(span: number, targetTicks: number): number {
  if (!(span > 0)) return 1;
  const raw = span / Math.max(1, targetTicks);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const mult = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
  return mult * mag;
}

/** 按有效数字格式化刻度标签,避免 0.30000000000000004。 */
export function formatTick(v: number, step: number): string {
  if (v === 0) return '0';
  const decimals = Math.max(0, Math.min(6, Math.ceil(-Math.log10(step)) + 1));
  const s = v.toFixed(decimals);
  return s.replace(/\.?0+$/, '') || '0';
}
