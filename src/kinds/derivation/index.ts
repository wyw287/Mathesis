/**
 * derivation —— 分步推导与证明。
 *
 * 这个 kind 是产品区别于通用讲题助手的地方:`gap` 字段强制模型标注每一步的性质
 * (套定义 / 本质步骤 / 被跳过 / 引入假设)。校验器不强制它,但工具描述和系统
 * 提示词都要求它 —— 见 docs/artifact-schema.md §3.2。
 */
import { clip } from '../../lib/text';
import { latexToPlain } from '../../lib/latex-plain';
import { ToolInputError, arr, obj, oneOf, optArr, optBool, optStr, str } from '../../lib/validate';
import type { TeachingTool } from '../../tools/types';
import type { DerivationSpec, DerivationStep, GapKind } from '../../types/artifact';
import type { KindModule } from '../module';
import { Derivation } from './Derivation';

const GAPS: readonly GapKind[] = ['technical', 'substantive', 'unjustified', 'assumption'];

export function parseDerivationSpec(v: unknown): DerivationSpec {
  const o = obj(v, 'spec');
  const stepsRaw = arr(o.steps, 'spec.steps');
  if (!stepsRaw.length) throw new ToolInputError('spec.steps 不能为空');

  const seen = new Set<string>();
  const steps: DerivationStep[] = stepsRaw.map((s, i) => {
    const so = obj(s, `spec.steps[${i}]`);
    const id = str(so.id, `spec.steps[${i}].id`);
    if (seen.has(id)) throw new ToolInputError(`spec.steps[${i}].id "${id}" 重复,每步的 id 必须唯一`);
    seen.add(id);
    return {
      id,
      latex: str(so.latex, `spec.steps[${i}].latex`),
      reason: str(so.reason, `spec.steps[${i}].reason`),
      from: optArr(so.from, `spec.steps[${i}].from`)?.map((f, j) => str(f, `spec.steps[${i}].from[${j}]`)),
      gap: so.gap === undefined ? undefined : oneOf(so.gap, GAPS, `spec.steps[${i}].gap`),
      detail: optStr(so.detail, `spec.steps[${i}].detail`),
    };
  });

  // from 指向不存在的 step 是模型常犯的错,早点报出来
  for (const s of steps) {
    for (const f of s.from ?? []) {
      if (!seen.has(f)) throw new ToolInputError(`步骤 "${s.id}" 的 from 引用了不存在的步骤 "${f}"`);
    }
  }

  return {
    kind: 'derivation',
    statement: optStr(o.statement, 'spec.statement'),
    given: optArr(o.given, 'spec.given')?.map((g, i) => str(g, `spec.given[${i}]`)),
    steps,
    collapsed: optBool(o.collapsed, 'spec.collapsed'),
  };
}
const tool: TeachingTool = {
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
    return { message: `已展示推导：${title(spec)}${warn}`, created: [{ spec, title: title(spec) }] };
  },
};

// ---------------------------------------------------------------------- quiz
function title(spec: DerivationSpec): string {
  return clip(spec.statement ? `推导：${latexToPlain(spec.statement)}` : '推导');
}

export const derivationModule: KindModule<DerivationSpec> = {
  kind: 'derivation',
  parse: parseDerivationSpec,
  title,
  Body: Derivation,
  tool,
};
