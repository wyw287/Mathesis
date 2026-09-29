/**
 * 契约自检。
 *
 * 校验器是整份契约的执行者,而它处理的是**模型的输出** —— 也就是说,
 * 它的输入空间是不可预测的。这个脚本用一批「模型真会写出来的东西」
 * 来检查校验器该放的放行、该拦的拦住。
 *
 * 运行:npm run check
 */
import { parseSpec, titleFor } from '../src/tools/specs';
import { extractArtifactBlocks, stripArtifactBlocks } from '../src/llm/fallback';
import { ToolInputError } from '../src/tools/validate';

let pass = 0;
let fail = 0;

function ok(name: string, fn: () => void) {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name}\n      ${(e as Error).message}`);
  }
}

/** 断言这段输入应当被拒绝,且错误信息里提到某个关键词。 */
function rejects(name: string, input: unknown, keyword?: string) {
  ok(name, () => {
    try {
      parseSpec(input);
    } catch (e) {
      if (!(e instanceof ToolInputError)) throw new Error(`抛的是 ${(e as Error).name},不是 ToolInputError`);
      if (keyword && !e.message.includes(keyword)) {
        throw new Error(`错误信息没提到 "${keyword}":${e.message}`);
      }
      return;
    }
    throw new Error('本该被拒绝,却通过了校验');
  });
}

console.log('\nplot2d');
ok('最小合法输入', () => {
  const s = parseSpec({
    kind: 'plot2d',
    view: { x: [-5, 5] },
    curves: [{ type: 'explicit', expr: 'sin(1/x)' }],
  });
  if (s.kind !== 'plot2d') throw new Error('kind 错了');
});
ok('e^(-x^2) 这类指数写法', () => {
  parseSpec({ kind: 'plot2d', view: { x: [-3, 3] }, curves: [{ type: 'explicit', expr: 'e^(-x^2)' }] });
});
ok('参数滑块 + 引用参数的点', () => {
  const s = parseSpec({
    kind: 'plot2d',
    view: { x: [-5, 5] },
    curves: [{ type: 'explicit', expr: 'x^2 + a*x' }],
    params: [{ name: 'a', value: 0, min: -5, max: 5 }],
    points: [{ name: 'V', at: ['-a/2', '-(a^2)/4'] }],
  });
  if (s.kind === 'plot2d' && s.points?.[0].at[0] !== '-a/2') throw new Error('点坐标没保留');
});
ok('参数初始值超出范围时被夹取', () => {
  const s = parseSpec({
    kind: 'plot2d',
    view: { x: [0, 1] },
    curves: [{ type: 'explicit', expr: 'x' }],
    params: [{ name: 'a', value: 99, min: 0, max: 1 }],
  });
  if (s.kind === 'plot2d' && s.params?.[0].value !== 1) throw new Error(`没夹取,得到 ${s.params?.[0].value}`);
});

rejects('缺 curves', { kind: 'plot2d', view: { x: [0, 1] }, curves: [] }, 'curves');
rejects('x 范围反了', { kind: 'plot2d', view: { x: [5, -5] }, curves: [{ type: 'explicit', expr: 'x' }] }, '起 < 止');
rejects('表达式里写函数定义', {
  kind: 'plot2d',
  view: { x: [0, 1] },
  curves: [{ type: 'explicit', expr: 'f(x) = x^2' }],
}, '表达式');
rejects('表达式语法错误', {
  kind: 'plot2d',
  view: { x: [0, 1] },
  curves: [{ type: 'explicit', expr: 'sin(' }],
}, '表达式');
rejects('未知 kind', { kind: 'plot3d', view: {}, curves: [] }, 'kind');

console.log('\nderivation');
ok('合法推导 + gap 标注', () => {
  const s = parseSpec({
    kind: 'derivation',
    statement: '\\lim_{x\\to 0}\\sin(1/x)\\ \\text{不存在}',
    steps: [
      { id: 's1', latex: 'x_n = \\frac{1}{n\\pi}', reason: '取一列趋于 0 的点', gap: 'substantive' },
      { id: 's2', latex: 'f(x_n) = 0', reason: '代入', from: ['s1'], gap: 'technical' },
      { id: 's3', latex: '\\text{另一列给出 1}', reason: '需要取子列论证', gap: 'unjustified' },
    ],
  });
  if (s.kind === 'derivation' && s.steps.length !== 3) throw new Error('步骤数不对');
});
rejects('步骤 id 重复', {
  kind: 'derivation',
  steps: [
    { id: 'a', latex: '1', reason: 'r' },
    { id: 'a', latex: '2', reason: 'r' },
  ],
}, '重复');
rejects('from 指向不存在的步骤', {
  kind: 'derivation',
  steps: [{ id: 'a', latex: '1', reason: 'r', from: ['zzz'] }],
}, '不存在');
rejects('gap 用了没定义的值', {
  kind: 'derivation',
  steps: [{ id: 'a', latex: '1', reason: 'r', gap: 'important' }],
}, 'gap');

console.log('\nquiz');
ok('选择题', () => {
  parseSpec({
    kind: 'quiz',
    question: '这个极限存在吗?',
    choices: [
      { id: 'A', text: '存在' },
      { id: 'B', text: '不存在' },
    ],
    answerKey: ['B'],
  });
});
rejects('answerKey 指向不存在的选项', {
  kind: 'quiz',
  question: 'q',
  choices: [{ id: 'A', text: 'a' }],
  answerKey: ['C'],
}, 'answerKey');

console.log('\n标题生成(上下文压缩的抓手)');
ok('显式曲线', () => {
  const s = parseSpec({ kind: 'plot2d', view: { x: [0, 1] }, curves: [{ type: 'explicit', expr: 'sin(1/x)' }] });
  if (titleFor(s) !== 'y = sin(1/x)') throw new Error(`得到 "${titleFor(s)}"`);
});
ok('标题过长时截断', () => {
  const s = parseSpec({
    kind: 'plot2d',
    view: { x: [0, 1] },
    curves: [{ type: 'explicit', expr: 'x', label: '一'.repeat(80) }],
  });
  if (titleFor(s).length > 43) throw new Error(`没截断:${titleFor(s).length} 字`);
});

console.log('\n降级路径:从文本里抠 spec');
ok('抽出合法的 artifact 块', () => {
  const text = '先看这张图。\n\n```artifact\n{"kind":"plot2d","view":{"x":[0,1]},"curves":[{"type":"explicit","expr":"x"}]}\n```\n\n注意端点。';
  const blocks = extractArtifactBlocks(text);
  if (blocks.length !== 1) throw new Error(`抽出 ${blocks.length} 块,应为 1`);
  parseSpec(blocks[0].spec);
});
ok('JSON 坏掉时跳过而不是抛错', () => {
  const blocks = extractArtifactBlocks('```artifact\n{不是合法 JSON,,,}\n```');
  if (blocks.length !== 0) throw new Error('坏块没被跳过');
});
ok('去掉块后正文仍然完整', () => {
  const text = '前\n\n```artifact\n{"kind":"quiz","question":"q"}\n```\n\n后';
  const cleaned = stripArtifactBlocks(text);
  if (!cleaned.includes('前') || !cleaned.includes('后')) throw new Error(`正文被吃掉了:"${cleaned}"`);
});

console.log(`\n${pass} 通过, ${fail} 失败\n`);
if (fail) process.exit(1);
