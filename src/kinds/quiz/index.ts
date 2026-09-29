/**
 * quiz —— 即时出题与判分。
 *
 * answerKey 随 artifact 一起存在本地,渲染层在用户作答前不得把它渲染进 DOM。
 * 这不是安全问题,是别让学生 F12 一下就看见答案。
 */
import { clip } from '../../lib/text';
import { latexToPlain } from '../../lib/latex-plain';
import { ToolInputError, obj, optArr, optStr, str } from '../../lib/validate';
import type { TeachingTool } from '../../tools/types';
import type { QuizSpec } from '../../types/artifact';
import type { KindModule } from '../module';
import { Quiz } from './Quiz';

export function parseQuizSpec(v: unknown): QuizSpec {
  const o = obj(v, 'spec');
  const choicesRaw = optArr(o.choices, 'spec.choices');
  const choices = choicesRaw?.map((c, i) => {
    const co = obj(c, `spec.choices[${i}]`);
    return { id: str(co.id, `spec.choices[${i}].id`), text: str(co.text, `spec.choices[${i}].text`) };
  });
  const answerKey = optArr(o.answerKey, 'spec.answerKey')?.map((a, i) => str(a, `spec.answerKey[${i}]`));

  if (choices && answerKey) {
    const ids = new Set(choices.map((c) => c.id));
    for (const k of answerKey) {
      if (!ids.has(k)) throw new ToolInputError(`spec.answerKey 里的 "${k}" 不在 spec.choices 的 id 里`);
    }
  }
  return {
    kind: 'quiz',
    question: str(o.question, 'spec.question'),
    choices,
    answerKey,
    explanation: optStr(o.explanation, 'spec.explanation'),
    freeformPlaceholder: optStr(o.freeformPlaceholder, 'spec.freeformPlaceholder'),
  };
}
const tool: TeachingTool = {
  name: 'quiz',
  description:
    '给学生出题。**讲完一个概念后主动出题,不要等学生要求。**\n' +
    '有明确选项时给 choices;需要学生自己写证明或反例时不要给 choices,用自由作答。',
  parameters: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description:
          '题目。可以写 Markdown(加粗、列表)。' +
          '**数学式必须用 $ 包起来**,例如「关于 $2\times2$ 矩阵 A 的奇异值」。' +
          '不包的话它会被当成普通文字原样显示出来 —— 不会被渲染成公式。',
      },
      choices: {
        type: 'array',
        description: '选项。省略则为自由作答。选项文字里的数学式同样要用 $ 包起来。',
        items: {
          type: 'object',
          properties: { id: { type: 'string' }, text: { type: 'string' } },
          required: ['id', 'text'],
        },
      },
      answerKey: { type: 'array', items: { type: 'string' }, description: '正确选项的 id。作答前不会展示给学生。' },
      explanation: { type: 'string', description: '作答后展示的解析。数学式用 $ 包起来。' },
      freeformPlaceholder: { type: 'string' },
    },
    required: ['question'],
  },
  run: (args) => {
    const spec = parseQuizSpec(args);
    return { message: `已出题：${title(spec)}`, created: [{ spec, title: title(spec) }] };
  },
};

// ------------------------------------------------------------ artifact 操作
function title(spec: QuizSpec): string {
  // 不带"测验:"前缀 —— 类别由卡片头部的徽章和目录里的 kind 字段表达
  return clip(latexToPlain(spec.question));
}

export const quizModule: KindModule<QuizSpec> = {
  kind: 'quiz',
  parse: parseQuizSpec,
  title,
  Body: Quiz,
  tool,
};
