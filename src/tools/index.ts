/**
 * 教学工具注册表。
 *
 * 这些 description 不只是给模型看的文档,也是产品设计的载体:
 * 「一个图里放多条曲线」「用 unjustified 诚实标注省略的步骤」这类要求
 * 写在 schema 描述里的效果,比写在系统提示词里更牢。
 *
 * 统一约定:run() 返回给模型的是**一句话**,不是它刚写的 spec。
 * 一张 300 行的 spec 如果每轮都回灌,聊十轮上下文就爆了。
 */
import type { ArtifactIndexEntry, ArtifactSpec, CanvasArtifact } from '../types/artifact';
import { ToolInputError } from './validate';
import { parseSpec, titleFor, parsePlot2DSpec, parseDerivationSpec, parseQuizSpec } from './specs';

export interface ToolContext {
  artifacts: ArtifactIndexEntry[];
  focus?: string;
  readArtifact: (id: string) => CanvasArtifact | undefined;
}

export interface ToolOutcome {
  /** 回给模型的一句话。约定:不包含完整 spec。 */
  message: string;
  created?: { spec: ArtifactSpec; title: string }[];
  patched?: { id: string; patch: Partial<ArtifactSpec> };
}

export interface TeachingTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run: (args: unknown, ctx: ToolContext) => ToolOutcome;
}

const STYLE = {
  type: 'object',
  description: '可省略。不填则用默认配色。',
  properties: {
    color: { type: 'string', description: '十六进制色值,如 "#2563eb"' },
    dash: { type: 'string', enum: ['solid', 'dashed', 'dotted'] },
    width: { type: 'number' },
  },
};

const RANGE = (what: string) => ({
  type: 'array',
  items: { type: 'number' },
  minItems: 2,
  maxItems: 2,
  description: `${what},格式 [起, 止],必须 起 < 止`,
});

/** 画布目录的文本形式。查找失败时附在错误里,让模型能自己纠正 id。 */
function indexText(ctx: ToolContext): string {
  if (!ctx.artifacts.length) return '(画布当前为空)';
  return ctx.artifacts.map((a) => `[${a.id}] ${a.kind} ${a.title}`).join('\n');
}

// -------------------------------------------------------------------- plot2d

const plot2d: TeachingTool = {
  name: 'plot2d',
  description:
    '在画布上画一张二维图。这是最常用的工具 —— 任何能用图说清楚的东西都用它,不要用文字描述图像。\n' +
    '一个图里可以放多条曲线用于对比,请优先这样做,不要为每条函数各开一张图。',
  parameters: {
    type: 'object',
    properties: {
      view: {
        type: 'object',
        description: '坐标范围。y 省略时自动适配。',
        properties: {
          x: RANGE('x 轴范围'),
          y: RANGE('y 轴范围'),
        },
        required: ['x'],
      },
      curves: {
        type: 'array',
        minItems: 1,
        description: '要画的曲线,可以多条',
        items: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['explicit', 'parametric', 'sequence'],
              description:
                'explicit = y=f(x);parametric = 参数方程 (x(t), y(t));sequence = 数列 a_n 的点列',
            },
            expr: {
              type: 'string',
              description:
                'explicit / sequence 用的表达式。变量是 x(或数列的 n)。' +
                '幂用 ^(写 x^2,不要写 x**2)。' +
                '可以使用 params 里声明的参数名。只能用单个数学式子,不能有赋值或函数定义。',
            },
            x: { type: 'string', description: 'parametric: x 关于 t 的表达式' },
            y: { type: 'string', description: 'parametric: y 关于 t 的表达式' },
            t: RANGE('parametric: 参数 t 的范围'),
            n: RANGE('sequence: n 的范围'),
            domain: RANGE('explicit: x 的定义域,省略则用 view.x'),
            label: { type: 'string', description: '图例名称,如 "y = sin(1/x)"' },
            style: STYLE,
          },
          required: ['type'],
        },
      },
      params: {
        type: 'array',
        description:
          '可拖动滑块。声明后曲线表达式和点坐标里就可以引用这些参数名。' +
          '讲参数对图形的影响时一定要用它,让学生自己拖,比讲解十句都管用。',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '参数名,在表达式里引用' },
            value: { type: 'number', description: '初始值' },
            min: { type: 'number' },
            max: { type: 'number' },
            step: { type: 'number' },
            label: { type: 'string' },
          },
          required: ['name', 'value', 'min', 'max'],
        },
      },
      points: {
        type: 'array',
        description: '高亮的点。坐标是表达式,可以引用参数,例如 (a, f(a)) 这样随滑块移动的点。',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            at: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 2, description: '[x表达式, y表达式]' },
            label: { type: 'string' },
            movable: { type: 'boolean', description: '学生能否拖动这个点' },
            style: STYLE,
          },
          required: ['name', 'at'],
        },
      },
      annotations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            at: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 2 },
            text: { type: 'string' },
          },
          required: ['at', 'text'],
        },
      },
      note: { type: 'string', description: '一句话说明这张图要人注意什么,会显示在图上方' },
    },
    required: ['view', 'curves'],
  },
  run: (args) => {
    const spec = parsePlot2DSpec(args);
    return { message: `已绘制：${titleFor(spec)}`, created: [{ spec, title: titleFor(spec) }] };
  },
};

// ---------------------------------------------------------------- derivation

const derivation: TeachingTool = {
  name: 'derivation',
  description:
    '在画布上展示分步推导或证明。**任何超过一步的变形都要用它,不要把公式写在对话正文里。**\n' +
    '每一步都必须填 reason(用了哪条定义/定理/规则)。\n' +
    '每一步都应该填 gap,这决定了学生能不能看出哪里是重点、哪里你跳过了:\n' +
    '  technical   = 套定义或代数变形,略过不影响理解\n' +
    '  substantive = 本质的一步,证明在这里干活,值得停下来看\n' +
    '  unjustified = 你省略了或不会证的一步(务必诚实标注,不要假装完整)\n' +
    '  assumption  = 这一步引入了一个假设',
  parameters: {
    type: 'object',
    properties: {
      statement: { type: 'string', description: '要证明或推导的命题,LaTeX' },
      given: { type: 'array', items: { type: 'string' }, description: '前提条件,每项是 LaTeX' },
      collapsed: { type: 'boolean', description: '是否默认折叠后续步骤' },
      steps: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '本步的唯一 id,供 from 引用' },
            latex: { type: 'string', description: '这一步的式子,LaTeX,不要加 $ 或 $$' },
            reason: { type: 'string', description: '理由:用了哪条定义、定理或规则,一句话' },
            from: { type: 'array', items: { type: 'string' }, description: '依赖的前置步骤 id' },
            gap: { type: 'string', enum: ['technical', 'substantive', 'unjustified', 'assumption'] },
            detail: { type: 'string', description: '学生展开这一步时显示的补充说明' },
          },
          required: ['id', 'latex', 'reason'],
        },
      },
    },
    required: ['steps'],
  },
  run: (args) => {
    const spec = parseDerivationSpec(args);
    const gaps = spec.steps.filter((s) => s.gap === 'unjustified').length;
    const warn = gaps ? `（其中 ${gaps} 步标记为未证明,这是诚实的做法）` : '';
    return { message: `已展示推导：${titleFor(spec)}${warn}`, created: [{ spec, title: titleFor(spec) }] };
  },
};

// ---------------------------------------------------------------------- quiz

const quiz: TeachingTool = {
  name: 'quiz',
  description:
    '给学生出题。**讲完一个概念后主动出题,不要等学生要求。**\n' +
    '有明确选项时给 choices;需要学生自己写证明或反例时不要给 choices,用自由作答。',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: '题目,LaTeX 或 Markdown' },
      choices: {
        type: 'array',
        description: '选项。省略则为自由作答。',
        items: {
          type: 'object',
          properties: { id: { type: 'string' }, text: { type: 'string' } },
          required: ['id', 'text'],
        },
      },
      answerKey: { type: 'array', items: { type: 'string' }, description: '正确选项的 id。作答前不会展示给学生。' },
      explanation: { type: 'string', description: '作答后展示的解析' },
      freeformPlaceholder: { type: 'string' },
    },
    required: ['question'],
  },
  run: (args) => {
    const spec = parseQuizSpec(args);
    return { message: `已出题：${titleFor(spec)}`, created: [{ spec, title: titleFor(spec) }] };
  },
};

// ------------------------------------------------------------ artifact 操作

const readArtifact: TeachingTool = {
  name: 'read_artifact',
  description:
    '读取画布上某个 artifact 的完整内容。画布目录里只有 id、类型和标题,' +
    '需要看具体内容(比如学生问"刚才那个图的定义域是什么")时才调用。',
  parameters: {
    type: 'object',
    properties: { id: { type: 'string', description: 'artifact id' } },
    required: ['id'],
  },
  run: (args, ctx) => {
    const id = String((args as any)?.id ?? '');
    const art = ctx.readArtifact(id);
    if (!art) {
      throw new ToolInputError(`画布上没有 id 为 "${id}" 的内容。当前画布目录:\n${indexText(ctx)}`);
    }
    return { message: JSON.stringify(art.spec) };
  },
};

const editArtifact: TeachingTool = {
  name: 'edit_artifact',
  description:
    '修改画布上已有的内容。**要改已存在的图时必须用这个,不要重新画一张** —— ' +
    '重画会打断学生的空间记忆,也会让画布堆满近似重复的图。\n' +
    'patch 是浅合并:只需给出要改的字段,数组字段会整体替换。不能改 kind。',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: '要修改的 artifact id' },
      patch: {
        type: 'object',
        description:
          '要覆盖的字段。例如把 x 轴拉宽并换掉曲线:{"view": {"x": [-10, 10]}, "curves": [...]}',
      },
    },
    required: ['id', 'patch'],
  },
  run: (args, ctx) => {
    const a = (args ?? {}) as Record<string, unknown>;
    const id = typeof a.id === 'string' ? a.id : '';
    const patch = a.patch;
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new ToolInputError('patch 必须是一个对象');
    }
    const art = ctx.readArtifact(id);
    if (!art) {
      throw new ToolInputError(`画布上没有 id 为 "${id}" 的内容。当前画布目录:\n${indexText(ctx)}`);
    }
    const merged = { ...art.spec, ...(patch as object) };
    if ((merged as any).kind !== art.spec.kind) {
      throw new ToolInputError(`不能通过 edit_artifact 改变 kind(当前是 ${art.spec.kind})。要换类型请用对应的新建工具。`);
    }
    const spec = parseSpec(merged);
    if (spec.kind === 'plot2d') parsePlot2DSpec(spec);
    const title = titleFor(spec);
    return { message: `已更新 [${id}] → ${title}`, patched: { id, patch: spec } };
  },
};

export const TOOLS: TeachingTool[] = [plot2d, derivation, quiz, readArtifact, editArtifact];

export function toolByName(name: string): TeachingTool | undefined {
  return TOOLS.find((t) => t.name === name);
}

/** 转成 OpenAI 兼容的 tools 字段。 */
export function toOpenAiTools(): unknown[] {
  return TOOLS.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/** 降级路径用:把工具说明渲染成纯文本塞进提示词。 */
export function toolsAsText(): string {
  return TOOLS.filter((t) => t.name !== 'read_artifact' && t.name !== 'edit_artifact')
    .map((t) => `### ${t.name}\n${t.description}\n参数 JSON Schema:\n${JSON.stringify(t.parameters)}`)
    .join('\n\n');
}
