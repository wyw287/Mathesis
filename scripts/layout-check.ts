/**
 * 图布局自检。
 *
 * 布局是"流程图"这个 kind 能不能成立的地方 —— 一张重叠成团的图比没有图更糟,
 * 因为学生会以为是自己没看懂。而布局是纯函数,所以可以逐条验。
 *
 * 主要盯三条不变量:
 *   · 每条留下的边都**严格向前跨层**(这是分层布局成立的定义)
 *   · 同层节点不重叠
 *   · 有环时**如实报告**忽略了哪几条,而不是静默丢掉
 *
 * 运行:npm run check:layout
 */
import { layoutGraph, type LayoutEdge } from '../src/lib/graph-layout';

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

const OPTS = { direction: 'down' as const, nodeW: 120, nodeH: 44, gapX: 24, gapY: 36 };
const E = (from: string, to: string): LayoutEdge => ({ from, to });

/** 分层布局成立的定义:每条边都严格向前跨层。 */
function allEdgesForward(l: ReturnType<typeof layoutGraph>): boolean {
  return l.edges.every((e) => l.nodes.get(e.from)!.layer < l.nodes.get(e.to)!.layer);
}

/** 同层不重叠:同一层里任意两个节点的 x 都不同。 */
function noOverlap(l: ReturnType<typeof layoutGraph>): boolean {
  for (const layer of l.layers) {
    const xs = layer.map((id) => l.nodes.get(id)!.x);
    if (new Set(xs).size !== xs.length) return false;
  }
  return true;
}

async function main() {
  console.log('\n基本形状');

  {
    const l = layoutGraph(['a', 'b', 'c'], [E('a', 'b'), E('b', 'c')], OPTS);
    ok('链:三层依次排开', l.nodes.get('a')!.layer === 0 && l.nodes.get('b')!.layer === 1 && l.nodes.get('c')!.layer === 2);
    ok('链:边都向前', allEdgesForward(l));
  }

  {
    // 菱形:a → b,c → d
    const l = layoutGraph(['a', 'b', 'c', 'd'], [E('a', 'b'), E('a', 'c'), E('b', 'd'), E('c', 'd')], OPTS);
    ok('菱形:分支在同一层', l.nodes.get('b')!.layer === 1 && l.nodes.get('c')!.layer === 1);
    ok('菱形:汇合在下一层', l.nodes.get('d')!.layer === 2);
    ok('菱形:边都向前', allEdgesForward(l));
    ok('菱形:同层不重叠', noOverlap(l));
  }

  {
    // 层号取前驱最大值 —— 这是"最长路径"分层的关键。取最小值的话,
    // 一条长路径会被压扁,边就会跨回去。
    const l = layoutGraph(
      ['a', 'b', 'c', 'd'],
      [E('a', 'b'), E('b', 'c'), E('a', 'd'), E('d', 'c')],
      OPTS,
    );
    ok('长路径决定层号(不是最短的)', l.nodes.get('c')!.layer === 2, String(l.nodes.get('c')!.layer));
    ok('这种形状下边也全都向前', allEdgesForward(l));
  }

  {
    // 不连通的两个分量都要在
    const l = layoutGraph(['a', 'b', 'x', 'y'], [E('a', 'b'), E('x', 'y')], OPTS);
    ok('不连通的分量全部参与布局', l.nodes.size === 4);
    ok('两个源点都在第 0 层', l.nodes.get('a')!.layer === 0 && l.nodes.get('x')!.layer === 0);
  }

  console.log('\n层内排序 —— 重心法要真的减少交叉');

  {
    // 朴素顺序是 [a1,a2] / [b1,b2],而边是 a1→b2、a2→b1,会交叉。
    // 重心法应当把 b2 排到 b1 前面,交叉就没了。
    const l = layoutGraph(['a1', 'a2', 'b1', 'b2'], [E('a1', 'b2'), E('a2', 'b1')], OPTS);
    ok(
      '错位的两条边被排正',
      l.nodes.get('b2')!.order < l.nodes.get('b1')!.order,
      `b2.order=${l.nodes.get('b2')!.order}, b1.order=${l.nodes.get('b1')!.order}`,
    );
  }

  {
    // 更复杂一点:三层,中间层要同时迁就上下
    const l = layoutGraph(
      ['a1', 'a2', 'm1', 'm2', 'z1', 'z2'],
      [E('a1', 'm2'), E('a2', 'm1'), E('m1', 'z2'), E('m2', 'z1')],
      OPTS,
    );
    ok('三层都能排正', allEdgesForward(l) && noOverlap(l));
  }

  console.log('\n有环时不许装作没环');

  {
    // A ⟺ B 在教学里很常见(等价关系是双向的)
    const l = layoutGraph(['a', 'b'], [E('a', 'b'), E('b', 'a')], OPTS);
    ok('双向边:一条保留一条报出来', l.edges.length + l.ignored.length === 2, `${l.edges.length}/${l.ignored.length}`);
    ok('被忽略的确实是回边', l.ignored.length === 1);
    ok('留下的边仍然向前', allEdgesForward(l));
    ok('所有节点都还在', l.nodes.size === 2);
  }

  {
    // 三元环
    const l = layoutGraph(['a', 'b', 'c'], [E('a', 'b'), E('b', 'c'), E('c', 'a')], OPTS);
    ok('三元环:断掉一条', l.ignored.length === 1, `${l.ignored.length}`);
    ok('三元环:边都向前', allEdgesForward(l));
    ok('三元环:节点没丢', l.nodes.size === 3);
  }

  console.log('\n脏输入不能崩');

  {
    const l = layoutGraph(['a', 'b'], [E('a', 'b'), E('a', '不存在'), E('b', 'b')], OPTS);
    ok('指向未知节点的边被丢掉', l.edges.length === 1 && l.ignored.length === 0);
    ok('自环被丢掉', !l.edges.some((e) => e.from === e.to));
  }

  {
    const l = layoutGraph([], [], OPTS);
    ok('空图', l.nodes.size === 0 && l.width === 0 && l.height === 0);
  }

  {
    const l = layoutGraph(['only'], [], OPTS);
    ok('单个节点', l.nodes.size === 1 && l.nodes.get('only')!.layer === 0);
    ok('单个节点的尺寸就是节点本身的尺寸', l.width === OPTS.nodeW && l.height === OPTS.nodeH, `${l.width}×${l.height}`);
  }

  {
    // 密集的完全二分图:K3,3,交叉最多
    const ids = ['a1', 'a2', 'a3', 'b1', 'b2', 'b3'];
    const edges = ids.slice(0, 3).flatMap((a) => ids.slice(3).map((b) => E(a, b)));
    const l = layoutGraph(ids, edges, OPTS);
    ok('K3,3 也不会重叠', noOverlap(l));
    ok('K3,3 的边都向前', allEdgesForward(l));
  }

  console.log('\n尺寸与方向');

  {
    const l = layoutGraph(['a', 'b', 'c'], [E('a', 'b'), E('a', 'c')], OPTS);
    // 第一层两个节点并排,宽度应当容得下
    ok('宽度容得下最宽的一层', l.width >= OPTS.nodeW * 2 + OPTS.gapX, String(l.width));
    ok('高度容得下所有层', l.height >= OPTS.nodeH * 2 + OPTS.gapY, String(l.height));
  }

  {
    // 每层居中。用菱形:第 0 层和第 2 层各只有一个节点,它们应当落在中间。
    // (第一版用了 a→b,a→c —— 那 b、c 是**同一层**的两个节点,根本没有
    //  "独居一层"的情况,测试测的不是它以为的东西。)
    const l = layoutGraph(['a', 'b', 'c', 'd'], [E('a', 'b'), E('a', 'c'), E('b', 'd'), E('c', 'd')], OPTS);
    const mid = (l.width - OPTS.nodeW) / 2;
    ok('顶部单节点层被居中', Math.abs(l.nodes.get('a')!.x - mid) < 1e-9, `x=${l.nodes.get('a')!.x}, 期望 ${mid}`);
    ok('底部单节点层也被居中', Math.abs(l.nodes.get('d')!.x - mid) < 1e-9, `x=${l.nodes.get('d')!.x}, 期望 ${mid}`);
    ok('中间两节点层铺满', l.nodes.get('b')!.x === 0 && l.nodes.get('c')!.x === OPTS.nodeW + OPTS.gapX);
  }

  {
    const down = layoutGraph(['a', 'b'], [E('a', 'b')], OPTS);
    const right = layoutGraph(['a', 'b'], [E('a', 'b')], { ...OPTS, direction: 'right' });
    ok('方向只影响坐标怎么摆', down.nodes.get('b')!.y > down.nodes.get('a')!.y);
    ok('向右时改成 x 推进', right.nodes.get('b')!.x > right.nodes.get('a')!.x);
    ok('两种方向的尺寸对调', down.width === right.height && down.height === right.width);
  }

  {
    // 大图也要能在合理时间内排完(布局是每次渲染都跑的)
    const ids = Array.from({ length: 120 }, (_, i) => `n${i}`);
    const edges = ids.slice(1).map((id, i) => E(`n${i}`, id));
    const t = Date.now();
    const l = layoutGraph(ids, edges, OPTS);
    const ms = Date.now() - t;
    ok('120 个节点能排完', l.nodes.size === 120);
    ok('而且很快(每次渲染都要跑)', ms < 100, `${ms}ms`);
  }

  console.log(`\n${pass} 通过, ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
}

void main();
