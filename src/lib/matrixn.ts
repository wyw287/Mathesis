/**
 * 一般 m×n 数值矩阵的代数。
 *
 * 和 `matrix2.ts` 分开,是因为它们回答的是不同的问题:`matrix2` 是**2×2 的几何**
 * (行列式的面积含义、特征方向),这里是**任意尺寸的代数**(乘法、转置、行列式、逆)。
 *
 * 两边都只吃数字、只吐数字 —— 表达式的求值不在这里(那是工具层和渲染器的事)。
 * 分开还有个好处:这一层能在 node 里逐条验,而"逆矩阵算错了"从画面上根本看不出来 ——
 * 它长得就是个矩阵。
 */

export type Matrix = number[][];

/** 矩阵的规模上限。模型可以随口写一个 50×50,而画布上放不下,也不该为它跑 O(n³)。 */
export const MAX_DIM = 6;

export function isSquare(m: Matrix): boolean {
  return m.length > 0 && m.every((row) => row.length === m.length);
}

export function transpose(m: Matrix): Matrix {
  if (!m.length || !m[0].length) return [];
  return m[0].map((_, j) => m.map((row) => row[j] ?? 0));
}

/** A·B。维数配不上返回 `null` —— 调用方据此明说"不能相乘",而不是编一个数出来。 */
export function multiply(a: Matrix, b: Matrix): Matrix | null {
  if (!a.length || !b.length || !a[0].length || !b[0].length) return null;
  const inner = a[0].length;
  const cols = b[0].length;
  if (b.length !== inner) return null;
  if (a.some((r) => r.length !== inner) || b.some((r) => r.length !== cols)) return null;

  return a.map((row) =>
    Array.from({ length: cols }, (_, j) =>
      row.reduce((sum, v, k) => sum + v * (b[k]?.[j] ?? 0), 0),
    ),
  );
}

/** 矩阵里最大的绝对值。用来把"是不是零"的判据做成**相对**的。 */
function magnitude(m: Matrix): number {
  let mx = 0;
  for (const row of m) for (const v of row) if (Math.abs(v) > mx) mx = Math.abs(v);
  return mx;
}

/**
 * 行列式。LU 分解,带部分主元。
 *
 * 用消元而不是代数余子式展开:展开是 O(n!),而模型随手就能给一个 5×5;
 * 消元是 O(n³),而且"主元为零 ⇒ 奇异"这个结论是直接读出来的。
 *
 * 零的判据是**相对**的(拿最大元素做尺度)。绝对阈值会让一张元素全在 1e-6 量级
 * 的正经满秩矩阵被当成奇异的 —— 和 `matrix2.isSingular` 同一个道理。
 */
export function determinant(m: Matrix): number | null {
  if (!isSquare(m)) return null;
  const n = m.length;
  const scale = magnitude(m);
  if (scale === 0) return 0;
  const tol = 1e-12 * scale;

  const a = m.map((row) => [...row]);
  let d = 1;
  for (let k = 0; k < n; k++) {
    // 部分主元:把该列绝对值最大的行换上来。不换的话小主元会把误差放大到离谱。
    let piv = k;
    for (let i = k + 1; i < n; i++) {
      if (Math.abs(a[i][k]) > Math.abs(a[piv][k])) piv = i;
    }
    if (Math.abs(a[piv][k]) < tol) return 0;
    if (piv !== k) {
      [a[k], a[piv]] = [a[piv], a[k]];
      d = -d; // 换行翻转定向,而行列式是**带符号**的
    }
    d *= a[k][k];
    for (let i = k + 1; i < n; i++) {
      const f = a[i][k] / a[k][k];
      for (let j = k; j < n; j++) a[i][j] -= f * a[k][j];
    }
  }
  return d;
}

/**
 * 逆矩阵。Gauss-Jordan:把 `[A | I]` 消成 `[I | A⁻¹]`。不可逆返回 `null`。
 *
 * 返回 `null` 而不是抛:不可逆是**正常的数学情形**(而且正是要讲给学生听的那种),
 * 不是错误。调用方据此显示"不可逆"而不是一个假的矩阵。
 */
export function inverse(m: Matrix): Matrix | null {
  if (!isSquare(m)) return null;
  const n = m.length;
  const scale = magnitude(m);
  if (scale === 0) return null;
  const tol = 1e-12 * scale;

  const a: Matrix = m.map((row, i) => [
    ...row,
    ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  ]);

  for (let k = 0; k < n; k++) {
    let piv = k;
    for (let i = k + 1; i < n; i++) {
      if (Math.abs(a[i][k]) > Math.abs(a[piv][k])) piv = i;
    }
    if (Math.abs(a[piv][k]) < tol) return null;
    if (piv !== k) [a[k], a[piv]] = [a[piv], a[k]];

    const p = a[k][k];
    for (let j = 0; j < 2 * n; j++) a[k][j] /= p;
    for (let i = 0; i < n; i++) {
      if (i === k) continue;
      const f = a[i][k];
      if (f === 0) continue;
      for (let j = 0; j < 2 * n; j++) a[i][j] -= f * a[k][j];
    }
  }
  return a.map((row) => row.slice(n));
}

/**
 * 第 i 行 · 第 j 列 —— 逐项乘积。矩阵乘法那个"行乘列"的过程,就是这一串加法。
 *
 * 单独抽出来是因为它就是那个要讲给学生看的东西:`3×5 + 4×7 = 15 + 28 = 43`。
 * 结果本身用 `multiply` 就能拿到,但**过程**拿不到。
 */
export function dotProducts(a: Matrix, b: Matrix, i: number, j: number): number[] | null {
  const row = a[i];
  if (!row || !b.length) return null;
  const terms: number[] = [];
  for (let k = 0; k < row.length; k++) {
    const v = b[k]?.[j];
    if (v === undefined) return null;
    terms.push(row[k] * v);
  }
  return terms;
}
