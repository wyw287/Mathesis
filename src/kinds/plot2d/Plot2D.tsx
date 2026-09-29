import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ParamSliders } from '../../renderers/ParamSliders';
import { marchingSquares, sampleVectorField, toZeroForm, type Arrow, type Segment } from '../../lib/field';
import { formatTick, niceStep, safeEval, sampleExplicit, sampleParametric } from '../../lib/math';
import type { CanvasEvent, Curve, Plot2DSpec } from '../../types/artifact';
import { colorAt } from './palette';

const HEIGHT = 420;
const PAD = { l: 46, r: 18, t: 14, b: 32 };
const DASH = { solid: undefined, dashed: '7 5', dotted: '2 4' } as const;

interface Props {
  spec: Plot2DSpec;
  scope: Record<string, number>;
  artifactId: string;
  /**
   * SVG 里 clipPath 的 id 前缀。
   *
   * 默认就用 artifactId,但**并排对比里一张卡片会嵌好几张图**,它们共用同一个
   * artifactId。重复的 DOM id 会让 `url(#clip-…)` 解析到第一个匹配的节点 ——
   * 两边宽度不同时就会剪错。所以并排时每一格要传一个不同的 key。
   */
  clipKey?: string;
  /** artifact 修订号:变了说明 AI 改了这张图,本地视野覆盖要作废 */
  rev: number;
  onParam: (name: string, value: number) => void;
  emit: (e: CanvasEvent) => void;
}

interface Pt {
  x: number;
  y: number;
}

interface Sampled {
  curve: Curve;
  index: number;
  pts: Pt[];
}

/**
 * 走网格采样那一路的曲线。
 *
 * 联合类型而不是一个带可选字段的对象:隐式曲线产出线段、向量场产出箭头,
 * 两者没有任何共性,硬塞进一个结构只会让两边都要判空。
 */
type GridCurve =
  | { kind: 'implicit'; curve: Extract<Curve, { type: 'implicit' }>; index: number; segments: Segment[] }
  | { kind: 'vectorField'; curve: Extract<Curve, { type: 'vectorField' }>; index: number; arrows: Arrow[] };

export function Plot2D({ spec, scope, artifactId, clipKey, rev, onParam, emit }: Props) {
  const clip = clipKey ?? artifactId;
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const svgRef = useRef<SVGSVGElement>(null);
  const [override, setOverride] = useState<{ x: [number, number]; y: [number, number] } | null>(null);

  // AI 改了 spec，本地的手动缩放就作废 —— 否则它会悄悄盖掉 AI 想让学生看的范围
  useEffect(() => setOverride(null), [rev, spec.view.x[0], spec.view.x[1]]);

  // 260 而不是更大的值:并排三格时每格只有约 280px,卡在 320 会横向溢出
  const w = Math.max(260, width);
  const plotW = w - PAD.l - PAD.r;
  const plotH = HEIGHT - PAD.t - PAD.b;

  /**
   * 只有这三种能"沿着 x 或 t 走一遍"。
   * 隐式曲线和向量场一个 x 可能对应多个 y,必须铺二维网格 —— 见下面的网格 memo。
   */
  const samples = useMemo<Sampled[]>(() => {
    const n = Math.min(3000, Math.max(400, Math.ceil(plotW * 2)));
    const out: Sampled[] = [];
    spec.curves.forEach((curve, index) => {
      if (curve.type === 'explicit') {
        const domain = curve.domain ?? spec.view.x;
        out.push({ curve, index, pts: sampleExplicit(curve.expr, domain, scope, n) });
      } else if (curve.type === 'parametric') {
        out.push({ curve, index, pts: sampleParametric(curve.x, curve.y, curve.t, scope, n) });
      } else if (curve.type === 'sequence') {
        // 数列:离散点,不连成线
        const lo = Math.floor(curve.n[0]);
        const hi = Math.min(Math.ceil(curve.n[1]), lo + 400);
        const pts: Pt[] = [];
        for (let k = lo; k <= hi; k++) {
          pts.push({ x: k, y: safeEval(curve.expr, { ...scope, n: k }) });
        }
        out.push({ curve, index, pts });
      }
    });
    return out;
  }, [spec.curves, spec.view.x, scope, plotW]);

  const autoY = useMemo(
    () => autoYRange(samples, spec.view.x[1] - spec.view.x[0], plotW, plotH),
    [samples, spec.view.x, plotW, plotH],
  );

  // 必须 memo:它每次都构造新对象的话,下面的网格 memo 会每帧重算
  const view = useMemo(
    () => override ?? { x: spec.view.x, y: spec.view.y ?? autoY },
    [override, spec.view.x, spec.view.y, autoY],
  );

  /**
   * 隐式曲线(marching squares)和向量场(逐点取箭头)。
   *
   * 网格分辨率跟着画布走:太粗会把小结构整个漏掉(比如半径很小的圆),
   * 太密则在拖滑块时卡顿。除以 4 是这两者之间的平衡点。
   */
  const grid = useMemo<GridCurve[]>(() => {
    const cols = Math.min(240, Math.max(60, Math.round(plotW / 4)));
    const rows = Math.min(180, Math.max(45, Math.round(plotH / 4)));
    const out: GridCurve[] = [];
    spec.curves.forEach((curve, index) => {
      if (curve.type === 'implicit') {
        const F = toZeroForm(curve.eq);
        out.push({
          kind: 'implicit',
          curve,
          index,
          segments: marchingSquares((x, y) => safeEval(F, { ...scope, x, y }), view, cols, rows),
        });
      } else if (curve.type === 'vectorField') {
        out.push({
          kind: 'vectorField',
          curve,
          index,
          arrows: sampleVectorField(
            (x, y) => safeEval(curve.fx, { ...scope, x, y }),
            (x, y) => safeEval(curve.fy, { ...scope, x, y }),
            view,
            curve.density ?? 14,
          ),
        });
      }
    });
    return out;
  }, [spec.curves, view, scope, plotW, plotH]);

  const tx = useCallback((x: number) => PAD.l + ((x - view.x[0]) / (view.x[1] - view.x[0])) * plotW, [view, plotW]);
  const ty = useCallback(
    (y: number) => PAD.t + plotH - ((y - view.y[0]) / (view.y[1] - view.y[0])) * plotH,
    [view, plotH],
  );

  // ---- 交互:滚轮缩放 / 拖拽平移。都不写进 spec,松手后才作为事件上报 ----
  const emitTimer = useRef<number | undefined>(undefined);
  const reportViewport = useCallback(
    (v: { x: [number, number]; y: [number, number] }) => {
      window.clearTimeout(emitTimer.current);
      emitTimer.current = window.setTimeout(() => emit({ type: 'viewport', artifactId, view: v }), 450);
    },
    [artifactId, emit],
  );

  const clampSpan = (a: number, b: number): [number, number] => {
    // 防止缩到浮点失效或大到没有意义
    const span = Math.min(Math.max(b - a, 1e-9), 1e9);
    const mid = (a + b) / 2;
    return [mid - span / 2, mid + span / 2];
  };

  const zoom = (fx: number, fy: number, k: number) => {
    const cx = view.x[0] + fx * (view.x[1] - view.x[0]);
    const cy = view.y[0] + fy * (view.y[1] - view.y[0]);
    const next = {
      x: clampSpan(cx + (view.x[0] - cx) * k, cx + (view.x[1] - cx) * k),
      y: clampSpan(cy + (view.y[0] - cy) * k, cy + (view.y[1] - cy) * k),
    };
    setOverride(next);
    reportViewport(next);
  };

  // 没有依赖数组是有意的:每次渲染都重新挂,这样 zoom 闭包里拿到的一定是当前视野。
  // 挂载/卸载一个监听器的开销远小于用 ref 手动同步视野状态带来的出错风险。
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      // 屏幕坐标 → viewBox 坐标(两者尺寸不一定相等,所以要先换算)
      const vx = (ev.clientX - rect.left) * (w / rect.width);
      const vy = (ev.clientY - rect.top) * (HEIGHT / rect.height);
      const fx = (vx - PAD.l) / plotW;
      const fy = 1 - (vy - PAD.t) / plotH;
      if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return;
      const k = Math.exp(ev.deltaY * 0.0015 * (window.devicePixelRatio > 1 ? 0.6 : 1));
      zoom(Math.min(1, Math.max(0, fx)), Math.min(1, Math.max(0, fy)), k);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });

  const drag = useRef<{ x: number; y: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    drag.current = { x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!drag.current) return;
    const dxPx = e.clientX - drag.current.x;
    const dyPx = e.clientY - drag.current.y;
    drag.current = { x: e.clientX, y: e.clientY };
    const dx = (dxPx / plotW) * (view.x[1] - view.x[0]);
    const dy = (dyPx / plotH) * (view.y[1] - view.y[0]);
    const next = {
      x: clampSpan(view.x[0] - dx, view.x[1] - dx),
      y: clampSpan(view.y[0] + dy, view.y[1] + dy),
    };
    setOverride(next);
    reportViewport(next);
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  const xStep = niceStep(view.x[1] - view.x[0], 9);
  const yStep = niceStep(view.y[1] - view.y[0], 6);

  return (
    <div className="plot2d" ref={wrapRef}>
      {spec.note && <div className="plot-note">{spec.note}</div>}

      <svg
        ref={svgRef}
        viewBox={`0 0 ${w} ${HEIGHT}`}
        width="100%"
        height={HEIGHT}
        role="img"
        className="plot-svg"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <defs>
          <clipPath id={`clip-${clip}`}>
            <rect x={PAD.l} y={PAD.t} width={plotW} height={plotH} />
          </clipPath>
        </defs>

        <rect x={PAD.l} y={PAD.t} width={plotW} height={plotH} className="plot-bg" />

        <Grid view={view} tx={tx} ty={ty} xStep={xStep} yStep={yStep} plotW={plotW} plotH={plotH} />
        <Axes view={view} tx={tx} ty={ty} xStep={xStep} yStep={yStep} plotW={plotW} plotH={plotH} />

        <g clipPath={`url(#clip-${clip})`}>
          {samples.map(({ curve, index, pts }) => {
            const color = colorAt(index, curve.style?.color);
            const dash = DASH[curve.style?.dash ?? 'solid'];
            const width = curve.style?.width ?? 2;
            if (curve.type === 'sequence') {
              return (
                <g key={index}>
                  {pts
                    .filter((p) => Number.isFinite(p.y))
                    .map((p) => (
                      <circle key={p.x} cx={tx(p.x)} cy={ty(p.y)} r={2.6} fill={color} />
                    ))}
                </g>
              );
            }
            return (
              <path
                key={index}
                d={pathFrom(pts, tx, ty)}
                fill="none"
                stroke={color}
                strokeWidth={width}
                strokeDasharray={dash}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            );
          })}

          {/* 隐式曲线:一条 path 装下所有线段,而不是每段一个 <line> ——
              一个圆可能抽出上千段,那样 DOM 会被压垮 */}
          {grid.map((g) =>
            g.kind === 'implicit' ? (
              <path
                key={`imp-${g.index}`}
                d={g.segments
                  .map((s) => `M ${tx(s.x1).toFixed(2)} ${ty(s.y1).toFixed(2)} L ${tx(s.x2).toFixed(2)} ${ty(s.y2).toFixed(2)}`)
                  .join(' ')}
                fill="none"
                stroke={colorAt(g.index, g.curve.style?.color)}
                strokeWidth={g.curve.style?.width ?? 2}
                strokeDasharray={DASH[g.curve.style?.dash ?? 'solid']}
                strokeLinecap="round"
              />
            ) : (
              <path
                key={`vf-${g.index}`}
                d={arrowsToPath(g.arrows, tx, ty, view, plotW, plotH, g.curve.scale ?? 'fixed')}
                fill="none"
                stroke={colorAt(g.index, g.curve.style?.color)}
                strokeWidth={g.curve.style?.width ?? 1.4}
                strokeLinecap="round"
              />
            ),
          )}

          {(spec.points ?? []).map((p, i) => {
            const x = safeEval(p.at[0], scope);
            const y = safeEval(p.at[1], scope);
            if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
            return (
              <g key={p.name || i}>
                <circle cx={tx(x)} cy={ty(y)} r={4.5} fill={colorAt(i + 3, p.style?.color)} />
                {p.label && (
                  <text x={tx(x) + 8} y={ty(y) - 8} className="plot-label">
                    {p.label}
                  </text>
                )}
              </g>
            );
          })}

          {(spec.annotations ?? []).map((a, i) => {
            const x = safeEval(a.at[0], scope);
            const y = safeEval(a.at[1], scope);
            if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
            return (
              <text key={i} x={tx(x)} y={ty(y)} className="plot-annotation">
                {a.text}
              </text>
            );
          })}
        </g>

        {/* 图例:多条曲线时必须给,否则学生分不清哪条是哪条 */}
        {spec.curves.length > 1 && (
          <g>
            {spec.curves.map((c, i) => (
              <g key={i} transform={`translate(${PAD.l + 12}, ${PAD.t + 18 + i * 18})`}>
                <line x1={0} y1={0} x2={20} y2={0} stroke={colorAt(i, c.style?.color)} strokeWidth={2} strokeDasharray={DASH[c.style?.dash ?? 'solid']} />
                <text x={26} y={4} className="plot-legend">
                  {c.label ?? curveLabel(c)}
                </text>
              </g>
            ))}
          </g>
        )}
      </svg>

      <div className="plot-footer">
        <span className="hint">滚轮缩放 · 拖动平移</span>
        {override && (
          <button className="link-btn" onClick={() => setOverride(null)}>
            重置视野
          </button>
        )}
      </div>

      <ParamSliders
        params={spec.params ?? []}
        scope={scope}
        onChange={onParam}
        onCommit={(name, value) => emit({ type: 'paramChange', artifactId, param: name, value })}
      />
    </div>
  );
}

// ------------------------------------------------------------------ 子组件

interface AxesProps {
  view: { x: [number, number]; y: [number, number] };
  tx: (x: number) => number;
  ty: (y: number) => number;
  xStep: number;
  yStep: number;
  plotW: number;
  plotH: number;
}

function Grid({ view, tx, ty, xStep, yStep, plotW, plotH }: AxesProps) {
  const xs = ticks(view.x, xStep);
  const ys = ticks(view.y, yStep);
  return (
    <g className="grid">
      {xs.map((x) => (
        <line key={`x${x}`} x1={tx(x)} y1={PAD.t} x2={tx(x)} y2={PAD.t + plotH} />
      ))}
      {ys.map((y) => (
        <line key={`y${y}`} x1={PAD.l} y1={ty(y)} x2={PAD.l + plotW} y2={ty(y)} />
      ))}
    </g>
  );
}

function Axes({ view, tx, ty, xStep, yStep, plotW, plotH }: AxesProps) {
  const xs = ticks(view.x, xStep);
  const ys = ticks(view.y, yStep);
  const axisY = Math.min(Math.max(ty(0), PAD.t), PAD.t + plotH);
  const axisX = Math.min(Math.max(tx(0), PAD.l), PAD.l + plotW);

  return (
    <g className="axes">
      <line x1={PAD.l} y1={axisY} x2={PAD.l + plotW} y2={axisY} />
      <line x1={axisX} y1={PAD.t} x2={axisX} y2={PAD.t + plotH} />
      {xs.map((x) => (
        <g key={`x${x}`}>
          <line x1={tx(x)} y1={axisY - 3} x2={tx(x)} y2={axisY + 3} />
          <text x={tx(x)} y={axisY + 15} textAnchor="middle" className="tick">
            {formatTick(x, xStep)}
          </text>
        </g>
      ))}
      {ys.map((y) => (
        <g key={`y${y}`}>
          <line x1={axisX - 3} y1={ty(y)} x2={axisX + 3} y2={ty(y)} />
          <text x={axisX - 7} y={ty(y) + 4} textAnchor="end" className="tick">
            {formatTick(y, yStep)}
          </text>
        </g>
      ))}
    </g>
  );
}

// -------------------------------------------------------------------- 工具

function ticks([a, b]: [number, number], step: number): number[] {
  if (!(step > 0) || !Number.isFinite(step)) return [];
  const out: number[] = [];
  const start = Math.ceil(a / step) * step;
  for (let v = start, i = 0; v <= b && i < 200; v += step, i++) {
    // 消掉浮点累积误差,否则刻度会出现 0.30000000000000004
    out.push(Math.abs(v) < step * 1e-6 ? 0 : Number(v.toFixed(10)));
  }
  return out;
}

/**
 * 把所有箭头拼成一条 path。
 *
 * 每个箭头是"轴 + 一个 V 形头"。上千个箭头如果各用一个元素,DOM 会被压垮;
 * 拼成一条 path 就只有一个节点,而且 V 形头用描边画也够看 ——
 * 方向场本来就是在看方向,不需要实心箭头那点视觉重量。
 */
function arrowsToPath(
  arrows: Arrow[],
  tx: (x: number) => number,
  ty: (y: number) => number,
  view: { x: [number, number]; y: [number, number] },
  plotW: number,
  plotH: number,
  scale: 'fixed' | 'magnitude',
): string {
  const LEN = 9;
  const HEAD = 3.6;
  const maxMag = scale === 'magnitude' ? Math.max(...arrows.map((a) => a.magnitude), 1e-12) : 1;
  const spanX = view.x[1] - view.x[0];
  const spanY = view.y[1] - view.y[0];
  const parts: string[] = [];

  for (const a of arrows) {
    const px = tx(a.x);
    const py = ty(a.y);
    // 转成屏幕方向再归一化,否则坐标轴比例不一致时箭头指向会偏
    const rawX = (a.u / spanX) * plotW;
    const rawY = -(a.v / spanY) * plotH;
    const len = Math.hypot(rawX, rawY);
    if (!Number.isFinite(len) || len < 1e-9) continue;

    const shrink = scale === 'magnitude' ? Math.min(1, a.magnitude / maxMag) : 1;
    const ux = rawX / len;
    const uy = rawY / len;
    const reach = LEN * (0.4 + 0.6 * shrink);
    const ex = px + ux * reach;
    const ey = py + uy * reach;

    const ang = Math.atan2(uy, ux);
    const h1x = ex - HEAD * Math.cos(ang - 0.55);
    const h1y = ey - HEAD * Math.sin(ang - 0.55);
    const h2x = ex - HEAD * Math.cos(ang + 0.55);
    const h2y = ey - HEAD * Math.sin(ang + 0.55);

    parts.push(
      `M ${px.toFixed(1)} ${py.toFixed(1)} L ${ex.toFixed(1)} ${ey.toFixed(1)}`,
      `M ${h1x.toFixed(1)} ${h1y.toFixed(1)} L ${ex.toFixed(1)} ${ey.toFixed(1)} L ${h2x.toFixed(1)} ${h2y.toFixed(1)}`,
    );
  }
  return parts.join(' ');
}

function pathFrom(pts: Pt[], tx: (x: number) => number, ty: (y: number) => number): string {
  let d = '';
  let pen = false;
  for (const p of pts) {
    const px = tx(p.x);
    const py = ty(p.y);
    if (!Number.isFinite(px) || !Number.isFinite(py)) {
      pen = false; // 断点:1/x 在 0 附近不能连出一条竖直假线
      continue;
    }
    const sx = clampCoord(px);
    const sy = clampCoord(py);
    d += pen ? ` L ${sx} ${sy}` : ` M ${sx} ${sy}`;
    pen = true;
  }
  return d;
}

const clampCoord = (v: number) => Math.max(-1e5, Math.min(1e5, v)).toFixed(2);

/**
 * 自动 y 范围。
 *
 * 两种策略,按有没有显式采样点分:
 *
 * **有采样点时**用分位数而不是 min/max。画 1/x 或 tan(x) 时 min/max 会被渐近线
 * 拉到无穷,整张图压成一条平线;取 2%~98% 分位数能让渐近线自然跑出视野。
 *
 * **没有采样点时**(整张图只有隐式曲线或向量场)按画布纵横比推一个高度。
 * 否则会落到默认的 [-1,1],而 x 范围可能是 [-3,3] —— 一个圆就被压成椭圆了。
 */
function autoYRange(
  samples: Sampled[],
  xSpan: number,
  plotW: number,
  plotH: number,
): [number, number] {
  const ys: number[] = [];
  for (const s of samples) for (const p of s.pts) if (Number.isFinite(p.y)) ys.push(p.y);

  if (!ys.length) {
    const half = ((xSpan / 2) * plotH) / Math.max(1, plotW);
    return [-half, half];
  }

  ys.sort((a, b) => a - b);
  const at = (q: number) => ys[Math.min(ys.length - 1, Math.max(0, Math.round(q * (ys.length - 1))))];
  let lo = at(0.02);
  let hi = at(0.98);
  if (!(hi > lo)) {
    lo = ys[0];
    hi = ys[ys.length - 1];
  }
  if (!(hi > lo)) return [lo - 1, lo + 1];
  const pad = (hi - lo) * 0.12;
  return [lo - pad, hi + pad];
}

/** 图例文字。每种曲线都要说清楚它是什么 —— 否则隐式曲线会被标成"参数曲线"。 */
function curveLabel(c: Curve): string {
  switch (c.type) {
    case 'explicit':
      return `y = ${c.expr}`;
    case 'parametric':
      return `(${c.x}, ${c.y})`;
    case 'sequence':
      return `aₙ = ${c.expr}`;
    case 'implicit':
      return c.eq;
    case 'vectorField':
      return `向量场 (${c.fx}, ${c.fy})`;
  }
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(760);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const cw = entries[0]?.contentRect.width;
      if (cw && cw > 0) setW(cw);
    });
    ro.observe(el);
    setW(el.clientWidth || 760);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}
