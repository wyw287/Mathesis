/**
 * 平面上共用的绘图机制:坐标轴、刻度、网格。
 *
 * plot2d 和线代视图画的是同一个东西 —— 带刻度的笛卡尔平面,只是内容不同。
 * 各写一份的话,两边的刻度算法迟早会产生分歧(而"两边的坐标轴对不齐"这种
 * 问题极难发现)。所以抽出来共用。
 */
import { formatTick, niceStep } from '../lib/math';

/** 绘图区四周的留白。左边留得多一点放 y 轴刻度标签。 */
export const PAD = { l: 46, r: 18, t: 14, b: 32 };

export interface View {
  x: [number, number];
  y: [number, number];
}

export interface PlaneProps {
  view: View;
  tx: (x: number) => number;
  ty: (y: number) => number;
  plotW: number;
  plotH: number;
  /** 每隔多少单位画一条。省略则按视口自动算。 */
  xStep?: number;
  yStep?: number;
}

export function stepFor(span: number, target: number): number {
  return niceStep(span, target);
}

/** 视口内的刻度位置。 */
export function ticks([a, b]: [number, number], step: number): number[] {
  if (!(step > 0) || !Number.isFinite(step)) return [];
  const out: number[] = [];
  const start = Math.ceil(a / step) * step;
  for (let v = start, i = 0; v <= b && i < 200; v += step, i++) {
    // 消掉浮点累积误差,否则刻度会出现 0.30000000000000004
    out.push(Math.abs(v) < step * 1e-6 ? 0 : Number(v.toFixed(10)));
  }
  return out;
}

/** 把坐标夹进一个安全区间。超出太多会让 SVG 数字爆炸,渲染反而出错。 */
export const clampCoord = (v: number) => Math.max(-1e5, Math.min(1e5, v)).toFixed(2);

export function PlaneGrid({ view, tx, ty, plotW, plotH, xStep, yStep }: PlaneProps) {
  const sx = xStep ?? niceStep(view.x[1] - view.x[0], 9);
  const sy = yStep ?? niceStep(view.y[1] - view.y[0], 6);
  return (
    <g className="grid">
      {ticks(view.x, sx).map((x) => (
        <line key={`x${x}`} x1={tx(x)} y1={PAD.t} x2={tx(x)} y2={PAD.t + plotH} />
      ))}
      {ticks(view.y, sy).map((y) => (
        <line key={`y${y}`} x1={PAD.l} y1={ty(y)} x2={PAD.l + plotW} y2={ty(y)} />
      ))}
    </g>
  );
}

export function PlaneAxes({ view, tx, ty, plotW, plotH, xStep, yStep }: PlaneProps) {
  const sx = xStep ?? niceStep(view.x[1] - view.x[0], 9);
  const sy = yStep ?? niceStep(view.y[1] - view.y[0], 6);
  // 坐标轴要贴住视口边缘,而不是跑出画面 —— 否则原点在视口外时什么都看不到
  const axisY = Math.min(Math.max(ty(0), PAD.t), PAD.t + plotH);
  const axisX = Math.min(Math.max(tx(0), PAD.l), PAD.l + plotW);

  return (
    <g className="axes">
      <line x1={PAD.l} y1={axisY} x2={PAD.l + plotW} y2={axisY} />
      <line x1={axisX} y1={PAD.t} x2={axisX} y2={PAD.t + plotH} />
      {ticks(view.x, sx).map((x) => (
        <g key={`x${x}`}>
          <line x1={tx(x)} y1={axisY - 3} x2={tx(x)} y2={axisY + 3} />
          <text x={tx(x)} y={axisY + 15} textAnchor="middle" className="tick">
            {formatTick(x, sx)}
          </text>
        </g>
      ))}
      {ticks(view.y, sy).map((y) => (
        <g key={`y${y}`}>
          <line x1={axisX - 3} y1={ty(y)} x2={axisX + 3} y2={ty(y)} />
          <text x={axisX - 7} y={ty(y) + 4} textAnchor="end" className="tick">
            {formatTick(y, sy)}
          </text>
        </g>
      ))}
    </g>
  );
}
