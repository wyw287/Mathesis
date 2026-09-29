/**
 * 3D 相机与投影。
 *
 * 刻意不引 three.js:一来这个项目到现在只有 katex / mathjs / react / zustand
 * 四个依赖;二来**这一层是纯数学,可以测** —— 而 WebGL 在这个环境里我一行都
 * 验证不了。投影点的位置、旋转基的正交性、深度排序的单调性,这些都是能写断言的。
 *
 * 相机是绕 z 轴的轨道式(z 朝上,符合数学习惯):yaw 转圈,pitch 抬升,
 * distance 拉近拉远。默认给一个略高的斜视角,能同时看到三个坐标轴。
 */
export type Vec3 = [number, number, number];

export interface Camera {
  /** 绕 z 轴旋转,弧度 */
  yaw: number;
  /** 抬升角,弧度。0 = 平视,π/2 = 正上方俯视 */
  pitch: number;
  distance: number;
  target: Vec3;
  /** 垂直视场角,弧度。小一点接近正交投影,曲面形状更不容易被透视扭曲 */
  fov: number;
}

export interface Projected {
  x: number;
  y: number;
  /** 到相机的距离。**越大越远** —— 排序时按它从大到小画(painter's algorithm) */
  depth: number;
}

export interface Basis {
  /** 屏幕向右对应的世界方向 */
  right: Vec3;
  /** 屏幕向上对应的世界方向 */
  up: Vec3;
  /** 从场景指向相机的方向 */
  toward: Vec3;
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/**
 * 相机的三个基向量。
 *
 * `right` 只依赖 yaw,不依赖 pitch —— 这样正上方俯视(pitch=π/2)时也不会遇到
 * 万向锁:那时 `up` 会退化成一个水平方向,但仍然良定义。
 */
export function viewBasis(cam: Camera): Basis {
  const cy = Math.cos(cam.yaw);
  const sy = Math.sin(cam.yaw);
  const cp = Math.cos(cam.pitch);
  const sp = Math.sin(cam.pitch);
  return {
    toward: [cp * cy, cp * sy, sp],
    right: [-sy, cy, 0],
    up: [-sp * cy, -sp * sy, cp],
  };
}

/**
 * 把世界坐标投到屏幕。
 *
 * 焦点长度由视场角和画布高度决定;`depth <= 0` 表示点在相机后面,
 * 调用方应当丢弃(返回的 depth 会 <= 0,据此判断)。
 */
export function project(
  p: Vec3,
  cam: Camera,
  viewport: { w: number; h: number },
): Projected {
  const rel = sub(p, cam.target);
  const b = viewBasis(cam);
  const sx = dot(rel, b.right);
  const su = dot(rel, b.up);
  const forward = dot(rel, b.toward);
  const depth = cam.distance - forward;

  const focal = viewport.h / 2 / Math.tan(cam.fov / 2);
  if (depth <= 1e-6) return { x: NaN, y: NaN, depth };

  return {
    x: viewport.w / 2 + (sx * focal) / depth,
    y: viewport.h / 2 - (su * focal) / depth,
    depth,
  };
}

/** 一组点的包围盒中心与半径。用来把相机自动拉开到刚好装下整个曲面。 */
export function boundsOf(points: Vec3[]): { center: Vec3; radius: number } {
  if (!points.length) return { center: [0, 0, 0], radius: 1 };
  let lo: Vec3 = [Infinity, Infinity, Infinity];
  let hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of points) {
    for (let k = 0; k < 3; k++) {
      if (p[k]! < lo[k]!) lo[k] = p[k]!;
      if (p[k]! > hi[k]!) hi[k] = p[k]!;
    }
  }
  const center: Vec3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  const radius = Math.max(1e-6, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2);
  return { center, radius };
}

/**
 * 把相机拉到刚好装下这组点。
 *
 * 留一倍余量:贴着边缘的曲面看起来是满的,但没有呼吸空间,轴标签也会被切掉。
 */
export function fitCamera(
  points: Vec3[],
  fov: number,
  aspect: number,
): { target: Vec3; distance: number } {
  const { center, radius } = boundsOf(points);
  const half = fov / 2;
  // 宽高比小于 1 时竖直方向更紧,要按较紧的那个方向算
  const vertical = radius / Math.sin(half);
  const horizontal = aspect >= 1 ? vertical : radius / Math.sin(half * aspect);
  return { target: center, distance: Math.max(vertical, horizontal) * 1.15 };
}

export const DEFAULT_CAMERA: Camera = {
  yaw: (-3 * Math.PI) / 4,
  pitch: Math.PI / 7,
  distance: 4,
  target: [0, 0, 0],
  fov: Math.PI / 7,
};

/** 把 pitch 夹在正负 89° 内 —— 正好到 90° 时屏幕向上方向会退化,画面会翻。 */
export function clampPitch(pitch: number): number {
  const lim = (89 * Math.PI) / 180;
  return Math.min(lim, Math.max(-lim, pitch));
}
