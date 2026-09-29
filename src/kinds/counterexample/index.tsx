/**
 * counterexample —— 反例工作台。
 *
 * 高阶数学里「去掉这个条件还成立吗」是理解定理的主要方式,而反例是这个过程的产物。
 * 系统提示词里一直写着「反例是一等公民」,但在此之前它没有一等公民的工具 ——
 * 模型只能把反例说成一段话。这个 kind 就是把它变成可操作的东西。
 *
 * 形态上它是 **plot2d 的组合**:候选对象本来就是要画出来的函数,所以 `plot`
 * 直接复用 Plot2DSpec 的解析和渲染,参数也是同一套。这个目录里真正新增的
 * 只有「条件检查」那一层。
 */
import { useShallow } from 'zustand/react/shallow';
import { latexToPlain } from '../../lib/latex-plain';
import { clip } from '../../lib/text';
import { ToolInputError, arr, num, obj, oneOf, optNum, optStr, pair, str } from '../../lib/validate';
import { useSession } from '../../store/session';
import type { TeachingTool } from '../../tools/types';
import type { CounterexampleCheck, CounterexampleSpec, Plot2DSpec } from '../../types/artifact';
import type { KindModule, RendererProps } from '../module';
import { parseExpr, parsePlot2DSpec, plot2dTool } from '../plot2d';
import { Counterexample } from './Counterexample';

const CHECK_KINDS = ['numeric', 'sampled', 'asserted'] as const;
const OPS = ['eq', 'ne', 'gt', 'lt', 'ge', 'le'] as const;
const PROPERTIES = ['positive', 'negative', 'signChanges', 'increasing', 'decreasing'] as const;

function parseCheck(v: unknown, where: string): CounterexampleCheck {
  const o = obj(v, where);
  const id = str(o.id, `${where}.id`);
  const label = str(o.label, `${where}.label`);
  const kind = oneOf(o.kind, CHECK_KINDS, `${where}.kind`);

  switch (kind) {
    case 'asserted':
      return { id, label, kind };
    case 'numeric':
      return {
        id,
        label,
        kind,
        expr: parseExpr(o.expr, `${where}.expr`),
        op: oneOf(o.op, OPS, `${where}.op`),
        value: num(o.value, `${where}.value`),
        tol: optNum(o.tol, `${where}.tol`),
      };
    case 'sampled':
      return {
        id,
        label,
        kind,
        expr: parseExpr(o.expr, `${where}.expr`),
        property: oneOf(o.property, PROPERTIES, `${where}.property`),
        over: pair(o.over, `${where}.over`),
      };
  }
}

/**
 * 复用 plot2d 的解析。
 *
 * 但要把报错路径改对:plot2d 的校验器把所有位置都写成 `spec.xxx`,
 * 而这里的 plot 是嵌在 `spec.plot` 下面。**这些错误会原样回给模型让它自我修正**,
 * 路径指错地方它就改错地方 —— 所以宁可在这里重写一遍前缀。
 */
function parsePlot(v: unknown): Plot2DSpec {
  try {
    return parsePlot2DSpec(v);
  } catch (e) {
    if (e instanceof ToolInputError) {
      throw new ToolInputError(e.message.replace(/\bspec\./g, 'spec.plot.'));
    }
    throw e;
  }
}

export function parseCounterexampleSpec(v: unknown): CounterexampleSpec {
  const o = obj(v, 'spec');
  const hypothesesRaw = arr(o.hypotheses, 'spec.hypotheses');
  if (!hypothesesRaw.length) {
    throw new ToolInputError('spec.hypotheses 至少要有一条 —— 反例必须满足命题的前提');
  }

  const hypotheses = hypothesesRaw.map((c, i) => parseCheck(c, `spec.hypotheses[${i}]`));
  const ids = new Set<string>();
  for (const h of hypotheses) {
    if (ids.has(h.id)) throw new ToolInputError(`检查项 id "${h.id}" 在 spec.hypotheses 里重复`);
    ids.add(h.id);
  }
  const conclusion = parseCheck(o.conclusion, 'spec.conclusion');
  if (ids.has(conclusion.id)) {
    throw new ToolInputError(`结论的 id "${conclusion.id}" 和某条前提重复,每个检查项要有唯一 id`);
  }

  return {
    kind: 'counterexample',
    claim: str(o.claim, 'spec.claim'),
    plot: parsePlot(o.plot),
    hypotheses,
    conclusion,
    found: optStr(o.found, 'spec.found'),
  };
}

function title(spec: CounterexampleSpec): string {
  return clip(`反例：${latexToPlain(spec.claim)}`);
}

/** 复用 plot2d 的整份参数 schema,而不是抄一份。 */
const PLOT_SCHEMA = {
  type: 'object',
  description:
    '候选对象。字段和 plot2d 工具完全一样。params 里声明的参数会被下面的检查项引用。',
  properties: (plot2dTool.parameters as { properties: unknown }).properties,
  required: ['view', 'curves'],
};

const CHECK_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', description: '唯一 id,供界面定位' },
    label: { type: 'string', description: '给人看的一句话,例如 "f 在 0 处可导"' },
    kind: {
      type: 'string',
      enum: ['numeric', 'sampled', 'asserted'],
      description:
        'numeric = 把参数代进 expr 算一个值再和 value 比大小;' +
        'sampled = 在 over 区间上采样 expr,判 property;' +
        'asserted = 你声称成立但系统验不了(连续、可导、一致收敛这类)',
    },
    expr: { type: 'string', description: 'numeric / sampled 用的表达式,可引用 params 里的参数名' },
    op: { type: 'string', enum: ['eq', 'ne', 'gt', 'lt', 'ge', 'le'], description: 'numeric 的比较方式' },
    value: { type: 'number', description: 'numeric 要比较的目标值' },
    tol: { type: 'number', description: 'numeric 里 eq/ne 的容差,默认 1e-6' },
    property: {
      type: 'string',
      enum: ['positive', 'negative', 'signChanges', 'increasing', 'decreasing'],
      description: 'sampled 要判的性质。signChanges = 区间内既有正值也有负值',
    },
    over: {
      type: 'array',
      items: { type: 'number' },
      minItems: 2,
      maxItems: 2,
      description: 'sampled 的采样区间 [起, 止]',
    },
  },
  required: ['id', 'label', 'kind'],
};

export const counterexampleTool: TeachingTool = {
  name: 'counterexample',
  description:
    '反例工作台:让学生亲手把反例找出来。\n' +
    '**这是核心教学工具。** 高阶数学里「去掉这个条件还成立吗」是理解定理的主要方式,' +
    '而反例是这个过程的产物。不要只在对话里描述一个反例 —— 让学生自己动手找到它。\n' +
    '\n' +
    '用法:给一个命题,提供一个**带参数**的候选对象(会画在图上),列出前提和' +
    '「结论不成立」两组检查。学生拖参数,检查项实时变绿变红,凑齐全部满足的那一刻就是反例。\n' +
    '\n' +
    '检查项分三种,**选错会误导学生**:\n' +
    '  numeric  = 把参数代进 expr 算一个值再比对。例如 f\'(0)=a,写 expr:"a", op:"eq", value:0。\n' +
    '  sampled  = 在区间上采样判性质。例如「0 不是极值」写 expr:"x^3", property:"signChanges", over:[-1,1]。\n' +
    '  asserted = 你声称成立但系统验不了。连续、可导、一致收敛都属于这类。\n' +
    '\n' +
    '**能用 numeric 或 sampled 表达的,绝不要写成 asserted。** 但确实验不了的必须老实写成\n' +
    'asserted —— 不要为了让界面好看而假装算得出来。学生会看到哪些是"算出来的"、\n' +
    '哪些是"你声称的",这个区别正是这个工具的价值所在。\n' +
    '\n' +
    '参数要放在 plot.params 里,检查项的 expr 引用同一批参数名。',
  parameters: {
    type: 'object',
    properties: {
      claim: { type: 'string', description: '要反驳的命题,LaTeX' },
      plot: PLOT_SCHEMA,
      hypotheses: {
        type: 'array',
        minItems: 1,
        description: '命题的前提。反例必须让它们全部成立。',
        items: CHECK_SCHEMA,
      },
      conclusion: {
        ...CHECK_SCHEMA,
        description: '命题的结论 —— 这里要写成「结论**不成立**」的形式,因为反例正是让它失败。',
      },
      found: {
        type: 'string',
        description: '全部满足时显示的一句话,说明学生找到了什么。例如「这就是反例:f 处处可导但导数不连续」',
      },
    },
    required: ['claim', 'plot', 'hypotheses', 'conclusion'],
  },
  run: (args) => {
    const spec = parseCounterexampleSpec(args);
    const asserted = [...spec.hypotheses, spec.conclusion].filter((c) => c.kind === 'asserted').length;
    const note = asserted
      ? `(其中 ${asserted} 条只能由你声称、系统验不了 —— 已经如实标注)`
      : '(全部条件都能在参数上验,学生能自己确认)';
    return {
      message: `已创建反例工作台：${title(spec)} ${note}`,
      created: [{ spec, title: title(spec) }],
    };
  },
};

/** 滑块的初始值。和 plot2d 是同一套规则。 */
function defaultsOf(plot: Plot2DSpec): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of plot.params ?? []) out[p.name] = p.value;
  return out;
}

function Body({ spec, artifactId, rev, emit }: RendererProps<CounterexampleSpec>) {
  // useShallow 是必须的:选择器每次都构造新对象,zustand v5 按 Object.is 比较
  const scope = useSession(
    useShallow((s) => ({ ...defaultsOf(spec.plot), ...s.runtime[artifactId] })),
  );
  const setParam = useSession((s) => s.setParam);
  return (
    <Counterexample
      spec={spec}
      scope={scope}
      artifactId={artifactId}
      rev={rev}
      emit={emit}
      onParam={(name, value) => setParam(artifactId, name, value)}
    />
  );
}

export const counterexampleModule: KindModule<CounterexampleSpec> = {
  kind: 'counterexample',
  parse: parseCounterexampleSpec,
  title,
  Body,
  tool: counterexampleTool,
};
