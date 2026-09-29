/**
 * 有向图的自动分层布局。
 *
 * ## 为什么必须自动布局
 *
 * 如果让模型自己给每个节点指定坐标,它会给出**重叠成一团的图** —— 因为
 * 它看不见自己排出来的东西。而一张重叠的流程图比没有图更糟:学生以为
 * 自己没看懂,其实是画错了。
 *
 * ## 算法
 *
 * 三层,每层都是纯函数:
 *   1. **断环** —— 检出回边并忽略,同时**如实报告**被忽略的是哪几条
 *   2. **分层** —— 最长路径:无入边的在第 0 层,其余取前驱最大层 + 1
 *   3. **层内排序** —— 重心法:按上一层邻居的平均位置排,来回扫几轮
 * 然后按层号和层内序号定坐标,每层居中。
 *
 * ## 边界
 *
 * 只对 DAG 成立,所以第 1 步是必需的。**环形结构在教学里很常见**
 * (`A ⟺ B` 是双向的、证明之间互相引用),不能假装不存在 ——
 * 与其画一张错的,不如把忽略的边交回去,让调用方标出来。
 */

export interface LayoutEdge {
  from: string;
  to: string;
}

export interface LayoutOptions {
  /** 层的推进方向 */
  direction: 'down' | 'right';
  nodeW: number;
  nodeH: number;
  gapX: number;
  gapY: number;
}

export interface LaidOutNode {
  id: string;
  /** 第几层 */
  layer: number;
  /** 层内序号 */
  order: number;
  x: number;
  y: number;
}

export interface Layout<E extends LayoutEdge = LayoutEdge> {
  nodes: Map<string, LaidOutNode>;
  layers: string[][];
  /** 参与布局的边(不含被忽略的回边)。**原样带回来** —— 调用方可能在边上挂了标注。 */
  edges: E[];
  /**
   * 被判定为回边而忽略的边。
   *
   * 必须交回给调用方 —— 静默丢掉的话,图上会凭空少几条关系,
   * 而学生看不出少了什么。宁可标出来"这几条是双向/回指的"。
   */
  ignored: E[];
  width: number;
  height: number;
}

/**
 * 检出回边。
 *
 * 三色 DFS:走到正在栈上的节点(gray)说明这条边指回了祖先,是回边。
 * 忽略它,剩下的图就是 DAG。
 */
function findBackEdges<E extends LayoutEdge>(ids: string[], edges: E[]): Set<string> {
  const out = new Map<string, E[]>();
  for (const id of ids) out.set(id, []);
  for (const e of edges) out.get(e.from)?.push(e);

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>(ids.map((id) => [id, WHITE]));
  const back = new Set<string>();

  const key = (e: LayoutEdge) => `${e.from}\u0000${e.to}`;

  // 迭代式 DFS —— 用递归的话,一张几百个节点的图在浏览器里可能爆栈
  for (const start of ids) {
    if (color.get(start) !== WHITE) continue;
    const stack: { id: string; i: number }[] = [{ id: start, i: 0 }];
    color.set(start, GRAY);
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      const next = out.get(top.id)![top.i];
      if (!next) {
        color.set(top.id, BLACK);
        stack.pop();
        continue;
      }
      top.i++;
      const c = color.get(next.to);
      if (c === GRAY) back.add(key(next));
      else if (c === WHITE) {
        color.set(next.to, GRAY);
        stack.push({ id: next.to, i: 0 });
      }
    }
  }
  return back;
}

export function layoutGraph<E extends LayoutEdge>(
  ids: string[],
  allEdges: E[],
  opts: LayoutOptions,
): Layout<E> {
  const known = new Set(ids);
  // 指向不存在的节点、或自己指自己的边都丢掉 —— 它们会让分层算不出结果
  const edges = allEdges.filter(
    (e) => known.has(e.from) && known.has(e.to) && e.from !== e.to,
  );

  if (!ids.length) {
    return { nodes: new Map(), layers: [], edges: [], ignored: [], width: 0, height: 0 };
  }

  const backKeys = findBackEdges(ids, edges);
  const usable = edges.filter((e) => !backKeys.has(`${e.from}\u0000${e.to}`));
  const ignored = edges.filter((e) => backKeys.has(`${e.from}\u0000${e.to}`));

  // ---- 分层:最长路径 ----
  const preds = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of usable) preds.get(e.to)!.push(e.from);

  const layer = new Map<string, number>();
  const pending = new Set(ids);
  // 反复扫,直到所有节点的层都定下来。usable 是 DAG,所以一定会收敛。
  for (let guard = 0; guard <= ids.length && pending.size; guard++) {
    for (const id of [...pending]) {
      const ps = preds.get(id)!;
      if (ps.every((p) => layer.has(p))) {
        layer.set(id, ps.length ? Math.max(...ps.map((p) => layer.get(p)!)) + 1 : 0);
        pending.delete(id);
      }
    }
  }
  // 兜底:上面的循环理论上必然收敛,但别让一个意外的环把剩下的节点留成 undefined
  for (const id of pending) layer.set(id, 0);

  const layerCount = Math.max(...ids.map((id) => layer.get(id)!)) + 1;
  const layers: string[][] = Array.from({ length: layerCount }, () => []);
  for (const id of ids) layers[layer.get(id)!]!.push(id);

  // ---- 层内排序:重心法 ----
  const succs = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of usable) succs.get(e.from)!.push(e.to);

  const orderIn = (l: string[]) => new Map(l.map((id, i) => [id, i]));
  let positions = orderIn(layers[0]!);
  for (let sweep = 0; sweep < 4; sweep++) {
    // 向下按前驱重心排
    for (let li = 1; li < layers.length; li++) {
      const bary = (id: string) => {
        const ps = preds.get(id)!.map((p) => positions.get(p)).filter((v): v is number => v !== undefined);
        return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : Infinity;
      };
      layers[li]!.sort((a, b) => bary(a) - bary(b));
      for (const [id, i] of orderIn(layers[li]!)) positions.set(id, i);
    }
    // 向上按后继重心排
    for (let li = layers.length - 2; li >= 0; li--) {
      const bary = (id: string) => {
        const ss = succs.get(id)!.map((s) => positions.get(s)).filter((v): v is number => v !== undefined);
        return ss.length ? ss.reduce((a, b) => a + b, 0) / ss.length : Infinity;
      };
      layers[li]!.sort((a, b) => bary(a) - bary(b));
      for (const [id, i] of orderIn(layers[li]!)) positions.set(id, i);
    }
  }

  // ---- 坐标:每层居中 ----
  const widest = Math.max(...layers.map((l) => l.length));
  const span = widest * opts.nodeW + Math.max(0, widest - 1) * opts.gapX;

  const nodes = new Map<string, LaidOutNode>();
  layers.forEach((layerIds, li) => {
    const layerSpan = layerIds.length * opts.nodeW + Math.max(0, layerIds.length - 1) * opts.gapX;
    const offset = (span - layerSpan) / 2;
    layerIds.forEach((id, i) => {
      const along = offset + i * (opts.nodeW + opts.gapX);
      const across = li * (opts.nodeH + opts.gapY);
      nodes.set(id, {
        id,
        layer: li,
        order: i,
        // direction 只影响坐标怎么摆,布局本身是同一套 —— 所以不用写两遍
        x: opts.direction === 'down' ? along : across,
        y: opts.direction === 'down' ? across : along,
      });
    });
  });

  return {
    nodes,
    layers,
    edges: usable,
    ignored,
    width: opts.direction === 'down' ? span : layerCount * opts.nodeH + Math.max(0, layerCount - 1) * opts.gapY,
    height: opts.direction === 'down' ? layerCount * opts.nodeH + Math.max(0, layerCount - 1) * opts.gapY : span,
  };
}
