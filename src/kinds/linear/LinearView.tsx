import { useEffect, useMemo, useRef, useState } from 'react';
import { safeEval } from '../../lib/math';
import { apply, det, eigen, isSingular, nullSpace, rank, type Mat2, type NullSpace, type Vec2 } from '../../lib/matrix2';
import { PAD, PlaneAxes, PlaneGrid, clampCoord, ticks } from '../../renderers/plane';
import { ParamSliders } from '../../renderers/ParamSliders';
import type { CanvasEvent, LinearSpec, ParamSpec } from '../../types/artifact';

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

/** 一个可以直接拖的点:拖动会写回这两个参数(横坐标一个、纵坐标一个)。 */
interface Handle {
  name: string;
  /** 样式类。基向量的像用红的,探测向量用绿的 —— 和它们各自的线同色。 */
  cls: string;
  /** 悬停时显示的那句话。 */
  hint: string;
  px: ParamSpec;
  py: ParamSpec;
  at: Vec2;
}

/** 夹到参数自己的范围里 —— 拖出范围会让滑块显示一个它根本表示不了的值。 */
const clampTo = (p: ParamSpec, v: number) => Math.min(p.max, Math.max(p.min, v));

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
  const rankVal = useMemo(() => (m ? rank(m) : null), [m]);
  const ns = useMemo(() => (m ? nullSpace(m) : null), [m]);

  /**
   * 秩亏时,λ=0 的特征方向**就是**零空间 —— 同一条线。
   *
   * 画两遍只会叠成一条看不清的东西,所以这里把 λ≈0 的那个跳掉,留给零空间那条:
   * "被压没了的方向"比"一个等于零的特征值"更值得用图形说。
   * 特征值本身仍然在下面的面板里列着,没有丢。
   */
  const eigenLines = useMemo(() => {
    if (!info) return [];
    if (rankVal === 2) return info.eigen.real;
    return info.eigen.real.filter((e) => Math.abs(e.value) > 1e-9);
  }, [info, rankVal]);

  const svgRef = useRef<SVGSVGElement>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const dragRef = useRef<Handle | null>(null);

  /**
   * 可以拖的点。
   *
   * **只有把矩阵元素写成参数名时才画手柄。** 拖动要把坐标写回去,而元素是表达式
   * (`cos(t)`、`2*a`)—— 复合表达式没法从坐标反解出参数。所以这里只认"元素恰好
   * 就是一个参数名"的情形。
   *
   * 这不是妥协,反而对得上:能拖的时候,拖出来的值**就是**参数的值 ——
   * 模型 read_artifact 看到的 runtime 和学生屏幕上的是同一个数,不会出现两套真相。
   */
  const handles = useMemo<Handle[]>(() => {
    if (!m) return [];
    const params = spec.params ?? [];
    /** 元素表达式恰好就是一个参数名时,才找得到可写的那个参数。 */
    const named = (e: string) => params.find((p) => p.name === e.trim());
    const out: Handle[] = [];

    // 基向量的像。拖它就是直接摆出"矩阵的这一列去了哪儿"。
    const column = (name: string, c: 0 | 1): Handle | null => {
      const px = named(spec.matrix[0][c]);
      const py = named(spec.matrix[1][c]);
      if (!px || !py) return null;
      return {
        name,
        cls: 'lin-handle',
        hint: `拖我 —— 直接摆出基向量 ${name} 的像,矩阵跟着变`,
        px,
        py,
        at: apply(m, c === 0 ? [1, 0] : [0, 1]),
      };
    };
    const i = column('i', 0);
    const j = column('j', 1);
    if (i) out.push(i);
    if (j) out.push(j);

    // 探测向量。拖它是找零空间那条路:把 v 拖到某个方向上、Av 缩成 0,就说明
    // 那个方向被压没了 —— 这正是"拖动输入向量 → 零空间显现"。
    if (spec.probe) {
      const px = named(spec.probe.x);
      const py = named(spec.probe.y);
      const at: Vec2 = [safeEval(spec.probe.x, scope), safeEval(spec.probe.y, scope)];
      if (px && py && at.every(Number.isFinite)) {
        out.push({
          name: 'v',
          cls: 'lin-handle probe',
          hint: '拖我 —— 移动探测向量,看 Av 怎么跟着变。把它拖到 Av 缩成 0 的方向上,那条线就是零空间',
          px,
          py,
          at,
        });
      }
    }
    return out;
  }, [m, spec.matrix, spec.params, spec.probe, scope]);

  /** 屏幕坐标 → 数学坐标。和 Plot2D 里那套换算一致(viewBox 与元素尺寸不一定相等)。 */
  const toMath = (clientX: number, clientY: number): Vec2 | null => {
    const el = svgRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const vx = (clientX - rect.left) * (w / rect.width);
    const vy = (clientY - rect.top) * (HEIGHT / rect.height);
    return [
      view.x[0] + ((vx - PAD.l) / plotW) * (view.x[1] - view.x[0]),
      view.y[0] + (1 - (vy - PAD.t) / plotH) * (view.y[1] - view.y[0]),
    ];
  };

  const startDrag = (e: React.PointerEvent<SVGCircleElement>, h: Handle) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = h;
    setDragging(h.name);
  };

  const moveDrag = (e: React.PointerEvent<SVGCircleElement>) => {
    const h = dragRef.current;
    if (!h) return;
    const p = toMath(e.clientX, e.clientY);
    if (!p) return;
    // 连续写参数,和拖滑块走同一条路 —— 拖的过程中就要看见平面在扭
    onParam(h.px.name, clampTo(h.px, p[0]));
    onParam(h.py.name, clampTo(h.py, p[1]));
  };

  const endDrag = (e: React.PointerEvent<SVGCircleElement>) => {
    const h = dragRef.current;
    dragRef.current = null;
    setDragging(null);
    if (!h) return;
    const p = toMath(e.clientX, e.clientY);
    if (!p) return;
    // 松手才发事件 —— 拖一次发几百条会把上下文撑爆(和滑块同一个约定)
    emit({
      type: 'pointDrag',
      artifactId,
      point: h.name,
      xy: [clampTo(h.px, p[0]), clampTo(h.py, p[1])],
    });
  };

  const clipId = `lin-clip-${artifactId}`;

  return (
    <div className="linear" ref={wrapRef}>
      {spec.note && <div className="plot-note">{spec.note}</div>}

      <svg ref={svgRef} viewBox={`0 0 ${w} ${HEIGHT}`} width="100%" height={HEIGHT} className="plot-svg">
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
            {eigenLines.map((e, i) => {
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

            {/* 零空间:整个被压到原点的那些方向。满秩时只有原点自己,没什么可画的。 */}
            {ns?.kind === 'line' && (
              <line
                x1={tx(ns.dir[0] * -1e3)}
                y1={ty(ns.dir[1] * -1e3)}
                x2={tx(ns.dir[0] * 1e3)}
                y2={ty(ns.dir[1] * 1e3)}
                className="lin-null"
              />
            )}

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
            {/* 可以拖的点。画在最后 —— 它是交互入口,不该被任何一条线压住。
                只有对应的矩阵元素/探测向量写成参数名时才画得出来,见 handles 那段说明。 */}
            {handles.map((h) => (
              <circle
                key={h.name}
                cx={clampCoord(tx(h.at[0]))}
                cy={clampCoord(ty(h.at[1]))}
                r={9}
                className={dragging === h.name ? `${h.cls} on` : h.cls}
                onPointerDown={(e) => startDrag(e, h)}
                onPointerMove={moveDrag}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
              >
                <title>{h.hint}</title>
              </circle>
            ))}
          </g>
        )}

        <PlaneAxes view={view} tx={tx} ty={ty} plotW={plotW} plotH={plotH} />
      </svg>

      {m && info && rankVal !== null && ns ? (
        <MatrixPanel m={m} d={info.det} eigen={info.eigen} rank={rankVal} nullSpace={ns} />
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

/** 矩阵本身、行列式、秩、零空间、特征值 —— 学生要能把图上的现象和数字对上。 */
function MatrixPanel({
  m,
  d,
  eigen: eig,
  rank: rk,
  nullSpace: ns,
}: {
  m: Mat2;
  d: number;
  eigen: ReturnType<typeof eigen>;
  rank: 0 | 1 | 2;
  nullSpace: NullSpace;
}) {
  const fmt = (n: number) => (Math.abs(n) < 1e-10 ? '0' : String(Number(n.toPrecision(4))));
  // 和 matrix2 里用**同一个**判据。两处各写一个阈值的话,迟早出现
  // "面板说不可逆、图上却画着满秩的网格"这种自相矛盾。
  const degenerate = isSingular(m);

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

        <div className={degenerate ? 'lin-fact warn' : 'lin-fact'}>
          <span className="lin-fact-name">秩</span>
          <span className="lin-fact-value">{rk}</span>
          <span className="lin-fact-note">
            {rk === 2
              ? '满秩:平面还是平面'
              : rk === 1
                ? '像空间只剩一条过原点的直线 —— 有一个方向被整个压没了'
                : '零矩阵:整个平面都被映到原点'}
          </span>
        </div>

        {rk === 1 && (ns.kind === 'line' || ns.kind === 'plane') && (
          <div className="lin-fact warn">
            <span className="lin-fact-name">零空间</span>
            <span className="lin-fact-value">一条线</span>
            <span className="lin-fact-note">
              图上那条虚线:落在它上面的向量全被映到原点。
              <strong>它同时也是 λ=0 的那个特征方向</strong> —— 特征值等于 0
              说的正是"这个方向被压没了"。秩 1 + 零化度 1 = 2:
              平面本来有两个方向,一个留着,一个没了。
            </span>
          </div>
        )}

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
