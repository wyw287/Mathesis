/**
 * diagram —— 流程 / 逻辑图。
 *
 * 和 `derivation` 的分工是这个 kind 最要紧的一件事:
 *   derivation 是**线性**的步骤链,每步带理由、能被机器核对
 *   diagram    是**图结构**,有分支和汇合
 * 用错的话学生看到的是一张本可以用推导讲清楚、却画成一团的关系网。
 * 所以工具描述里把这条写在了最前面。
 */
import { clip } from '../../lib/text';
import { latexToPlain } from '../../lib/latex-plain';
import { ToolInputError, arr, obj, oneOf, optStr, str } from '../../lib/validate';
import type { TeachingTool } from '../../tools/types';
import type { DiagramEdgeSpec, DiagramNodeSpec, DiagramRole, DiagramSpec } from '../../types/artifact';
import type { KindModule } from '../module';
import { Diagram } from './Diagram';

const ROLES: readonly DiagramRole[] = ['plain', 'given', 'key', 'conclusion'];

function parseNode(v: unknown, where: string): DiagramNodeSpec {
  const o = obj(v, where);
  return {
    id: str(o.id, `${where}.id`),
    label: str(o.label, `${where}.label`),
    role: o.role === undefined ? undefined : oneOf(o.role, ROLES, `${where}.role`),
  };
}

export function parseDiagramSpec(v: unknown): DiagramSpec {
  const o = obj(v, 'spec');
  const nodesRaw = arr(o.nodes, 'spec.nodes');
  if (!nodesRaw.length) throw new ToolInputError('spec.nodes 不能为空');
  if (nodesRaw.length > 40) {
    throw new ToolInputError(`spec.nodes 最多 40 个(收到 ${nodesRaw.length} 个)—— 再多就画不清了`);
  }

  const nodes = nodesRaw.map((n, i) => parseNode(n, `spec.nodes[${i}]`));
  const ids = new Set<string>();
  for (const n of nodes) {
    if (ids.has(n.id)) throw new ToolInputError(`节点 id "${n.id}" 重复`);
    ids.add(n.id);
  }

  const edges = (optEdges(o.edges) ?? []).map((e, i) => parseEdge(e, i, ids));

  return {
    kind: 'diagram',
    nodes,
    edges,
    direction:
      o.direction === undefined ? undefined : oneOf(o.direction, ['down', 'right'] as const, 'spec.direction'),
    note: optStr(o.note, 'spec.note'),
  };
}

function optEdges(v: unknown): unknown[] | undefined {
  if (v === undefined || v === null) return undefined;
  return arr(v, 'spec.edges');
}

function parseEdge(v: unknown, i: number, ids: Set<string>): DiagramEdgeSpec {
  const where = `spec.edges[${i}]`;
  const o = obj(v, where);
  const from = str(o.from, `${where}.from`);
  const to = str(o.to, `${where}.to`);

  // 引用不存在的节点是最常见的错,而且不查的话布局会**静默丢掉**那条边 ——
  // 学生看到的图上凭空少一条关系
  for (const [label, id] of [['from', from], ['to', to]] as const) {
    if (!ids.has(id)) {
      throw new ToolInputError(
        `${where}.${label} 指向不存在的节点 "${id}"。已定义的节点：${[...ids].join(', ')}`,
      );
    }
  }
  if (from === to) throw new ToolInputError(`${where} 是从 "${from}" 指向自己的边,没有意义`);

  return { from, to, label: optStr(o.label, `${where}.label`) };
}

function title(spec: DiagramSpec): string {
  if (spec.note) return clip(spec.note);
  const key = spec.nodes.find((n) => n.role === 'key' || n.role === 'conclusion');
  return clip(`图：${latexToPlain((key ?? spec.nodes[0]!).label)}`);
}

export const diagramTool: TeachingTool = {
  name: 'diagram',
  description:
    '画一张流程 / 逻辑关系图:节点加连线,位置由系统自动排。\n' +
    '\n' +
    '**先说清什么时候不用它:如果内容是「一条线走到底」的推导,用 derivation,不是这个。**\n' +
    '两者的分工是:\n' +
    '  derivation = 线性的步骤链,每步带理由、还能被机器核对逐条验证\n' +
    '  diagram    = 有分支和汇合的结构\n' +
    '用 diagram 画一条直线推导,学生得到的是本可以用推导讲清楚、却画成一张关系网的东西。\n' +
    '\n' +
    '什么时候用 diagram:\n' +
    '· **证明结构**:这个证明用到了哪些引理,谁依赖谁,哪一步是真正的关键\n' +
    '· **分类讨论**:分几种情况,每种通向什么结论\n' +
    '· **逻辑等价链**:一串命题之间的等价 / 蕴含关系\n' +
    '· **算法流程**:梯度下降、反向传播这类步骤(讲 ML 时常用)\n' +
    '\n' +
    '**不要给坐标。** 位置由系统自动算 —— 你自己排的话会得到一张重叠成团的图,\n' +
    '而你看不见自己排出来的东西。你只写"有哪些节点"和"谁连着谁"。\n' +
    '\n' +
    '每个节点都可以填 role,这决定它长什么样,也是这张图的教学价值所在:\n' +
    '  given      = 前提 / 已知条件\n' +
    '  key        = 关键步骤(整个论证真正干活的地方)\n' +
    '  conclusion = 结论\n' +
    '  plain      = 普通节点(默认)\n' +
    '一张所有节点都长得一样的图只说明了"谁连着谁",说不出"谁是要紧的"。\n' +
    '\n' +
    '注意:分层布局**画不了环形关系**。如果结构里真的有"互相依赖"(比如 A 与 B 等价),\n' +
    '照实写出来即可 —— 系统会把画不出的那几条**明确标出来**,不会假装它们不存在。',
  parameters: {
    type: 'object',
    properties: {
      nodes: {
        type: 'array',
        minItems: 1,
        maxItems: 40,
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '唯一 id,供 edges 引用' },
            label: { type: 'string', description: '节点内容,LaTeX 或普通文字都行,尽量短' },
            role: {
              type: 'string',
              enum: ['plain', 'given', 'key', 'conclusion'],
              description: '语义角色,决定配色',
            },
          },
          required: ['id', 'label'],
        },
      },
      edges: {
        type: 'array',
        description: '连线。from / to 必须是上面定义过的节点 id。',
        items: {
          type: 'object',
          properties: {
            from: { type: 'string' },
            to: { type: 'string' },
            label: { type: 'string', description: '边上的短标注,例如「取反」「n > N」' },
          },
          required: ['from', 'to'],
        },
      },
      direction: {
        type: 'string',
        enum: ['down', 'right'],
        description: '层的推进方向。默认向下;横向能放更多层,适合长链。',
      },
      note: { type: 'string', description: '一句话说明这张图在讲什么' },
    },
    required: ['nodes'],
  },
  run: (args) => {
    const spec = parseDiagramSpec(args);
    return { message: `已绘制关系图：${title(spec)}`, created: [{ spec, title: title(spec) }] };
  },
};

export const diagramModule: KindModule<DiagramSpec> = {
  kind: 'diagram',
  parse: parseDiagramSpec,
  title,
  Body: Diagram,
  tool: diagramTool,
};
