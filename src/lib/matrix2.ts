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

/**
 * 是不是退化(不可逆)。
 *
 * 判据用**相对量级**,不是拿一个绝对的 1e-9 去比行列式:行列式随元素**平方**缩放,
 * 所以元素量级 1e6 的一张好矩阵,det 轻松上 1e12;而元素全是 1e-6 的一张好矩阵,
 * det 只有 1e-12 —— 用绝对阈值会把后者误判成退化。
 *
 * 界面上"det 是不是 0"和"秩是不是 2"必须用同一个判据,否则会出现
 * "面板说不可逆、图上却画着满秩的网格"这种自相矛盾。
 */
export function isSingular(m: Mat2): boolean {
  const scale = Math.max(Math.abs(m.a), Math.abs(m.b), Math.abs(m.c), Math.abs(m.d));
  if (scale === 0) return true;
  return Math.abs(det(m)) < 1e-9 * scale * scale;
}

/**
 * 秩 = **像空间的维数**。
 *
 * 2×2 只有三种:2(满秩,平面还是平面)、1(整个平面被压到一条过原点的直线)、
 * 0(零矩阵,一切都塌到原点)。
 */
export function rank(m: Mat2): 0 | 1 | 2 {
  const scale = Math.max(Math.abs(m.a), Math.abs(m.b), Math.abs(m.c), Math.abs(m.d));
  if (scale === 0) return 0;
  return isSingular(m) ? 1 : 2;
}

export type NullSpace =
  /** 满秩:只有零向量自己被映到原点 */
  | { kind: 'point' }
  /** 零矩阵:整个平面都被映到原点 */
  | { kind: 'plane' }
  /** 秩 1:一条过原点的直线被映到原点 */
  | { kind: 'line'; dir: Vec2 };

/**
 * 零空间:被 A 映到原点的那些向量。
 *
 * `(b, −a)` 和 `(d, −c)` 都是候选:A·(b,−a) = (ab−ab, cb−ad),而退化时 ad = bc,
 * 所以它确实是零。两行各自给一个候选,**取长的那个** —— 某一行恰好是零行时,
 * 它给出的候选是零向量,拿它算方向全是数值噪声(和特征向量那边同一个坑)。
 */
export function nullSpace(m: Mat2): NullSpace {
  const r = rank(m);
  if (r === 2) return { kind: 'point' };
  if (r === 0) return { kind: 'plane' };

  const candidates: Vec2[] = [
    [m.b, -m.a],
    [m.d, -m.c],
  ];
  const pick = candidates.reduce((best, v) =>
    Math.hypot(...v) > Math.hypot(...best) ? v : best,
  );
  const len = Math.hypot(...pick);
  if (len < 1e-12) return { kind: 'plane' };
  return { kind: 'line', dir: [pick[0] / len, pick[1] / len] };
}
