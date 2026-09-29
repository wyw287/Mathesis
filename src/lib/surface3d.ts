/**
 * 3D 曲面的网格采样。
 *
 * 和 2D 的网格采样是同一件事再加一维:铺二维参数网格,每个格点算一个三维点,
 * 相邻四点连成一个四边形。区别只在输出 —— 2D 吐线段或箭头,这里吐三角面。
 *
 * 隐式曲面 F(x,y,z)=0 不在这里,那需要 marching cubes(256 种情形、约 15 种歧义,
 * 而且经典情形表是已知有洞的),是独立课题。
 */
import { finiteRange } from './math';
import type { Vec3 } from './scene3d';

export interface Mesh {
  verts: Vec3[];
  /** 四边形,索引指向 verts。渲染时拆成两个三角形。 */
  quads: [number, number, number, number][];
  /** z 的实际取值范围,渲染配色用 */
  zRange: [number, number];
}

/**
 * 二维参数网格 → 四边形网格。
 *
 * `at` 返回 null(或含非有限分量)表示该点无定义,索引记为 -1,
 * **相关格子整块丢掉** —— 硬凑会画出一片凭空的曲面,而"这里没定义"本身是信息。
 */
function gridMesh(
  cols: number,
  rows: number,
  at: (i: number, j: number) => Vec3 | null,
): Mesh {
  const stride = cols + 1;
  const index = new Int32Array(stride * (rows + 1)).fill(-1);
  const verts: Vec3[] = [];

  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i <= cols; i++) {
      const p = at(i, j);
      if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || !Number.isFinite(p[2])) continue;
      index[j * stride + i] = verts.length;
      verts.push(p);
    }
  }

  const quads: [number, number, number, number][] = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const a = index[j * stride + i]!;
      const b = index[j * stride + i + 1]!;
      const c = index[(j + 1) * stride + i + 1]!;
      const d = index[(j + 1) * stride + i]!;
      if (a < 0 || b < 0 || c < 0 || d < 0) continue;
      quads.push([a, b, c, d]);
    }
  }

  return { verts, quads, zRange: zBounds(verts) };
}

function zBounds(verts: Vec3[]): [number, number] {
  return finiteRange(verts.map((v) => v[2])) ?? [-1, 1];
}

/** 取排序后某个分位的值。 */
function percentile(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))]!;
}

/**
 * 高度图 z = f(x, y)。
 *
 * **z 会按 1%~99% 分位截断。** 理由和 2D 的自动 y 范围一样:遇到 1/(x*y)
 * 这种在网格上取到极大值的点,min/max 会被那个尖峰拉走,整张曲面压成一块平板。
 * 截断的代价是尖峰变成小平台 —— 比什么都看不见要好。
 */
export function sampleHeightMap(
  value: (x: number, y: number) => number,
  xRange: [number, number],
  yRange: [number, number],
  resolution: number,
): Mesh {
  const cols = resolution;
  const rows = resolution;
  const [x0, x1] = xRange;
  const [y0, y1] = yRange;

  const raw = new Float64Array((cols + 1) * (rows + 1));
  const finite: number[] = [];
  for (let j = 0; j <= rows; j++) {
    const y = y0 + ((y1 - y0) * j) / rows;
    for (let i = 0; i <= cols; i++) {
      const z = value(x0 + ((x1 - x0) * i) / cols, y);
      raw[j * (cols + 1) + i] = z;
      if (Number.isFinite(z)) finite.push(z);
    }
  }

  let clampLo = -Infinity;
  let clampHi = Infinity;
  if (finite.length > 20) {
    finite.sort((a, b) => a - b);
    const lo = finite[0]!;
    const hi = finite[finite.length - 1]!;
    let p1 = percentile(finite, 0.01);
    let p99 = percentile(finite, 0.99);
    if (!(p99 > p1)) {
      p1 = lo;
      p99 = hi;
    }
    // **只在真有离群值时才截断。**
    // 无条件按分位截断会把 x*y 这种本来没有尖峰的曲面也削掉 10% 的极值,
    // 四角被压平 —— 那是凭空引入的失真。判据是"尾部长得比主体还长",
    // 那才是尖峰的特征;普通的平滑曲面尾部很短,不会被误伤。
    const span = p99 - p1;
    if (span > 0) {
      if (hi - p99 > span) clampHi = p99;
      if (p1 - lo > span) clampLo = p1;
    }
  }

  const mesh = gridMesh(cols, rows, (i, j) => {
    const z = raw[j * (cols + 1) + i]!;
    if (!Number.isFinite(z)) return null;
    return [
      x0 + ((x1 - x0) * i) / cols,
      y0 + ((y1 - y0) * j) / rows,
      Math.min(clampHi, Math.max(clampLo, z)),
    ];
  });

  return mesh;
}

/** 参数曲面 (u, v) → (x, y, z)。球面、环面、旋转体都是这一种。 */
export function sampleParametricSurface(
  point: (u: number, v: number) => Vec3,
  uRange: [number, number],
  vRange: [number, number],
  resolution: number,
): Mesh {
  const cols = resolution;
  const rows = resolution;
  const [u0, u1] = uRange;
  const [v0, v1] = vRange;
  return gridMesh(cols, rows, (i, j) => {
    const u = u0 + ((u1 - u0) * i) / cols;
    const v = v0 + ((v1 - v0) * j) / rows;
    return point(u, v);
  });
}
