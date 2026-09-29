import { useEffect, useMemo, useRef, useState } from 'react';
import { safeEval } from '../../lib/math';
import { apply, det, eigen, type Mat2, type Vec2 } from '../../lib/matrix2';
import { PAD, PlaneAxes, PlaneGrid, clampCoord, ticks } from '../../renderers/plane';
import { ParamSliders } from '../../renderers/ParamSliders';
import type { CanvasEvent, LinearSpec } from '../../types/artifact';

const HEIGHT = 420;
const DEFAULT_VIEW = { x: [-3, 3] as [number, number], y: [-3, 3] as [number, number] };

interface Props {
  spec: LinearSpec;
  scope: Record<string, number>;
  artifactId: string;
  rev: number;
  onParam: (name: string, value: number) => void;
  emit: (e: CanvasEvent) => void;
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(560);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const cw = entries[0]?.contentRect.width;
      if (cw && cw > 0) setW(cw);
    });
    ro.observe(el);
    setW(el.clientWidth || 560);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

export function LinearView({ spec, scope, artifactId, onParam, emit }: Props) {
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const w = Math.max(260, width);
  const plotW = w - PAD.l - PAD.r;
  const plotH = HEIGHT - PAD.t - PAD.b;

  /**
   * 默认视野。
   *
   * 不能写死 [-3,3]²:矩阵是 [[10,0],[0,10]] 时单位正方形的像在 (10,10),
   * 学生**什么都看不见**。所以按**初始参数**下的矩阵把视野撑开到能装下那个像,
   * 同时不低于默认范围。
   *
   * 用初始参数而不是当前参数:拖滑块时视野必须固定,否则学生看到的是
   * "图形没变、视野在变",那正好丢掉了要展示的东西。
   */
  const fallbackView = useMemo(() => {
    const defaults: Record<string, number> = {};
    for (const p of spec.params ?? []) defaults[p.name] = p.value;
    const at = (e: string) => safeEval(e, defaults);
    const mm: Mat2 = {
      a: at(spec.matrix[0][0]),
      b: at(spec.matrix[0][1]),
      c: at(spec.matrix[1][0]),
      d: at(spec.matrix[1][1]),
    };
    if (![mm.a, mm.b, mm.c, mm.d].every(Number.isFinite)) return DEFAULT_VIEW;
    const corners = ([[0, 0], [1, 0], [1, 1], [0, 1]] as Vec2[]).map((p) => apply(mm, p));
    const span =
      Math.max(3, ...corners.map((p) => Math.abs(p[0])), ...corners.map((p) => Math.abs(p[1]))) * 1.25;
    return { x: [-span, span] as [number, number], y: [-span, span] as [number, number] };
  }, [spec.matrix, spec.params]);

  const view = useMemo(
    () => ({
      x: spec.view?.x ?? fallbackView.x,
      y: spec.view?.y ?? fallbackView.y,
    }),
    [spec.view?.x, spec.view?.y, fallbackView],
  );

  /** 矩阵的四个元素在**当前参数**下求值。无定义就整块不画,不硬凑。 */
  const m = useMemo<Mat2 | null>(() => {
    const at = (e: string) => safeEval(e, scope);
    const a = at(spec.matrix[0][0]);
    const b = at(spec.matrix[0][1]);
    const c = at(spec.matrix[1][0]);
    const d = at(spec.matrix[1][1]);
    if (![a, b, c, d].every(Number.isFinite)) return null;
    return { a, b, c, d };
  }, [spec.matrix, scope]);

  const tx = (x: number) => PAD.l + ((x - view.x[0]) / (view.x[1] - view.x[0])) * plotW;
  const ty = (y: number) => PAD.t + plotH - ((y - view.y[0]) / (view.y[1] - view.y[0])) * plotH;
  const px = (p: Vec2) => `${clampCoord(tx(p[0]))} ${clampCoord(ty(p[1]))}`;

  const info = useMemo(() => (m ? { det: det(m), eigen: eigen(m) } : null), [m]);

  const clipId = `lin-clip-${artifactId}`;

  return (
    <div className="linear" ref={wrapRef}>
      {spec.note && <div className="plot-note">{spec.note}</div>}

      <svg viewBox={`0 0 ${w} ${HEIGHT}`} width="100%" height={HEIGHT} className="plot-svg">
        <defs>
          <clipPath id={clipId}>
            <rect x={PAD.l} y={PAD.t} width={plotW} height={plotH} />
          </clipPath>
          <marker id={`${clipId}-head`} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
            <path d="M0,0 L7,3.5 L0,7 Z" fill="currentColor" />
          </marker>
        </defs>

        <rect x={PAD.l} y={PAD.t} width={plotW} height={plotH} className="plot-bg" />

        {/* 原网格先画,变换后的网格叠上去 —— 两个都在才看得出"被扭成什么样" */}
        <PlaneGrid view={view} tx={tx} ty={ty} plotW={plotW} plotH={plotH} />

        {m && (
          <g clipPath={`url(#${clipId})`}>
            <TransformedGrid m={m} view={view} tx={tx} ty={ty} />

            {/* 单位正方形和它的像。像的面积就是 |det|,那是行列式最直观的含义。 */}
            <polygon
              points={[[0, 0], [1, 0], [1, 1], [0, 1]].map((p) => px(p as Vec2)).join(' ')}
              className="lin-unit"
            />
            <polygon
              points={[[0, 0], [1, 0], [1, 1], [0, 1]]
                .map((p) => px(apply(m, p as Vec2)))
                .join(' ')}
              className="lin-image"
            />

            {/* 特征方向:方向不被改变的那些线 */}
            {info?.eigen.real.map((e, i) => {
              const [vx, vy] = e.vector;
              const far = 1e3;
              return (
                <line
                  key={i}
                  x1={tx(vx * -far)}
                  y1={ty(vy * -far)}
                  x2={tx(vx * far)}
                  y2={ty(vy * far)}
                  className="lin-eigen"
                />
              );
            })}

            {/* 基向量和它们的像 */}
            <Vec from={[0, 0]} to={[1, 0]} tx={tx} ty={ty} cls="lin-basis" />
            <Vec from={[0, 0]} to={[0, 1]} tx={tx} ty={ty} cls="lin-basis" />
            <Vec from={[0, 0]} to={apply(m, [1, 0])} tx={tx} ty={ty} cls="lin-basis-image" marker={`${clipId}-head`} />
            <Vec from={[0, 0]} to={apply(m, [0, 1])} tx={tx} ty={ty} cls="lin-basis-image" marker={`${clipId}-head`} />

            {spec.probe && (
              <>
                <Vec
                  from={[0, 0]}
                  to={[safeEval(spec.probe.x, scope), safeEval(spec.probe.y, scope)]}
                  tx={tx}
                  ty={ty}
                  cls="lin-probe"
                />
                <Vec
                  from={[0, 0]}
                  to={apply(m, [safeEval(spec.probe.x, scope), safeEval(spec.probe.y, scope)])}
                  tx={tx}
                  ty={ty}
                  cls="lin-probe-image"
                  marker={`${clipId}-head`}
                />
              </>
            )}
          </g>
        )}

        <PlaneAxes view={view} tx={tx} ty={ty} plotW={plotW} plotH={plotH} />
      </svg>

      {m && info ? (
        <MatrixPanel m={m} d={info.det} eigen={info.eigen} />
      ) : (
        <div className="lin-panel lin-invalid">矩阵里有的项在当前参数下无定义</div>
      )}

      <ParamSliders
        params={spec.params ?? []}
        scope={scope}
        onChange={onParam}
        onCommit={(name, value) => emit({ type: 'paramChange', artifactId, param: name, value })}
      />
    </div>
  );
}

/** 原网格经变换后的样子。直线经线性变换还是直线,所以每格画一段就够。 */
function TransformedGrid({
  m,
  view,
  tx,
  ty,
}: {
  m: Mat2;
  view: { x: [number, number]; y: [number, number] };
  tx: (x: number) => number;
  ty: (y: number) => number;
}) {
  const sx = (view.x[1] - view.x[0]) / 9;
  const sy = (view.y[1] - view.y[0]) / 6;
  const seg = (p: Vec2, q: Vec2, key: string) => (
    <line
      key={key}
      x1={tx(p[0])}
      y1={ty(p[1])}
      x2={tx(q[0])}
      y2={ty(q[1])}
      className="lin-grid-line"
    />
  );
  const out = [];
  for (const k of ticks(view.x, sx)) {
    out.push(seg(apply(m, [k, view.y[0]]), apply(m, [k, view.y[1]]), `v${k}`));
  }
  for (const k of ticks(view.y, sy)) {
    out.push(seg(apply(m, [view.x[0], k]), apply(m, [view.x[1], k]), `h${k}`));
  }
  return <g>{out}</g>;
}

function Vec({
  from,
  to,
  tx,
  ty,
  cls,
  marker,
}: {
  from: Vec2;
  to: Vec2;
  tx: (x: number) => number;
  ty: (y: number) => number;
  cls: string;
  marker?: string;
}) {
  const x1 = tx(from[0]);
  const y1 = ty(from[1]);
  const x2 = tx(to[0]);
  const y2 = ty(to[1]);
  if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
  return (
    <line
      x1={clampCoord(x1)}
      y1={clampCoord(y1)}
      x2={clampCoord(x2)}
      y2={clampCoord(y2)}
      className={cls}
      markerEnd={marker ? `url(#${marker})` : undefined}
      style={marker ? { color: 'currentColor' } : undefined}
    />
  );
}

/** 矩阵本身、行列式、特征值 —— 学生要能把图上的现象和数字对上。 */
function MatrixPanel({
  m,
  d,
  eigen: eig,
}: {
  m: Mat2;
  d: number;
  eigen: ReturnType<typeof eigen>;
}) {
  const fmt = (n: number) => (Math.abs(n) < 1e-10 ? '0' : String(Number(n.toPrecision(4))));
  const degenerate = Math.abs(d) < 1e-9;

  return (
    <div className="lin-panel">
      <div className="lin-matrix" aria-label="矩阵">
        <span className="lin-bracket">[</span>
        <span className="lin-cells">
          <span>{fmt(m.a)}</span>
          <span>{fmt(m.b)}</span>
          <span>{fmt(m.c)}</span>
          <span>{fmt(m.d)}</span>
        </span>
        <span className="lin-bracket">]</span>
      </div>

      <div className="lin-facts">
        <div className={degenerate ? 'lin-fact warn' : 'lin-fact'}>
          <span className="lin-fact-name">det</span>
          <span className="lin-fact-value">{fmt(d)}</span>
          {/* 行列式是面积的缩放倍数 —— 零就是"压扁了",那是秩亏缺的几何含义 */}
          <span className="lin-fact-note">
            {degenerate
              ? '= 0:变换把整个平面压到一条线(或一个点)上,不可逆'
              : `面积放大 ${Math.abs(d).toPrecision(3)} 倍${d < 0 ? ',并且翻转了定向' : ''}`}
          </span>
        </div>

        <div className="lin-fact">
          <span className="lin-fact-name">特征值</span>
          {eig.complex ? (
            <span className="lin-fact-note">
              没有实特征值 —— 这个变换含旋转,平面上没有哪个方向不被转向
            </span>
          ) : eig.allDirections ? (
            // 纯缩放:每个方向都不变。只画一条线会让学生以为只有那一个方向
            <span className="lin-fact-note">
              所有方向都是特征方向(纯缩放,特征值 {fmt(eig.real[0]?.value ?? 0)})
            </span>
          ) : (
            <span className="lin-fact-value">
              {eig.real.map((e) => fmt(e.value)).join(' 、 ')}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
