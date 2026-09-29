/**
 * 网格采样:隐式曲线(等值线)和向量场。
 *
 * 这两件事共用一个机制 —— 在视口上铺一张网格,逐点求值。它们当初被推迟的理由
 * 是「数值采样是独立课题」,确实如此,但课题本身不长:等值线用 marching squares,
 * 向量场就是逐点取箭头。
 *
 * 和显式曲线(一条 x 对应一个 y)的本质差别在于**这里没有"沿着 x 走一遍"这回事**,
 * 所以不能复用 sampleExplicit 那套,必须铺二维网格。
 */
// mathjs 的求值在调用方做(它需要 scope),这里只负责几何

export interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface View {
  x: [number, number];
  y: [number, number];
}

/**
 * 把 `x^2+y^2=1` 这种写法统一成 `F(x,y)=0` 里那个 F。
 *
 * 校验在解析时就做过了(两半各自过表达式校验),这里只做字符串层面的事,
 * 不重新解析 —— 渲染每帧都要用,不该有额外开销。
 */
export function toZeroForm(eq: string): string {
  const parts = eq.split('=');
  if (parts.length !== 2) return eq; // 没等号就是 F 本身;多个等号在解析时已被拒
  return `(${parts[0]}) - (${parts[1]})`;
}

/** 线性插值下,从 a 走到 b 时穿过 0 的位置参数。 */
const cross = (a: number, b: number): number => a / (a - b);

/**
 * Marching squares:把 F(x,y)=0 抽成线段。
 *
 * 每个格子看四个角的符号,符号有变就说明等值线穿过它,用线性插值找出穿过的位置。
 * 两个**鞍点**情形(对角同号)有歧义,用四角均值当渐近判别器决定怎么连
 * —— 不用它的话,鞍点附近的等值线会随机断开或连错。
 */
export function marchingSquares(
  value: (x: number, y: number) => number,
  view: View,
  cols: number,
  rows: number,
): Segment[] {
  const [x0, x1] = view.x;
  const [y0, y1] = view.y;
  const dx = (x1 - x0) / cols;
  const dy = (y1 - y0) / rows;

  // 先铺一张采样表。每个格点会被四个相邻格子用到,逐格子求值会算四遍。
  const grid = new Float64Array((cols + 1) * (rows + 1));
  const stride = cols + 1;
  for (let j = 0; j <= rows; j++) {
    const y = y0 + j * dy;
    for (let i = 0; i <= cols; i++) {
      grid[j * stride + i] = value(x0 + i * dx, y);
    }
  }
  const at = (i: number, j: number) => grid[j * stride + i];

  const out: Segment[] = [];

  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const v0 = at(i, j); // 左下
      const v1 = at(i + 1, j); // 右下
      const v2 = at(i + 1, j + 1); // 右上
      const v3 = at(i, j + 1); // 左上

      // 任一角无定义就跳过这个格子 —— 硬凑会画出凭空的线
      if (!Number.isFinite(v0) || !Number.isFinite(v1) || !Number.isFinite(v2) || !Number.isFinite(v3)) {
        continue;
      }

      const idx = (v0 > 0 ? 1 : 0) | (v1 > 0 ? 2 : 0) | (v2 > 0 ? 4 : 0) | (v3 > 0 ? 8 : 0);
      if (idx === 0 || idx === 15) continue;

      const X = x0 + i * dx;
      const Y = y0 + j * dy;
      // 四条边上的穿越点
      const B = { x: X + dx * cross(v0, v1), y: Y };
      const R = { x: X + dx, y: Y + dy * cross(v1, v2) };
      const T = { x: X + dx * cross(v3, v2), y: Y + dy };
      const L = { x: X, y: Y + dy * cross(v0, v3) };
      const seg = (a: typeof B, b: typeof B) => out.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });

      switch (idx) {
        case 1:
        case 14:
          seg(L, B);
          break;
        case 2:
        case 13:
          seg(B, R);
          break;
        case 3:
        case 12:
          seg(L, R);
          break;
        case 4:
        case 11:
          seg(R, T);
          break;
        case 6:
        case 9:
          seg(B, T);
          break;
        case 7:
        case 8:
          seg(L, T);
          break;
        // 鞍点:对角同号,连接方式有歧义。用四角均值决定谁跟谁连。
        case 5: // 左下、右上为正
          if ((v0 + v1 + v2 + v3) / 4 > 0) {
            seg(B, R);
            seg(L, T);
          } else {
            seg(L, B);
            seg(R, T);
          }
          break;
        case 10: // 右下、左上为正
          if ((v0 + v1 + v2 + v3) / 4 > 0) {
            seg(L, B);
            seg(R, T);
          } else {
            seg(B, R);
            seg(L, T);
          }
          break;
      }
    }
  }

  return out;
}

/** 一个箭头:位置 + 方向(方向向量未归一化,渲染层决定画多长)。 */
export interface Arrow {
  x: number;
  y: number;
  u: number;
  v: number;
  /** 模长。归一化显示时用不上,但它本身是有信息的(比如梯度的大小) */
  magnitude: number;
}

/**
 * 向量场逐点取箭头。
 *
 * 网格是正方形而不是按视口比例 —— 否则箭头会在一个方向上被拉长,
 * 看起来像各向异性场,而那是数据里没有的信息。
 */
export function sampleVectorField(
  fx: (x: number, y: number) => number,
  fy: (x: number, y: number) => number,
  view: View,
  count: number,
): Arrow[] {
  const [x0, x1] = view.x;
  const [y0, y1] = view.y;
  // 以较短的一边为基准铺正方形网格
  const span = Math.min(x1 - x0, y1 - y0);
  const step = span / Math.max(2, count);
  const cols = Math.max(2, Math.ceil((x1 - x0) / step));
  const rows = Math.max(2, Math.ceil((y1 - y0) / step));
  const dx = (x1 - x0) / cols;
  const dy = (y1 - y0) / rows;

  const out: Arrow[] = [];
  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i <= cols; i++) {
      const x = x0 + i * dx;
      const y = y0 + j * dy;
      const u = fx(x, y);
      const v = fy(x, y);
      if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
      const magnitude = Math.hypot(u, v);
      // 零向量画成一个点没有意义,跳过
      if (magnitude < 1e-12) continue;
      out.push({ x, y, u, v, magnitude });
    }
  }
  return out;
}
