import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatTick, niceStep, safeEval, sampleExplicit, sampleParametric } from '../lib/math';
import type { CanvasEvent, Curve, Plot2DSpec } from '../types/artifact';
import { colorAt } from './palette';

const HEIGHT = 420;
const PAD = { l: 46, r: 18, t: 14, b: 32 };
const DASH = { solid: undefined, dashed: '7 5', dotted: '2 4' } as const;

interface Props {
  spec: Plot2DSpec;
  scope: Record<string, number>;
  artifactId: string;
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

export function Plot2D({ spec, scope, artifactId, rev, onParam, emit }: Props) {
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const svgRef = useRef<SVGSVGElement>(null);
  const [override, setOverride] = useState<{ x: [number, number]; y: [number, number] } | null>(null);

  // AI 改了 spec，本地的手动缩放就作废 —— 否则它会悄悄盖掉 AI 想让学生看的范围
  useEffect(() => setOverride(null), [rev, spec.view.x[0], spec.view.x[1]]);

  const w = Math.max(320, width);
  const plotW = w - PAD.l - PAD.r;
  const plotH = HEIGHT - PAD.t - PAD.b;

  const samples = useMemo<Sampled[]>(() => {
    const n = Math.min(3000, Math.max(400, Math.ceil(plotW * 2)));
    return spec.curves.map((curve, index) => {
      if (curve.type === 'explicit') {
        const domain = curve.domain ?? spec.view.x;
        return { curve, index, pts: sampleExplicit(curve.expr, domain, scope, n) };
      }
      if (curve.type === 'parametric') {
        return { curve, index, pts: sampleParametric(curve.x, curve.y, curve.t, scope, n) };
      }
      // 数列:离散点,不连成线
      const [a, b] = curve.n;
      const lo = Math.floor(a);
      const hi = Math.min(Math.ceil(b), lo + 400);
      const pts: Pt[] = [];
      for (let k = lo; k <= hi; k++) {
        pts.push({ x: k, y: safeEval(curve.expr, { ...scope, n: k }) });
      }
      return { curve, index, pts };
    });
  }, [spec.curves, spec.view.x, scope, plotW]);

  const autoY = useMemo(() => autoYRange(samples), [samples]);
  const view = override ?? { x: spec.view.x, y: spec.view.y ?? autoY };

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
          <clipPath id={`clip-${artifactId}`}>
            <rect x={PAD.l} y={PAD.t} width={plotW} height={plotH} />
          </clipPath>
        </defs>

        <rect x={PAD.l} y={PAD.t} width={plotW} height={plotH} className="plot-bg" />

        <Grid view={view} tx={tx} ty={ty} xStep={xStep} yStep={yStep} plotW={plotW} plotH={plotH} />
        <Axes view={view} tx={tx} ty={ty} xStep={xStep} yStep={yStep} plotW={plotW} plotH={plotH} />

        <g clipPath={`url(#clip-${artifactId})`}>
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
                  {c.label ?? (c.type === 'explicit' ? `y = ${c.expr}` : c.type === 'sequence' ? `aₙ = ${c.expr}` : '参数曲线')}
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

      {(spec.params ?? []).length > 0 && (
        <div className="params">
          {spec.params!.map((p) => (
            <label key={p.name} className="param">
              <span className="param-name">{p.label ?? p.name}</span>
              <input
                type="range"
                min={p.min}
                max={p.max}
                step={p.step ?? (p.max - p.min) / 100}
                value={scope[p.name] ?? p.value}
                onChange={(e) => onParam(p.name, Number(e.target.value))}
                // 拖动过程只改本地渲染;松手才发事件给模型
                onPointerUp={() => emit({ type: 'paramChange', artifactId, param: p.name, value: scope[p.name] ?? p.value })}
                onKeyUp={() => emit({ type: 'paramChange', artifactId, param: p.name, value: scope[p.name] ?? p.value })}
              />
              <span className="param-value">{(scope[p.name] ?? p.value).toFixed(2)}</span>
            </label>
          ))}
        </div>
      )}
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
 * 自动 y 范围用分位数而不是 min/max。
 * 画 1/x 或 tan(x) 时 min/max 会被渐近线拉到无穷,整张图压成一条平线;
 * 取 2%~98% 分位数能让渐近线自然跑出视野,图仍然可读。
 */
function autoYRange(samples: Sampled[]): [number, number] {
  const ys: number[] = [];
  for (const s of samples) for (const p of s.pts) if (Number.isFinite(p.y)) ys.push(p.y);
  if (!ys.length) return [-1, 1];
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
