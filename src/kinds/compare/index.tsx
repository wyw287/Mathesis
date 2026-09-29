/**
 * compare —— 并排对比。
 *
 * 正例 vs 反例、f vs f′、两个反例对照 —— 教学效果最强的单项往往是"放在一起看"。
 *
 * 形态上和 counterexample 一样是**组合**:嵌进去的 spec 交给它们各自的解析器和
 * 渲染器,这个 kind 只负责布局和那句要点。
 *
 * 因为不能 import 注册表(那会形成 compare → registry → compare 的环),
 * 所以这里直接 import 被组合的那两个 kind —— 和反例 import plot2d 是同一种做法。
 * 代价是能并排的对象是**显式枚举**的,不是任意 kind。这反而是好事:
 * "什么适合并排看"本来就是有答案的。
 */
import { clip } from '../../lib/text';
import { ToolInputError, arr, obj, oneOf, optStr, relabelSpecPaths, str } from '../../lib/validate';
import type { TeachingTool } from '../../tools/types';
import type { CompareItem, CompareSpec } from '../../types/artifact';
import { parseDerivationSpec } from '../derivation';
import type { KindModule } from '../module';
import { parsePlot2DSpec } from '../plot2d';
import { Compare } from './Compare';

/** 能并排看的两种东西。图对图、推导对推导,或者图对推导。 */
const ITEM_KINDS = ['plot2d', 'derivation'] as const;

const ITEM_SCHEMA = {
  type: 'object',
  properties: {
    label: {
      type: 'string',
      description: '这一格的标题,例如 "f(x)"、"f\'(x)"、"a = 1 时的反例"',
    },
    spec: {
      type: 'object',
      description:
        '这一格的内容。kind 取 "plot2d" 时,字段和 plot2d 工具的参数完全一样' +
        '(view / curves / params / points / annotations / note);' +
        '取 "derivation" 时,和 derivation 工具的参数完全一样(statement / given / steps)。',
      properties: {
        kind: { type: 'string', enum: ['plot2d', 'derivation'] },
      },
      required: ['kind'],
    },
  },
  required: ['label', 'spec'],
};

function parseItem(v: unknown, where: string): CompareItem {
  const o = obj(v, where);
  const label = str(o.label, `${where}.label`);
  const inner = obj(o.spec, `${where}.spec`);
  const kind = oneOf(inner.kind, ITEM_KINDS, `${where}.spec.kind`);

  // 用 relabelSpecPaths 把内部的 `spec.` 改成嵌套后的真实路径:
  // 报错会回给模型让它自己修,路径指错地方它就改错地方
  const at = `${where}.spec`;
  const spec =
    kind === 'plot2d'
      ? relabelSpecPaths(parsePlot2DSpec, at)(inner)
      : relabelSpecPaths(parseDerivationSpec, at)(inner);

  return { label, spec };
}

export function parseCompareSpec(v: unknown): CompareSpec {
  const o = obj(v, 'spec');
  const raw = arr(o.items, 'spec.items');
  if (raw.length < 2) {
    throw new ToolInputError(`spec.items 至少要两格 —— 一格没有"对比"可言(收到 ${raw.length} 格)`);
  }
  if (raw.length > 3) {
    throw new ToolInputError(`spec.items 最多三格,再多就挤得看不清了(收到 ${raw.length} 格)`);
  }

  const note = optStr(o.note, 'spec.note');
  if (!note) {
    // 没有要点的话,并排只是两张图 —— 学生不会自己知道该看哪里。
    // 这一条不做成硬校验,但工具描述里说得很重。
    console.warn('[mathesis] compare 没有 note,对比会失去大部分价值');
  }

  return {
    kind: 'compare',
    items: raw.map((it, i) => parseItem(it, `spec.items[${i}]`)),
    claim: optStr(o.claim, 'spec.claim'),
    note,
  };
}

function title(spec: CompareSpec): string {
  // 不带"对比:"前缀 —— 类别由卡片头部的徽章和目录里的 kind 字段表达。
  // 各格自己的 label 是模型给的短标签,已经是最好的名字了。
  return clip(spec.items.map((i) => i.label).join(' / '));
}

export const compareTool: TeachingTool = {
  name: 'compare',
  description:
    '把两三个东西**并排放在一起**给学生看。\n' +
    '\n' +
    '什么时候用:正例与反例对照、f 与 f′ 对照、同一函数在不同参数下的样子、' +
    '两种解法并排。**这些场景用并排的效果比先后展示强得多** —— ' +
    '差异是看出来,不是讲出来的。\n' +
    '\n' +
    '两个格子共享同一套参数(写在各自 spec 的 params 里,同名的会联动),\n' +
    '所以拖一个滑块两边同时变 —— 这正是对比最有用的形态:' +
    '"同一个 a 对两个函数各有什么影响",一眼就能看出来。\n' +
    '\n' +
    '**`note` 是必填的心智**:它要说清"请对比看哪个点"。没有这句话,并排只是\n' +
    '两张图,学生不会自己知道该看哪里。不要写"注意这两个函数的区别"这种空话,\n' +
    '要说具体:比如"注意 f 的两个极值点恰好是 f′ 的两个零点"。\n' +
    '\n' +
    '每格只能放 plot2d 或 derivation。要对比反例,把反例里的那张图放进来即可。\n' +
    '\n' +
    '共享的参数**只在一个格子里声明**(写在它的 plot.params 里),另一个格子直接用同名参数。' +
    '两格都声明的话会出现两个绑在同一份值上的滑块,虽然不会错,但看着重复。',
  parameters: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        minItems: 2,
        maxItems: 3,
        description: '两到三格,按从左到右的顺序',
        items: ITEM_SCHEMA,
      },
      claim: { type: 'string', description: '正在讨论的命题或问题,可选' },
      note: {
        type: 'string',
        description:
          '要学生注意的那个对比点。**这是对比的意义所在** —— 说具体,' +
          '比如"f′ 的零点正好是 f 的极值点",而不是"注意它们的区别"。',
      },
    },
    required: ['items', 'note'],
  },
  run: (args) => {
    const spec = parseCompareSpec(args);
    return {
      message: `已并排展示：${spec.items.map((i) => i.label).join(' / ')}`,
      created: [{ spec, title: title(spec) }],
    };
  },
};

export const compareModule: KindModule<CompareSpec> = {
  kind: 'compare',
  parse: parseCompareSpec,
  title,
  Body: Compare,
  tool: compareTool,
};
