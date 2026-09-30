/**
 * 2×2 线性代数的自检。
 *
 * 这一层是为了让**模型只写矩阵**,几何结果全由代码算 —— 所以算错了没人能发现。
 * 特征向量这种东西"看起来对"和"真的对"差得很远,必须逐条验。
 *
 * 核心不变量:`Av = λv`。每个报出来的特征对都要满足它,随机扫几百个矩阵。
 *
 * 运行:npm run check:matrix
 */
import { apply, det, eigen, isSingular, nullSpace, rank, trace, unitSquareImage, type Mat2 } from '../src/lib/matrix2';

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

  console.log(`\n${pass} 通过, ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
}

void main();
