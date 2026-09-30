/**
 * 矩阵代数的自检。
 *
 * 上面那半是 **2×2 的几何**(行列式的面积含义、特征方向);下面那半是
 * **任意尺寸的代数**(乘法、转置、行列式、逆)。
 *
 * 这一整层的意义是让**模型只写数字**,其余全由代码算 —— 所以算错了没人能发现。
 * 特征向量、逆矩阵这种东西尤其"看起来对"和"真的对"差得很远:逆矩阵画出来
 * 就是个矩阵,肉眼看不出它错在哪。
 *
 * 核心不变量:
 *   · `Av = λv` —— 每个报出来的特征对都要满足它
 *   · `(AB)v = A(Bv)` —— 矩阵乘法结合律
 *   · `A·A⁻¹ = I` —— 每个报出来的逆都要满足它
 * 每条都随机扫几百个矩阵。
 *
 * 运行:npm run check:matrix
 */
import { apply, det, eigen, isSingular, nullSpace, rank, trace, unitSquareImage, type Mat2 } from '../src/lib/matrix2';
import {
  determinant,
  dotProducts,
  inverse,
  isSquare,
  multiply,
  transpose,
  type Matrix,
} from '../src/lib/matrixn';

let pass = 0;
let fail = 0;

function ok(name: string, cond: boolean, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const m = (a: number, b: number, c: number, d: number): Mat2 => ({ a, b, c, d });
const near = (x: number, y: number, tol = 1e-9) => Math.abs(x - y) <= tol;

/** 任意尺寸的矩阵,给下面那半用。 */
const mat = (...rows: number[][]): Matrix => rows;
const I = (n: number): Matrix => Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
/** 矩阵乘向量。只为验结合律,所以不放进产品代码。 */
const mulVec = (m: Matrix, v: number[]): number[] => m.map((row) => row.reduce((s, x, k) => s + x * v[k], 0));
const randMat = (r: number, c: number): Matrix =>
  Array.from({ length: r }, () => Array.from({ length: c }, () => Math.round((Math.random() - 0.5) * 6)));
const sameShape = (a: Matrix, b: Matrix) =>
  a.length === b.length && a.every((row, i) => row.length === b[i].length);
const close = (a: Matrix, b: Matrix, tol = 1e-9) =>
  sameShape(a, b) && a.every((row, i) => row.every((v, j) => Math.abs(v - b[i][j]) <= tol));

async function main() {
  console.log('\n行列式 —— 几何上是面积的缩放倍数');

  ok('单位阵不改变面积', near(det(m(1, 0, 0, 1)), 1));
  ok('缩放', near(det(m(2, 0, 0, 3)), 6));
  ok('旋转保持面积', near(det(m(0, -1, 1, 0)), 1), String(det(m(0, -1, 0, 0))));
  ok('镜像翻转定向,行列式为负', near(det(m(0, 1, 1, 0)), -1));
  ok('奇异矩阵行列式为零', near(det(m(1, 2, 2, 4)), 0));

  {
    // 单位正方形的像,面积应当等于 |det|
    for (const mat of [m(2, 0, 0, 3), m(1, 1, 0, 1), m(0.5, -1.5, 2, 0.5)]) {
      const [p0, p1, p2, p3] = unitSquareImage(mat);
      // 鞋带公式
      const area = Math.abs(
        (p0[0] * p1[1] - p1[0] * p0[1]) +
          (p1[0] * p2[1] - p2[0] * p1[1]) +
          (p2[0] * p3[1] - p3[0] * p2[1]) +
          (p3[0] * p0[1] - p3[0] * p0[1]),
      ) / 2;
      ok(`单位正方形的像面积 = |det| (det=${det(mat)})`, near(area, Math.abs(det(mat)), 1e-9), `${area}`);
    }
  }

  console.log('\n特征分解 —— 逐条验 Av = λv');

  {
    const cases: [string, Mat2, number[]][] = [
      ['对角阵', m(2, 0, 0, 3), [2, 3]],
      ['上三角', m(2, 1, 0, 3), [2, 3]],
      ['对称阵', m(3, 1, 1, 3), [4, 2]],
      ['重复特征值', m(2, 0, 0, 2), [2]],
      ['亏损矩阵', m(1, 1, 0, 1), [1]],
      ['秩一', m(3, 0, 0, 0), [3, 0]],
    ];
    for (const [name, mat, want] of cases) {
      const r = eigen(mat);
      const got = r.real.map((e) => e.value).sort((x, y) => x - y);
      const expected = [...want].sort((x, y) => x - y);
      ok(
        `${name}:特征值对得上`,
        !r.complex && got.length === expected.length && got.every((v, i) => near(v, expected[i]!, 1e-9)),
        `得到 ${JSON.stringify(got)},期望 ${JSON.stringify(expected)}`,
      );
    }
  }

  {
    // 旋转:平面上没有任何方向不变。硬凑一个实数出来会教错东西。
    const r = eigen(m(0, -1, 1, 0));
    ok('90° 旋转没有实特征方向', r.complex && r.real.length === 0, JSON.stringify(r));
    const r2 = eigen(m(1, -2, 1, 1));
    ok('别的旋转也是', r2.complex, JSON.stringify(r2.real));
  }

  console.log('\n随机扫 —— 这是真正能抓住错误的一条');

  {
    let checked = 0;
    let worst = 0;
    let mismatch = 0;

    for (let i = 0; i < 500; i++) {
      const mat = m(
        (Math.random() - 0.5) * 8,
        (Math.random() - 0.5) * 8,
        (Math.random() - 0.5) * 8,
        (Math.random() - 0.5) * 8,
      );
      const r = eigen(mat);

      // 判别式的符号必须和 complex 标志一致。
      // 注意是 `!==`:第一版写成了 `===`,于是 500 个全部被算成"不一致"。
      const disc = trace(mat) ** 2 - 4 * det(mat);
      if (disc < -1e-9 !== r.complex) mismatch++;

      for (const e of r.real) {
        const av = apply(mat, e.vector);
        const lv: [number, number] = [e.value * e.vector[0], e.value * e.vector[1]];
        worst = Math.max(worst, Math.abs(av[0] - lv[0]), Math.abs(av[1] - lv[1]));
        checked++;
      }
    }

    ok('复/实判定和判别式一致', mismatch === 0, `${mismatch} 个不一致`);
    ok('扫到了足够多的实特征对', checked > 300, `只有 ${checked} 个`);
    ok('每个都满足 Av = λv', worst < 1e-9, `最大偏差 ${worst.toExponential(2)}`);
  }

  console.log('\n特征向量是单位向量');

  {
    const bad = [];
    for (let i = 0; i < 200; i++) {
      const mat = m(Math.random() * 6 - 3, Math.random() * 6 - 3, Math.random() * 6 - 3, Math.random() * 6 - 3);
      for (const e of eigen(mat).real) {
        if (Math.abs(Math.hypot(...e.vector) - 1) > 1e-9) bad.push(e.vector);
      }
    }
    ok('都是单位长度(渲染时不用再归一化)', bad.length === 0, JSON.stringify(bad.slice(0, 3)));
  }

  console.log('\n退化情形不能崩');

  {
    ok('零矩阵', (() => {
      const r = eigen(m(0, 0, 0, 0));
      return r.real.every((e) => Number.isFinite(e.value) && e.vector.every(Number.isFinite));
    })());
    ok('奇异但非零', (() => {
      const r = eigen(m(1, 2, 2, 4));
      return r.real.every((e) => e.vector.every(Number.isFinite));
    })());
    ok('极大值不出 NaN', (() => {
      const r = eigen(m(1e8, 1e8, 1e8, 1e8));
      return r.real.every((e) => Number.isFinite(e.value) && e.vector.every(Number.isFinite));
    })());
  }

  console.log('\n秩与零空间');

  {
    ok('满秩是 2', rank(m(1, 0, 0, 1)) === 2 && rank(m(0, -1, 1, 0)) === 2);
    ok('奇异是 1', rank(m(1, 2, 2, 4)) === 1, String(rank(m(1, 2, 2, 4))));
    ok('零矩阵是 0', rank(m(0, 0, 0, 0)) === 0);

    ok('满秩时零空间只有原点', nullSpace(m(1, 0, 0, 1)).kind === 'point');
    ok('零矩阵时整个平面都是零空间', nullSpace(m(0, 0, 0, 0)).kind === 'plane');

    const ns = nullSpace(m(1, 2, 2, 4));
    ok('奇异矩阵的零空间是一条线', ns.kind === 'line', ns.kind);
    if (ns.kind === 'line') {
      // 不变量:方向上的向量真的被映到原点
      const v = apply(m(1, 2, 2, 4), ns.dir);
      ok('零空间里的向量真的被映到原点', near(v[0], 0, 1e-9) && near(v[1], 0, 1e-9), JSON.stringify(v));
      ok('返回的是单位方向', near(Math.hypot(...ns.dir), 1), String(Math.hypot(...ns.dir)));
    }
  }

  {
    // 随机扫一遍:**每条报出来的零空间方向,都必须真的被映到原点**,而且只对奇异矩阵报。
    // 这条和特征向量那个 `Av = λv` 一样,是"看起来对"和"真的对"的分界。
    let bad = 0;
    let lines = 0;
    for (let i = 0; i < 400; i++) {
      const mm = m(
        Math.round((Math.random() - 0.5) * 8),
        Math.round((Math.random() - 0.5) * 8),
        Math.round((Math.random() - 0.5) * 8),
        Math.round((Math.random() - 0.5) * 8),
      );
      const ns = nullSpace(mm);
      if (ns.kind !== 'line') continue;
      lines++;
      const v = apply(mm, ns.dir);
      if (Math.hypot(...v) > 1e-9) bad++;
      // 报了线,就必须确实是奇异的 —— 否则是在教错的
      if (!isSingular(mm)) bad++;
    }
    ok('随机 400 个整数矩阵里,报出来的零空间方向全部真的被映到原点', bad === 0, `${bad} 个错的`);
    ok('而且确实扫到了不少奇异矩阵(不然这条是空转)', lines > 10, `只扫到 ${lines} 个`);
  }

  {
    // 判据要用相对量级:det 随元素平方缩放,拿绝对阈值比会把"元素极小但满秩"的
    // 矩阵误判成退化 —— 而界面上"秩"和"det 是不是 0"必须一致
    ok('元素极小但满秩,不能判成退化', !isSingular(m(1e-6, 0, 0, 1e-6)), `det=${det(m(1e-6, 0, 0, 1e-6))}`);
    ok('元素极大但满秩,同样不能误判', !isSingular(m(1e6, 0, 0, 1e6)), `det=${det(m(1e6, 0, 0, 1e6))}`);
    ok('量级悬殊但确实退化,要判出来', isSingular(m(1e6, 2e6, 1e6, 2e6)));
  }

  {
    // 秩亏时 λ=0 的那个特征方向**就是**零空间 —— 界面上据此跳过重复的一条线,
    // 所以这个等式得成立,不然会出现"图上有条线、不知道是谁画的"
    const mm = m(1, 2, 2, 4);
    const zero = eigen(mm).real.find((e) => Math.abs(e.value) < 1e-9);
    const ns = nullSpace(mm);
    ok('秩亏时存在 λ=0 的特征方向', !!zero);
    if (zero && ns.kind === 'line') {
      // 同一条线 = 方向平行(可能反向)
      const cross = Math.abs(zero.vector[0] * ns.dir[1] - zero.vector[1] * ns.dir[0]);
      ok('它和零空间是同一条线', near(cross, 0, 1e-9), `叉积 ${cross}`);
    }
  }

  console.log('\n任意尺寸:乘法与转置');

  {
    ok('单位阵不改变任何东西', close(multiply(I(3), mat([1, 2], [3, 4], [5, 6]))!, mat([1, 2], [3, 4], [5, 6])));
    ok('已知乘积', close(multiply(mat([1, 2], [3, 4]), mat([5, 6], [7, 8]))!, mat([19, 22], [43, 50])));

    // 3×2 乘 2×3 得 3×3 —— 非方阵也要走通,画布上不必都是方阵
    const a = mat([1, 2], [3, 4], [5, 6]);
    const b = mat([7, 8, 9], [10, 11, 12]);
    const ab = multiply(a, b);
    ok('非方阵能相乘', !!ab && sameShape(ab, mat([0, 0, 0], [0, 0, 0], [0, 0, 0])), JSON.stringify(ab));

    // 维数配不上要**明说不能乘**,而不是编一个数出来
    ok('维数配不上返回 null', multiply(a, a) === null);

    ok('转置两次回到原样', close(transpose(transpose(a)), a));
    ok('转置把 m×n 变成 n×m', sameShape(transpose(a), mat([0, 0, 0], [0, 0, 0])), JSON.stringify(transpose(a)));
    ok('转置确实是转置', close(transpose(mat([1, 2], [3, 4])), mat([1, 3], [2, 4])));
  }

  {
    // 结合律 (AB)v = A(Bv)。随机扫,因为乘法最容易写错的就是下标顺序,
    // 而小矩阵上写反了下标常常也"看起来对"
    let bad = 0;
    let tested = 0;
    for (let t = 0; t < 300; t++) {
      const n = 2 + Math.floor(Math.random() * 3);
      const A = randMat(n, n);
      const B = randMat(n, n);
      const v = Array.from({ length: n }, () => Math.round((Math.random() - 0.5) * 6));
      const AB = multiply(A, B);
      if (!AB) continue;
      tested++;
      const left = mulVec(AB, v);
      const right = mulVec(A, mulVec(B, v));
      if (left.some((x, i) => Math.abs(x - right[i]) > 1e-9)) bad++;
    }
    ok('随机 300 组:(AB)v = A(Bv)', bad === 0, `${bad} 组不符`);
    ok('而且确实跑到了不少组(不然这条是空转)', tested > 100, `只跑了 ${tested} 组`);
  }

  console.log('\n任意尺寸:行列式与逆');

  {
    ok('单位阵行列式为 1', determinant(I(4)) === 1);
    ok('2×2 和 matrix2 的结果一致', near(determinant(mat([1, 2], [3, 4]))!, det(m(1, 2, 3, 4))));
    ok('交换两行翻转符号', near(determinant(mat([3, 4], [1, 2]))!, -det(m(1, 2, 3, 4))));

    // 主元为零但矩阵不奇异(需要换行才能算下去)是最容易写错的一种
    ok('需要换行才不奇异', near(determinant(mat([0, 1], [1, 0]))!, -1), String(determinant(mat([0, 1], [1, 0]))));
    ok('奇异矩阵行列式为 0', determinant(mat([1, 2, 3], [2, 4, 6], [7, 8, 9])) === 0);
    ok('非方阵没有行列式', determinant(mat([1, 2])) === null);

    ok('逆:2×2 闭式对得上', close(inverse(mat([1, 2], [3, 4]))!, mat([-2, 1], [1.5, -0.5])));
    ok('奇异矩阵没有逆', inverse(mat([1, 2], [2, 4])) === null);
    ok('零矩阵没有逆', inverse(mat([0, 0], [0, 0])) === null);
    ok('非方阵没有逆', inverse(mat([1, 2, 3], [4, 5, 6])) === null);
  }

  {
    // A·A⁻¹ = I。这条是逆矩阵唯一的验收标准 —— 光看数字看不出来对不对。
    let bad = 0;
    let found = 0;
    for (let t = 0; t < 300; t++) {
      const n = 2 + Math.floor(Math.random() * 3);
      const A = randMat(n, n);
      const inv = inverse(A);
      if (!inv) continue;
      found++;
      const prod = multiply(A, inv);
      if (!prod || !close(prod, I(n), 1e-6)) bad++;
    }
    ok('随机 300 组:每个报出来的逆都满足 A·A⁻¹ = I', bad === 0, `${bad} 个不满足`);
    ok('而且确实算出了不少逆(不然这条是空转)', found > 50, `只算了 ${found} 个`);
  }

  {
    // det 是相对判据:元素整体缩小时,奇异/非奇异的结论不能跟着变
    ok('整体很小但满秩,不能误判成奇异', determinant(mat([1e-6, 0], [0, 1e-6]))! !== 0);
    ok('整体很大且确实奇异,要判出来', determinant(mat([1e6, 2e6], [1e6, 2e6])) === 0);
  }

  console.log('\n行 × 列的过程');

  {
    const A = mat([3, 4], [1, 2]);
    const B = mat([5, 6], [7, 8]);
    const terms = dotProducts(A, B, 0, 1);
    ok('逐项乘积就是行乘列', JSON.stringify(terms) === JSON.stringify([3 * 6, 4 * 8]), JSON.stringify(terms));
    // 它必须和 multiply 给出的那一格完全一致,不然面板上会同时出现两个数
    const byMultiply = multiply(A, B)![0][1];
    ok('求和等于 multiply 的那一格', near(terms!.reduce((s, x) => s + x, 0), byMultiply), `${terms!.reduce((s, x) => s + x, 0)} vs ${byMultiply}`);
    ok('下标越界返回 null 而不是崩', dotProducts(A, B, 9, 0) === null);
  }

  {
    ok('isSquare 认得方阵', isSquare(mat([1, 2], [3, 4])) && !isSquare(mat([1, 2, 3])));
  }

  console.log(`\n${pass} 通过, ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
}

void main();
