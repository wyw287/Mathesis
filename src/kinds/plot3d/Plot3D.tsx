import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { safeEval } from '../../lib/math';
import {
  DEFAULT_CAMERA,
  clampPitch,
  fitCamera,
  project,
  viewBasis,
  type Camera,
  type Vec3,
} from '../../lib/scene3d';
import { ParamSliders } from '../../renderers/ParamSliders';
import { sampleHeightMap, sampleParametricSurface, type Mesh } from '../../lib/surface3d';
import type { CanvasEvent, Plot3DSpec } from '../../types/artifact';

const HEIGHT = 460;
/** 视场角刻意小:接近正交投影,曲面形状不容易被透视扭曲,深度感又还在。 */
const FOV = Math.PI / 7;

interface Props {
  spec: Plot3DSpec;
  scope: Record<string, number>;
  artifactId: string;
  rev: number;
  onParam: (name: string, value: number) => void;
  emit: (e: CanvasEvent) => void;
}

export function Plot3D({ spec, scope, artifactId, rev, onParam, emit }: Props) {
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const mesh = useMemo<Mesh>(() => {
    const res = Math.round(Math.min(90, Math.max(8, spec.resolution ?? 44)));
    if (spec.surface.type === 'height') {
      const { expr, over } = spec.surface;
      return sampleHeightMap((x, y) => safeEval(expr, { ...scope, x, y }), over.x, over.y, res);
    }
    const s = spec.surface;
    return sampleParametricSurface(
      (u, v) => [
        safeEval(s.x, { ...scope, u, v }),
        safeEval(s.y, { ...scope, u, v }),
        safeEval(s.z, { ...scope, u, v }),
      ],
      s.over.u,
      s.over.v,
      res,
    );
  }, [spec.surface, spec.resolution, scope]);

  const initialCamera = useCallback((): Camera => {
    const fit = fitCamera(mesh.verts, FOV, Math.max(0.5, (width - 24) / HEIGHT));
    return {
      ...DEFAULT_CAMERA,
      ...fit,
      fov: FOV,
      yaw: spec.view?.yaw !== undefined ? (spec.view.yaw * Math.PI) / 180 : DEFAULT_CAMERA.yaw,
      pitch:
        spec.view?.pitch !== undefined
          ? clampPitch((spec.view.pitch * Math.PI) / 180)
          : DEFAULT_CAMERA.pitch,
    };
  }, [mesh.verts, spec.view?.yaw, spec.view?.pitch, width]);

  const [cam, setCam] = useState<Camera>(initialCamera);

  // 只在**内容被改过**(rev 变)时重置视角。拖滑块会让 mesh 变,但那不该把
  // 学生刚转好的角度弹回初始值 —— 那正是他看这个曲面最顺眼的角度。
  useEffect(() => {
    setCam(initialCamera());
    // eslint 之外:这里刻意只依赖 rev,mesh 是新一次渲染的闭包值
  }, [rev]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw(ctx, mesh, cam, { w, h }, spec.wireframe ?? true);
  }, [mesh, cam, spec.wireframe, width]);

  // ---- 交互:拖动转视角,滚轮缩放 ----
  const drag = useRef<{ x: number; y: number } | null>(null);
  const moved = useRef(false);
  const orbitTimer = useRef<number | undefined>(undefined);

  const reportOrbit = () => {
    window.clearTimeout(orbitTimer.current);
    orbitTimer.current = window.setTimeout(() => emit({ type: 'orbit', artifactId }), 450);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    drag.current = { x: e.clientX, y: e.clientY };
    moved.current = false;
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drag.current) return;
    const dx = e.clientX - drag.current.x;
    const dy = e.clientY - drag.current.y;
    drag.current = { x: e.clientX, y: e.clientY };
    if (Math.abs(dx) + Math.abs(dy) > 0) moved.current = true;
    setCam((c) => ({
      ...c,
      yaw: c.yaw - dx * 0.01,
      pitch: clampPitch(c.pitch + dy * 0.01),
    }));
  };

  const onPointerUp = () => {
    drag.current = null;
    // 只在真的转过的时候上报 —— 点一下不该算"转动了视角"
    if (moved.current) reportOrbit();
  };

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      setCam((c) => ({ ...c, distance: Math.min(60, Math.max(0.2, c.distance * Math.exp(ev.deltaY * 0.0012))) }));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  return (
    <div className="plot3d" ref={wrapRef}>
      {spec.note && <div className="plot-note">{spec.note}</div>}
      <canvas
        ref={canvasRef}
        className="plot3d-canvas"
        style={{ width: '100%', height: HEIGHT }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />
      <div className="plot-footer">
        <span className="hint">拖动旋转 · 滚轮缩放</span>
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

// ------------------------------------------------------------------ 绘制

interface Face {
  verts: { x: number; y: number }[];
  depth: number;
  z: number;
  brightness: number;
}

/**
 * painter's algorithm:按深度从远到近画。
 *
 * 没有深度缓冲,所以自相遮挡的曲面可能有伪影 —— 这是手写渲染器的已知取舍。
 * 对函数图像和参数曲面,按面片平均深度排序在实践中够用。
 */
function draw(
  ctx: CanvasRenderingContext2D,
  mesh: Mesh,
  cam: Camera,
  viewport: { w: number; h: number },
  wireframe: boolean,
): void {
  const { w, h } = viewport;
  ctx.clearRect(0, 0, w, h);

  if (!mesh.quads.length) {
    ctx.fillStyle = '#98948c';
    ctx.font = '13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('这个范围内没有可显示的部分', w / 2, h / 2);
    return;
  }

  const basis = viewBasis(cam);
  const proj = mesh.verts.map((p) => project(p, cam, viewport));

  // 光从相机左上后方来。用绝对值点积,所以背面不会黑掉 ——
  // 没有背面剔除,两面都可能被看到。
  const light: Vec3 = [
    basis.right[0] * -0.45 + basis.up[0] * 0.75 + basis.toward[0] * 0.5,
    basis.right[1] * -0.45 + basis.up[1] * 0.75 + basis.toward[1] * 0.5,
    basis.right[2] * -0.45 + basis.up[2] * 0.75 + basis.toward[2] * 0.5,
  ];
  const lightLen = Math.hypot(...light) || 1;
  light[0] /= lightLen;
  light[1] /= lightLen;
  light[2] /= lightLen;

  const faces: Face[] = [];
  for (const q of mesh.quads) {
    const ps = q.map((i) => proj[i]!);
    // 任一点在相机后面就丢掉这个面 —— 投影已经发散,画出来是垃圾
    if (ps.some((p) => !Number.isFinite(p.x) || p.depth <= 0)) continue;

    const a = mesh.verts[q[0]!]!;
    const b = mesh.verts[q[1]!]!;
    const d = mesh.verts[q[3]!]!;
    const n = normalize(cross(sub3(b, a), sub3(d, a)));

    faces.push({
      verts: ps.map((p) => ({ x: p.x, y: p.y })),
      depth: (ps[0]!.depth + ps[1]!.depth + ps[2]!.depth + ps[3]!.depth) / 4,
      z: (a[2] + b[2] + mesh.verts[q[2]!]![2] + d[2]) / 4,
      brightness: 0.62 + 0.55 * Math.abs(dot3(n, light)),
    });
  }

  faces.sort((p, q) => q.depth - p.depth);

  ctx.lineJoin = 'round';
  for (const f of faces) {
    ctx.beginPath();
    ctx.moveTo(f.verts[0]!.x, f.verts[0]!.y);
    for (let i = 1; i < f.verts.length; i++) ctx.lineTo(f.verts[i]!.x, f.verts[i]!.y);
    ctx.closePath();
    ctx.fillStyle = surfaceColor(f.z, mesh.zRange, f.brightness);
    ctx.fill();
    if (wireframe) {
      ctx.strokeStyle = 'rgba(255,255,255,0.28)';
      ctx.lineWidth = 0.5;
      ctx.stroke();
    }
  }

  drawAxes(ctx, mesh, cam, viewport);
}

/**
 * 按高度配色。
 *
 * 跨过零点时用**发散配色**(负蓝正红),因为那正是马鞍面、极值这类图形最需要
 * 一眼看出来的东西;不跨零点时用**顺序配色**。
 *
 * 这一点很重要:对 z = x² + y² 用发散配色会暗示一个并没有的零点。
 */
function surfaceColor(z: number, range: [number, number], brightness: number): string {
  const [lo, hi] = range;
  const straddles = lo < 0 && hi > 0;
  let rgb: [number, number, number];

  if (straddles) {
    const scale = Math.max(Math.abs(lo), Math.abs(hi)) || 1;
    const t = Math.min(1, Math.abs(z) / scale);
    const end: [number, number, number] = z >= 0 ? [220, 38, 38] : [37, 99, 235];
    rgb = mix([246, 245, 242], end, t);
  } else {
    const t = hi > lo ? Math.min(1, Math.max(0, (z - lo) / (hi - lo))) : 0.5;
    rgb = mix([219, 234, 254], [30, 64, 175], t);
  }

  const clamp = (c: number) => Math.max(0, Math.min(255, Math.round(c * brightness)));
  return `rgb(${clamp(rgb[0])}, ${clamp(rgb[1])}, ${clamp(rgb[2])})`;
}

const mix = (a: [number, number, number], b: [number, number, number], t: number): [number, number, number] => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/** 三条坐标轴,从原点出发。原点不在画面里时它们只是伸出去,那本身也是信息。 */
function drawAxes(
  ctx: CanvasRenderingContext2D,
  mesh: Mesh,
  cam: Camera,
  viewport: { w: number; h: number },
): void {
  const len = Math.max(1, Math.max(...mesh.verts.map((v) => Math.hypot(...v))) * 1.15);
  const axes: [Vec3, string][] = [
    [[len, 0, 0], 'x'],
    [[0, len, 0], 'y'],
    [[0, 0, len], 'z'],
  ];

  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(120,116,108,0.55)';
  ctx.fillStyle = '#6f6b64';
  ctx.font = '12px ui-monospace, monospace';
  ctx.textAlign = 'center';

  const o = project([0, 0, 0], cam, viewport);
  for (const [end, label] of axes) {
    const e = project(end, cam, viewport);
    if (!Number.isFinite(o.x) || !Number.isFinite(e.x)) continue;
    ctx.beginPath();
    ctx.moveTo(o.x, o.y);
    ctx.lineTo(e.x, e.y);
    ctx.stroke();
    ctx.fillText(label, e.x, e.y - 4);
  }
}

const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot3 = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function normalize(v: Vec3): Vec3 {
  const n = Math.hypot(...v);
  return n > 1e-12 ? [v[0] / n, v[1] / n, v[2] / n] : [0, 0, 1];
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
