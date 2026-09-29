/**
 * 网格采样自检:marching squares(隐式曲线)和向量场。
 *
 * 这两种曲线和显式曲线有本质差别 —— 一个 x 可能对应多个 y,不能"沿着 x 走一遍"。
 * 代价是几何代码里那种**看起来对、实际差一点点**的错误:marching squares 的
 * 16 种情形表、鞍点怎么连、边上的插值位置,任何一处错了图还是画得出来,
 * 只是画错了。
 *
 * 所以这里不测"有没有输出",测**输出的点是不是真的在曲线上面**。
 *
 * 运行:npm run check:field
 */
import { marchingSquares, sampleVectorField, toZeroForm } from '../src/lib/field';
import { safeEval } from '../src/lib/math';

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

const VIEW = { x: [-2, 2] as [number, number], y: [-2, 2] as [number, number] };

/** 线段端点离曲线有多远 —— 端点由边上的线性插值给出,应当几乎正好落在曲线上。 */
function worstResidual(
  segs: { x1: number; y1: number; x2: number; y2: number }[],
  F: (x: number, y: number) => number,
): number {
  let worst = 0;
  for (const s of segs) {
    worst = Math.max(worst, Math.abs(F(s.x1, s.y1)), Math.abs(F(s.x2, s.y2)));
  }
  return worst;
}

async function main() {
  console.log('\ntoZeroForm');

  ok('带等号的写成 F=0 的形式', (() => {
    const f = toZeroForm('x^2+y^2=1');
    return f === '(x^2+y^2) - (1)';
  })(), toZeroForm('x^2+y^2=1'));
  ok('不带等号的视作等于 0,原样返回', toZeroForm('x-y') === 'x-y', toZeroForm('x-y'));

  // 求值才是最终目的:两种写法在圆上都应当得到 0
  ok('两种写法在圆上都求值为 0', (() => {
    // 必须用项目自己的求值器:mathjs 里 ^ 是幂,而 JS 里 ^ 是异或。
    // 拿 new Function 去测是**测错东西** —— 那个式子根本算不出圆。
    const at = (eq: string) => safeEval(toZeroForm(eq), { x: Math.SQRT1_2, y: Math.SQRT1_2 });
    return Math.abs(at('x^2+y^2=1')) < 1e-12 && Math.abs(at('x^2+y^2-1')) < 1e-12;
  })());

  console.log('\nmarching squares —— 抽出来的点必须真的在曲线上');

  {
    const F = (x: number, y: number) => x * x + y * y - 1;
    const segs = marchingSquares(F, VIEW, 80, 80);
    ok('圆能抽出线段', segs.length > 100, `抽到 ${segs.length} 段`);

    const worst = worstResidual(segs, F);
    ok('所有端点都落在圆上', worst < 0.02, `最大偏离 ${worst.toFixed(4)}`);

    // 半径检查:这能抓出"整体缩放错了"这类不易察觉的错误
    const radii = segs.flatMap((s) => [Math.hypot(s.x1, s.y1), Math.hypot(s.x2, s.y2)]);
    const minR = Math.min(...radii);
    const maxR = Math.max(...radii);
    ok('半径确实是 1', maxR - minR < 0.05 && minR > 0.95, `半径范围 [${minR.toFixed(3)}, ${maxR.toFixed(3)}]`);
  }

  {
    // 直线是最容易验证的一种:y = x
    const F = (x: number, y: number) => x - y;
    const segs = marchingSquares(F, VIEW, 40, 40);
    ok('直线 x=y 被抽出来', segs.length > 10, `${segs.length} 段`);
    ok('端点确实在 x=y 上', worstResidual(segs, F) < 1e-9, worstResidual(segs, F).toExponential(2));
  }

  {
    // 鞍点:x*y=0 的两条轴。16 种情形表里 5 和 10 是有歧义的两格,
    // 连线方式错了这里就会画出多余的对角线。
    const F = (x: number, y: number) => x * y;
    const segs = marchingSquares(F, VIEW, 40, 40);
    ok('鞍点情形能处理', segs.length > 5, `${segs.length} 段`);
    ok('抽出来的还是那两条轴', worstResidual(segs, F) < 1e-9, worstResidual(segs, F).toExponential(2));
    // 对角线方向若有残留,端点会跑到 |x|≈|y| 且都不接近 0 的地方
    const stray = segs.filter((s) => Math.abs(s.x1) > 0.2 && Math.abs(s.y1) > 0.2);
    ok('没有画出多余的对角线', stray.length === 0, `${stray.length} 段落在既非 x=0 也非 y=0 的位置`);
  }

  {
    // 没有零点穿越时不该产出任何东西
    const segs = marchingSquares((x, y) => x * x + y * y + 1, VIEW, 40, 40);
    ok('曲线不穿过零时不产出线段', segs.length === 0, `${segs.length} 段`);
  }

  {
    // 一大片无定义的区域(负数开方)不能被硬串成线
    const F = (x: number, y: number) => (x * x + y * y < 1 ? NaN : x * x + y * y - 1);
    const segs = marchingSquares(F, VIEW, 40, 40);
    const allFinite = segs.every((s) => [s.x1, s.y1, s.x2, s.y2].every(Number.isFinite));
    ok('无定义的格子被跳过,不产出 NaN 坐标', allFinite && segs.length > 0, `${segs.length} 段`);
  }

  console.log('\n向量场');

  {
    // 旋转场 (-y, x):每个箭头应当和半径垂直
    const arrows = sampleVectorField((_x, y) => -y, (x, _y) => x, VIEW, 8);
    ok('铺出一片箭头', arrows.length > 40, `${arrows.length} 个`);

    const perpendicular = arrows.every((a) => Math.abs(a.u * a.x + a.v * a.y) < 1e-9);
    ok('箭头和半径垂直(方向算对了)', perpendicular);

    ok('模长如实算出来', arrows.every((a) => Math.abs(a.magnitude - Math.hypot(a.x, a.y)) < 1e-9));
  }

  {
    const arrows = sampleVectorField((x, _y) => x, (_x, y) => y, VIEW, 10);
    // 网格是正方形,而且覆盖整个视口
    const xs = [...new Set(arrows.map((a) => a.x.toFixed(6)))].map(Number).sort((a, b) => a - b);
    const ys = [...new Set(arrows.map((a) => a.y.toFixed(6)))].map(Number).sort((a, b) => a - b);
    const stepX = xs[1] - xs[0];
    const stepY = ys[1] - ys[0];
    // 方形网格意味着两个方向的步长一致,否则箭头会被拉成各向异性,而那是数据里没有的信息
    ok('网格是正方形的(不按视口比例拉伸)', Math.abs(stepX - stepY) < 1e-9, `dx=${stepX} dy=${stepY}`);
  }

  {
    // 零向量画成一个点毫无意义
    const arrows = sampleVectorField(() => 0, () => 0, VIEW, 6);
    ok('零向量被跳过', arrows.length === 0, `${arrows.length} 个`);
  }

  {
    const arrows = sampleVectorField((_x, _y) => NaN, (_x, _y) => 1, VIEW, 6);
    ok('无定义处被跳过', arrows.length === 0, `${arrows.length} 个`);
  }

  console.log(`\n${pass} 通过, ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
}

void main();
