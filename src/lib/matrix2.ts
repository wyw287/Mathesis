/**
 * 2×2 矩阵的线性代数。
 *
 * 这一层存在的理由是**分工**:让模型算变换后的网格、行列式、特征向量,全是它
 * 容易写错的地方,而且写错了学生看不出来。所以模型只写矩阵的四个元素,
 * 几何结果全在这里算。
 *
 * 纯函数,所以能在 node 里逐条验证 —— 特征向量那种东西,"看起来对"和
 * "真的对"差得很远。
 */

/** 按行存放:[a b; c d]。和数学写法一致,少一层转置的心智负担。 */
export interface Mat2 {
  a: number;
  b: number;
  c: number;
  d: number;
}

export type Vec2 = [number, number];

/** 行列式。几何上是**面积的缩放倍数** —— 带符号,负号表示翻转了定向。 */
export function det(m: Mat2): number {
  return m.a * m.d - m.b * m.c;
}

export function apply(m: Mat2, v: Vec2): Vec2 {
  return [m.a * v[0] + m.b * v[1], m.c * v[0] + m.d * v[1]];
}

export function trace(m: Mat2): number {
  return m.a + m.d;
}

export interface Eigen {
  value: number;
  /** 单位特征向量。方向不变的那条线。 */
  vector: Vec2;
}

export interface EigenResult {
  /** 实特征值(可能 0、1、2 个)。判别式小于零时为空 —— 那是旋转,没有实特征方向。 */
  real: Eigen[];
  /** 判别式为负:只有复特征值,平面上没有不被转向的方向 */
  complex: boolean;
  /**
   * `A − λI` 整个是零矩阵 —— 也就是**纯缩放**,平面上每个方向都是特征方向。
   *
   * 这种情况必须单独标出来。随便画一条线当作"特征方向"是在教错东西:
   * 学生会以为只有那一个方向不变,实际上所有方向都不变。
   */
  allDirections: boolean;
}

/**
 * 特征分解。
 *
 * 2×2 有闭式解,不需要 CAS:判别式 `tr² − 4·det` 定出实数还是复数,
 * 特征向量解 `(A − λI)v = 0` 就得到。
 *
 * **判别式小于零是重要情形**,不能糊弄过去:那说明这个变换是"带旋转的",
 * 平面上没有任何一条线方向不变。硬凑一个实数出来会教错东西。
 */
export function eigen(m: Mat2): EigenResult {
  const tr = trace(m);
  const d = det(m);
  const disc = tr * tr - 4 * d;

  if (disc < -1e-12) return { real: [], complex: true, allDirections: false };

  const sq = Math.sqrt(Math.max(0, disc));
  // 判别式为零时两个根重合,只报一个
  const values = sq < 1e-12 ? [tr / 2] : [(tr + sq) / 2, (tr - sq) / 2];

  const real: Eigen[] = [];
  let allDirections = false;
  for (const value of values) {
    const vector = eigenvectorFor(m, value);
    if (vector) real.push({ value, vector });
    // 这个根下 A − λI 是零矩阵 ⇒ 纯缩放 ⇒ 每个方向都是特征方向
    if (isScalarResidual(m, value)) allDirections = true;
  }
  return { real, complex: false, allDirections };
}

/** A − λI 是不是(数值上)零矩阵。用矩阵自身的量级做相对判据。 */
function isScalarResidual(m: Mat2, lambda: number): boolean {
  const p = m.a - lambda;
  const q = m.b;
  const r = m.c;
  const s = m.d - lambda;
  const scale = Math.max(1, Math.abs(m.a), Math.abs(m.b), Math.abs(m.c), Math.abs(m.d));
  return Math.max(Math.abs(p), Math.abs(q), Math.abs(r), Math.abs(s)) < 1e-9 * scale;
}

/**
 * 解 (A − λI)v = 0。
 *
 * 两行各自给出一个候选方向,取**较长的那一个** —— 退化时(比如某个元素恰好为零)
 * 短的那个可能几乎是零向量,用它算出的方向全是数值噪声。
 */
function eigenvectorFor(m: Mat2, lambda: number): Vec2 | null {
  const p = m.a - lambda;
  const q = m.b;
  const r = m.c;
  const s = m.d - lambda;

  // 第一行:p·x + q·y = 0 → (q, −p);第二行同理解出 (s, −r)
  const first: Vec2 = [q, -p];
  const second: Vec2 = [s, -r];
  const pick = Math.hypot(...first) >= Math.hypot(...second) ? first : second;
  const len = Math.hypot(...pick);
  if (len < 1e-9) {
    // 两个候选都退化成零向量。纯缩放阵就是这样 —— 每个方向都行,
    // 所以随便取一个固定方向。返回 null 会让界面上凭空少掉一个特征方向。
    return isScalarResidual(m, lambda) ? [1, 0] : null;
  }
  return [pick[0] / len, pick[1] / len];
}

/** 变换后单位正方形的四个顶点 —— 它围出的面积就是 |det|。 */
export function unitSquareImage(m: Mat2): [Vec2, Vec2, Vec2, Vec2] {
  return [
    apply(m, [0, 0]),
    apply(m, [1, 0]),
    apply(m, [1, 1]),
    apply(m, [0, 1]),
  ];
}
