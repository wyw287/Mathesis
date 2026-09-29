/**
 * 契约自检。
 *
 * 校验器是整份契约的执行者,而它处理的是**模型的输出** —— 也就是说,
 * 它的输入空间是不可预测的。这个脚本用一批「模型真会写出来的东西」
 * 来检查校验器该放的放行、该拦的拦住。
 *
 * 运行:npm run check
 */
import { parseSpec, titleFor, reconcileArtifacts } from '../src/kinds/registry';
import { evaluateAll } from '../src/kinds/counterexample/checks';
import { collapseOverEscaped, latexToPlain } from '../src/lib/latex-plain';
import { TITLE_MAX } from '../src/lib/text';
import { TOOLS } from '../src/tools';
import { extractArtifactBlocks, stripArtifactBlocks } from '../src/llm/fallback';
import { ToolInputError } from '../src/lib/validate';
import { CURRENT_SCHEMA_VERSION, type CanvasArtifact } from '../src/types/artifact';

let pass = 0;
let fail = 0;

/**
 * 同时接受回调和布尔值。
 *
 * 这份脚本原本只收回调,而另外两份检查脚本收布尔值 —— 签名不一致本身就埋了个坑:
 * 传布尔值进来会被当成 `fn()` 调用而抛「不是函数」,所有断言全红但原因看不出来。
 */
function ok(name: string, check: (() => void) | boolean, detail?: unknown) {
  try {
    if (typeof check === 'function') check();
    else if (!check) throw new Error(detail === undefined ? '断言为假' : String(detail));
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
rejects('未知 kind', { kind: 'plot4d', view: {}, curves: [] }, 'kind');

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

console.log('\n标题拍平 —— 标题既要给人看,也要每轮进模型的上下文');
ok('命题里的 LaTeX 被拍成可读文本', () => {
  const t = titleFor(
    parseSpec({
      kind: 'derivation',
      statement: String.raw`\lim_{x\to 0}\sin\frac{1}{x}\ \text{不存在}`,
      steps: [{ id: 'a', latex: '1', reason: 'r' }],
    }),
  );
  if (t.includes('\\')) throw new Error(`还有反斜杠：${t}`);
  if (!t.includes('不存在')) throw new Error(`丢了 \text{} 里的中文：${t}`);
  if (!t.includes('lim')) throw new Error(`丢了 lim：${t}`);
  if (!t.includes('→')) throw new Error(`\\to 没拍成箭头：${t}`);
  if (!t.includes('1/x')) throw new Error(`分数没拍成 a/b：${t}`);
  if (t.includes('{') || t.includes('}')) throw new Error(`还有花括号：${t}`);
});
ok('集合写法被拍平', () => {
  const t = titleFor(
    parseSpec({
      kind: 'derivation',
      statement: String.raw`\mathbb{R}\setminus\{0\}`,
      steps: [{ id: 'a', latex: '1', reason: 'r' }],
    }),
  );
  // \mathbb{R} → R,\setminus → \,转义的 \{ \} 是字面花括号所以要保留。
  // 断言不能写成「不含反斜杠」—— \setminus 拍成 \ 正是正确结果。
  if (t !== 'R\\{0}') throw new Error(`得到 "${t}"`);
});
ok('测验标题不含美元符号', () => {
  const t = titleFor(parseSpec({ kind: 'quiz', question: String.raw`$\lim_{x\to 0}f(x)$ 存在吗?` }));
  if (t.includes('$')) throw new Error(`还有美元符号：${t}`);
});
ok('plot2d 标题不受影响', () => {
  // mathjs 表达式里没有反斜杠,拍平函数不该动它
  const t = titleFor(
    parseSpec({ kind: 'plot2d', view: { x: [0, 1] }, curves: [{ type: 'explicit', expr: 'sin(1/x)' }] }),
  );
  if (t !== 'y = sin(1/x)') throw new Error(`得到 "${t}"`);
});

console.log('\n标题是派生数据 —— 载入时必须重算');
ok('旧的原始 LaTeX 标题在载入时被拍平', () => {
  const stale: CanvasArtifact = {
    id: 'x1',
    spec: {
      kind: 'derivation',
      statement: String.raw`\lim_{x\to 0}\sin\frac{1}{x}\ \text{不存在}`,
      steps: [{ id: 'a', latex: '1', reason: 'r' }],
    },
    rev: 1,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    origin: 'ai',
    // 旧版本代码存下来的标题,长这样
    title: String.raw`推导：\lim_{x\to 0}\sin\frac{1}{x}\ \text{不存`,
    createdAt: 0,
    updatedAt: 0,
  };
  const [fresh] = reconcileArtifacts([stale]);
  if (fresh.title.includes('\\')) throw new Error(`旧标题没被重算：${fresh.title}`);
  if (!fresh.title.includes('不存在')) throw new Error(`重算结果丢了内容：${fresh.title}`);
});
ok('标题已经正确时不新建对象、也不新建数组', () => {
  const a: CanvasArtifact = {
    id: 'x2',
    spec: { kind: 'quiz', question: '这个极限存在吗?' },
    rev: 1,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    origin: 'ai',
    title: '这个极限存在吗?',
    createdAt: 0,
    updatedAt: 0,
  };
  const input = [a];
  if (reconcileArtifacts(input) !== input) {
    throw new Error('无谓地新建了数组,App 挂载时会白白触发一次重渲染');
  }
  if (reconcileArtifacts(input)[0] !== a) throw new Error('无谓地新建了 artifact 对象');
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


console.log('\n反例工作台 —— 解析');
const CE_SPEC = {
  kind: 'counterexample',
  claim: "f'(0)=0 \Rightarrow 0 \text{ 是极值}",
  plot: {
    view: { x: [-2, 2] },
    curves: [{ type: 'explicit', expr: 'x^3 + a*x' }],
    params: [{ name: 'a', value: 1, min: -2, max: 2 }],
  },
  hypotheses: [{ id: 'h1', label: "f'(0) = 0", kind: 'numeric', expr: 'a', op: 'eq', value: 0 }],
  conclusion: { id: 'c1', label: '0 不是极值', kind: 'sampled', expr: 'x^3', property: 'signChanges', over: [-1, 1] },
};

ok('能解析出一个反例工作台', () => {
  const s = parseSpec(CE_SPEC) as any;
  if (s.kind !== 'counterexample') throw new Error('kind 错了');
  if (s.plot.kind !== 'plot2d') throw new Error('嵌套的 plot 没被补上 kind');
  if (s.hypotheses.length !== 1) throw new Error('前提数量不对');
});
ok('三种可信度都能表达', () => {
  const s = parseSpec({
    ...CE_SPEC,
    hypotheses: [
      { id: 'a', label: '处处连续', kind: 'asserted' },
      { id: 'b', label: 'f(0)=0', kind: 'numeric', expr: 'a*0', op: 'eq', value: 0 },
      { id: 'c', label: '恒正', kind: 'sampled', expr: 'x^2+1', property: 'positive', over: [-1, 1] },
    ],
  }) as any;
  if (s.hypotheses[0].kind !== 'asserted') throw new Error('asserted 没保留');
});
ok('嵌套 plot 的报错路径指向 spec.plot', () => {
  try {
    parseSpec({ ...CE_SPEC, plot: { view: { x: [5, -5] }, curves: [{ type: 'explicit', expr: 'x' }] } });
  } catch (e) {
    const m = (e as Error).message;
    if (!m.includes('spec.plot.view')) throw new Error('路径没改对:' + m);
    return;
  }
  throw new Error('本该被拒绝');
});
rejects('缺前提', { ...CE_SPEC, hypotheses: [] }, 'hypotheses');
rejects('检查项 id 重复', { ...CE_SPEC, hypotheses: [{ ...CE_SPEC.hypotheses[0], id: 'c1' }] }, '');
rejects('不认识的采样性质', {
  ...CE_SPEC,
  conclusion: { id: 'c1', label: 'x', kind: 'sampled', expr: 'x', property: 'nope', over: [-1, 1] },
}, 'property');

console.log('\n反例工作台 —— 求值');

ok('前提不满足时不算反例', () => {
  const { verdict } = evaluateAll(parseSpec(CE_SPEC) as any, { a: 1 });
  if (verdict.found) throw new Error("a=1 时 f'(0)≠0,不该判成反例");
  if (verdict.hypothesesOk) throw new Error('前提应该是不满足的');
});
ok('参数满足时判成找到了反例', () => {
  const { verdict } = evaluateAll(parseSpec(CE_SPEC) as any, { a: 0 });
  if (!verdict.found) throw new Error('a=0 就是反例,应该判成立');
});
ok('asserted 既不算通过也不算失败,而且被单独计数', () => {
  const spec = parseSpec({
    ...CE_SPEC,
    hypotheses: [
      { id: 'h1', label: '处处连续', kind: 'asserted' },
      { id: 'h2', label: "f'(0)=0", kind: 'numeric', expr: 'a', op: 'eq', value: 0 },
    ],
  }) as any;
  const { hypotheses, verdict } = evaluateAll(spec, { a: 0 });
  if (hypotheses[0].status !== 'asserted') throw new Error('asserted 被算成了 ' + hypotheses[0].status);
  if (verdict.assertedCount !== 1) throw new Error('没数出来:' + verdict.assertedCount);
  if (!verdict.found) throw new Error('asserted 应当算作满足,否则任何反例都无法成立');
});
ok('六种数值比较都对', () => {
  const cases: [string, number, boolean][] = [
    ['eq', 2, true], ['eq', 3, false], ['ne', 3, true], ['ne', 2, false],
    ['gt', 1, true], ['lt', 3, true], ['ge', 2, true], ['le', 2, true],
  ];
  for (const [op, value, want] of cases) {
    const spec = parseSpec({ ...CE_SPEC, hypotheses: [{ id: 'h', label: 'x', kind: 'numeric', expr: 'a', op, value }] }) as any;
    const { hypotheses } = evaluateAll(spec, { a: 2 });
    if ((hypotheses[0].status === 'pass') !== want) {
      throw new Error(op + ' ' + value + ' 应' + (want ? '' : '不') + '通过,得到 ' + hypotheses[0].status);
    }
  }
});
ok('采样判性质:恒正 / 变号 / 单调', () => {
  const mk = (expr: string, property: string, over: number[]) =>
    evaluateAll(
      parseSpec({ ...CE_SPEC, hypotheses: [{ id: 'h', label: 'x', kind: 'sampled', expr, property, over }] }) as any,
      { a: 0 },
    ).hypotheses[0].status;
  if (mk('x^2+1', 'positive', [-1, 1]) !== 'pass') throw new Error('x²+1 在 [-1,1] 上应当恒正');
  if (mk('x^2-1', 'positive', [-1, 1]) !== 'fail') throw new Error('x²-1 不恒正');
  if (mk('x', 'signChanges', [-1, 1]) !== 'pass') throw new Error('x 在 [-1,1] 上变号');
  if (mk('x^2', 'signChanges', [-1, 1]) !== 'fail') throw new Error('x² 不变号');
  if (mk('x', 'increasing', [-1, 1]) !== 'pass') throw new Error('x 单调增');
  if (mk('x^2', 'increasing', [-1, 1]) !== 'fail') throw new Error('x² 在 [-1,1] 上不单调');
});
ok('采不到点时不当作通过', () => {
  const { hypotheses } = evaluateAll(
    parseSpec({
      ...CE_SPEC,
      hypotheses: [{ id: 'h', label: 'x', kind: 'sampled', expr: 'sqrt(-1-x^2)', property: 'positive', over: [0, 1] }],
    }) as any,
    { a: 0 },
  );
  if (hypotheses[0].status !== 'fail') throw new Error('应当判失败,得到 ' + hypotheses[0].status);
});

console.log('\n并排对比 —— 解析');

const CMP_SPEC = {
  kind: 'compare',
  items: [
    { label: 'f(x)', spec: { kind: 'plot2d', view: { x: [-2, 2] }, curves: [{ type: 'explicit', expr: 'x^3' }] } },
    { label: "f'(x)", spec: { kind: 'plot2d', view: { x: [-2, 2] }, curves: [{ type: 'explicit', expr: '3*x^2' }] } },
  ],
  note: 'f 的极值点恰好是 f′ 的零点',
};

ok('能解析出两格对比', () => {
  const s = parseSpec(CMP_SPEC);
  if (s.kind !== 'compare') throw new Error('kind 错了');
  if (s.items.length !== 2) throw new Error('格数不对');
  if (s.items[0].spec.kind !== 'plot2d') throw new Error('嵌的 plot 没被补上 kind');
  if (s.items[0].label !== 'f(x)') throw new Error('标签丢了');
});
ok('三格也可以', () => {
  const s = parseSpec({
    ...CMP_SPEC,
    items: [...CMP_SPEC.items, { label: 'f″(x)', spec: { kind: 'plot2d', view: { x: [-2, 2] }, curves: [{ type: 'explicit', expr: '6*x' }] } }],
  });
  if (s.kind !== 'compare' || s.items.length !== 3) throw new Error('三格没通过');
});
ok('格子里也能放推导', () => {
  const s = parseSpec({
    ...CMP_SPEC,
    items: [
      CMP_SPEC.items[0],
      { label: '推导', spec: { kind: 'derivation', steps: [{ id: 'a', latex: '1=1', reason: '显然' }] } },
    ],
  });
  if (s.kind !== 'compare' || s.items[1].spec.kind !== 'derivation') throw new Error('推导没被解析');
});
ok('嵌套报错路径指向具体是哪一格', () => {
  // 这些错误会回给模型让它自我修正,只写 spec.view 的话它不知道改哪一格
  try {
    parseSpec({ ...CMP_SPEC, items: [CMP_SPEC.items[0], { label: 'x', spec: { kind: 'plot2d', view: { x: [5, -5] }, curves: [{ type: 'explicit', expr: 'x' }] } }] });
  } catch (e) {
    const m = (e as Error).message;
    if (!m.includes('spec.items[1].spec.view')) throw new Error('路径没改对:' + m);
    return;
  }
  throw new Error('本该被拒绝');
});
rejects('只有一格', { ...CMP_SPEC, items: [CMP_SPEC.items[0]] }, '至少');
rejects('四格', {
  ...CMP_SPEC,
  items: [1, 2, 3, 4].map((i) => ({ label: `g${i}`, spec: { kind: 'plot2d', view: { x: [0, 1] }, curves: [{ type: 'explicit', expr: 'x' }] } })),
}, '最多');
rejects('格子里放不支持的类型', {
  ...CMP_SPEC,
  items: [CMP_SPEC.items[0], { label: '测验', spec: { kind: 'quiz', question: '?' } }],
}, 'kind');
rejects('格子缺 label', {
  ...CMP_SPEC,
  items: [CMP_SPEC.items[0], { spec: CMP_SPEC.items[1].spec }],
}, 'label');

console.log('\n三维曲面 —— 解析');

const S3_HEIGHT = {
  kind: 'plot3d',
  surface: { type: 'height', expr: 'x^2 - y^2', over: { x: [-2, 2], y: [-2, 2] } },
};

ok('高度图能解析', () => {
  const s = parseSpec(S3_HEIGHT);
  if (s.kind !== 'plot3d') throw new Error('kind 错了');
  if (s.surface.type !== 'height') throw new Error('surface 类型错了');
  if (s.surface.over.x[1] !== 2) throw new Error('范围丢了');
});
ok('参数曲面能解析', () => {
  const s = parseSpec({
    kind: 'plot3d',
    surface: {
      type: 'parametric',
      x: 'R*cos(u)*sin(v)',
      y: 'R*sin(u)*sin(v)',
      z: 'R*cos(v)',
      over: { u: [0, 6.2832], v: [0, 3.1416] },
    },
    params: [{ name: 'R', value: 1, min: 0.5, max: 3 }],
  });
  if (s.kind !== 'plot3d' || s.surface.type !== 'parametric') throw new Error('没解析成参数曲面');
  if (s.params?.[0].name !== 'R') throw new Error('参数丢了');
});
ok('分辨率和参数都夹在合理区间', () => {
  const lo = parseSpec({ ...S3_HEIGHT, resolution: 2 });
  const hi = parseSpec({ ...S3_HEIGHT, resolution: 9999 });
  if (lo.kind !== 'plot3d' || hi.kind !== 'plot3d') throw new Error('kind 错了');
  if (lo.resolution !== 8) throw new Error(`下界没夹住:${lo.resolution}`);
  if (hi.resolution !== 90) throw new Error(`上界没夹住:${hi.resolution}`);
});
ok('标题优先用 label', () => {
  const s = parseSpec({ ...S3_HEIGHT, surface: { ...S3_HEIGHT.surface, label: '马鞍面' } });
  if (titleFor(s) !== '马鞍面') throw new Error(`得到 ${titleFor(s)}`);
});
ok('没有 label 时用表达式做标题', () => {
  const t = titleFor(parseSpec(S3_HEIGHT));
  if (!t.includes('x^2 - y^2')) throw new Error(`得到 ${t}`);
});
rejects('未知的曲面类型', {
  ...S3_HEIGHT,
  surface: { type: 'implicit', expr: 'x^2+y^2+z^2-1', over: { x: [-1, 1], y: [-1, 1] } },
}, 'type');
rejects('高度图缺 over.x', {
  ...S3_HEIGHT,
  surface: { type: 'height', expr: 'x', over: { y: [-1, 1] } },
}, 'over.x');
rejects('参数曲面缺 z 分量', {
  kind: 'plot3d',
  surface: { type: 'parametric', x: 'u', y: 'v', over: { u: [0, 1], v: [0, 1] } },
}, 'z');
rejects('表达式里写赋值', {
  ...S3_HEIGHT,
  surface: { type: 'height', expr: 'f(x) = x^2', over: { x: [-1, 1], y: [-1, 1] } },
}, '表达式');

console.log('\n推导步骤的机器可读形式');

const DERIV_CHECK = {
  kind: 'derivation',
  statement: 'x^2+2x+1 = (x+1)^2',
  steps: [
    { id: 's1', latex: '(x+1)^2', reason: '展开', check: { expr: '(x+1)^2' } },
    { id: 's2', latex: 'x^2+2x+1', reason: '平方展开', check: { expr: 'x^2+2*x+1' } },
  ],
};

ok('能解析出 check', () => {
  const s = parseSpec(DERIV_CHECK);
  if (s.kind !== 'derivation') throw new Error('kind 错了');
  if (s.steps[1].check?.expr !== 'x^2+2*x+1') throw new Error('expr 丢了');
});
ok('relation 和 vars 也能带上', () => {
  const s = parseSpec({
    ...DERIV_CHECK,
    steps: [
      DERIV_CHECK.steps[0],
      { id: 's2', latex: 'todo', reason: '求导', check: { expr: '2*x', against: 's1', relation: 'derivativeOf', vars: ['x', 'y'] } },
    ],
  });
  if (s.kind !== 'derivation') throw new Error('kind 错了');
  if (s.steps[1].check?.relation !== 'derivativeOf') throw new Error('relation 丢了');
  if (s.steps[1].check?.vars?.length !== 2) throw new Error('vars 丢了');
});
ok('不给 check 是允许的(文字性的步骤)', () => {
  const s = parseSpec({
    ...DERIV_CHECK,
    steps: [DERIV_CHECK.steps[0], { id: 's2', latex: 'x', reason: '假设 x>0' }],
  });
  if (s.kind !== 'derivation' || s.steps[1].check !== undefined) throw new Error('不该有 check');
});
ok('check 可以省略 against(默认比上一步)', () => {
  const s = parseSpec(DERIV_CHECK);
  if (s.kind !== 'derivation' || s.steps[1].check?.against !== undefined) throw new Error('不该有 against');
});

rejects('check.against 指向不存在的步骤', {
  ...DERIV_CHECK,
  steps: [DERIV_CHECK.steps[0], { id: 's2', latex: 'x', reason: 'r', check: { expr: 'x', against: 'zzz' } }],
}, 'against');
rejects('check 缺 expr', {
  ...DERIV_CHECK,
  steps: [{ id: 's1', latex: 'x', reason: 'r', check: { against: 's1' } }],
}, 'expr');
rejects('relation 用了没定义的值', {
  ...DERIV_CHECK,
  steps: [{ id: 's1', latex: 'x', reason: 'r', check: { expr: 'x', relation: '差不多' } }],
}, 'relation');
rejects('vars 是空数组', {
  ...DERIV_CHECK,
  steps: [{ id: 's1', latex: 'x', reason: 'r', check: { expr: 'x', vars: [] } }],
}, 'vars');

console.log('\n线代变换视图 —— 解析');

const LIN_SPEC = {
  kind: 'linear',
  matrix: [['a', 'b'], ['c', 'd']],
  params: [
    { name: 'a', value: 1, min: -3, max: 3 },
    { name: 'b', value: 0, min: -3, max: 3 },
    { name: 'c', value: 0, min: -3, max: 3 },
    { name: 'd', value: 1, min: -3, max: 3 },
  ],
};

ok('能解析出矩阵', () => {
  const s = parseSpec(LIN_SPEC);
  if (s.kind !== 'linear') throw new Error('kind 错了');
  if (s.matrix[0][1] !== 'b' || s.matrix[1][0] !== 'c') throw new Error('矩阵元素串位了');
  if (s.params?.length !== 4) throw new Error('参数丢了');
});
ok('数字字面量也接受', () => {
  const s = parseSpec({ kind: 'linear', matrix: [['1', '0'], ['0', '-1']] });
  if (s.kind !== 'linear' || s.matrix[1][1] !== '-1') throw new Error('没解析成数字');
});
ok('探测向量和视野', () => {
  const s = parseSpec({
    ...LIN_SPEC,
    probe: { x: 'vx', y: 'vy', label: 'v' },
    view: { x: [-5, 5], y: [-5, 5] },
  });
  if (s.kind !== 'linear') throw new Error('kind 错了');
  if (s.probe?.x !== 'vx') throw new Error('probe 丢了');
  if (s.view?.x[1] !== 5) throw new Error('view 丢了');
});
ok('标题用矩阵本身', () => {
  const t = titleFor(parseSpec({ kind: 'linear', matrix: [['2', '0'], ['0', '2']] }));
  if (!t.includes('2')) throw new Error(`得到 ${t}`);
});

rejects('矩阵只有一行', { kind: 'linear', matrix: [['1', '0']] }, 'matrix');
rejects('某一行有三个元素', { kind: 'linear', matrix: [['1', '0', '0'], ['0', '1', '0']] }, 'matrix');
rejects('矩阵元素写成 LaTeX', { kind: 'linear', matrix: [['\\cos t', '0'], ['0', '1']] }, '');
rejects('矩阵元素里写赋值', { kind: 'linear', matrix: [['a=1', '0'], ['0', '1']] }, '');
rejects('probe 缺 y 分量', { ...LIN_SPEC, probe: { x: '1' } }, 'probe.y');
rejects('view 的区间反了', { ...LIN_SPEC, view: { x: [5, -5], y: [-3, 3] } }, '起 < 止');

console.log('\n标题:模型多转义一层、还往里写 Markdown');

{
  // 用显式字符构造,彻底避开"反斜杠被某一层吃掉"——之前就是因为测试里的
  // 反斜杠被 shell 吃掉了一层,双层转义那条路径**根本没被测到**,
  // 而它当时是坏的(会吐出字面量 ${name})。
  const BS = String.fromCharCode(92);

  ok('单层转义的 \\times 拍成 ×', () => {
    const t = titleFor(parseSpec({ kind: 'quiz', question: `2${BS}times2 矩阵` }));
    if (!t.includes('×')) throw new Error(`没拍成乘号:${t}`);
  });

  ok('双层转义的 \\\\times 也拍成 ×', () => {
    const t = titleFor(parseSpec({ kind: 'quiz', question: `2${BS}${BS}times2 矩阵` }));
    if (!t.includes('×')) throw new Error(`双层没折叠:${t}`);
    if (t.includes(BS)) throw new Error(`还有反斜杠:${t}`);
  });

  ok('双层转义不会吐出字面量 ${...}', () => {
    // 这是修复前的实际症状,而且比"没转换"更糟 —— 卡片头上会挂一串模板语法
    const t = titleFor(parseSpec({ kind: 'quiz', question: `${BS}${BS}times` }));
    if (t.includes('${')) throw new Error(`吐出了模板字面量:${t}`);
  });

  ok('双层转义的分式也能拍平', () => {
    const t = titleFor(parseSpec({ kind: 'quiz', question: `${BS}${BS}frac{1}{2} 的取值` }));
    if (!t.includes('1/2')) throw new Error(`分式没拍平:${t}`);
  });

  ok('合法的换行 \\\\ 变成空格,不留反斜杠', () => {
    // 标题是单行的,换行没有意义。留着的话卡片头上会挂一个反斜杠。
    const t = titleFor(parseSpec({ kind: 'quiz', question: `第一行 ${BS}${BS} 第二行` }));
    if (t.includes(BS)) throw new Error(`留了反斜杠:${t}`);
    if (!t.includes('第一行') || !t.includes('第二行')) throw new Error(`内容丢了:${t}`);
  });

  ok('标题里的 Markdown 标记被去掉', () => {
    const t = titleFor(parseSpec({ kind: 'quiz', question: '下面哪一条**是错的**?' }));
    if (t.includes('*')) throw new Error(`星号还在:${t}`);
    if (!t.includes('是错的')) throw new Error(`内容丢了:${t}`);
  });

  ok('推导标题里的斜体标记也去掉', () => {
    const t = titleFor(
      parseSpec({
        kind: 'derivation',
        statement: `设 ${BS}epsilon > 0 是*任意*给定的`,
        steps: [{ id: 'a', latex: '1', reason: 'r' }],
      }),
    );
    if (t.includes('*')) throw new Error(`星号还在:${t}`);
  });
}

console.log('\n标题:矩阵环境');

{
  const BS = String.fromCharCode(92);
  const q = (s: string) => titleFor(parseSpec({ kind: 'quiz', question: s }));
  const M = (body: string, env = 'pmatrix') => `${BS}begin{${env}}${body}${BS}end{${env}}`;
  // 完整结果在这一层验 —— titleFor 还会再截一刀(见下面 label 那一节),在那里验不出全貌
  const plain = (s: string) => latexToPlain(s);

  ok('行按 ;、列按 , 拍平', () => {
    const out = plain(`求 ${M(`1&2&3${BS}${BS}0&1&2${BS}${BS}0&0&1`)} 的逆`);
    if (!out.includes('(1, 2, 3; 0, 1, 2; 0, 0, 1)')) throw new Error(out);
  });

  ok('不再漏出 begin / end / 环境名', () => {
    // 截图里的实际症状:卡片头上写着「A=beginpmatrix1&2&3 0&1&2 0&0&…」——
    // 环境名被当成了普通单词,列分隔符也原样留着
    const t = q(`用伴随矩阵法求 A=${M(`1&2&3${BS}${BS}0&1&2${BS}${BS}0&0&1`)}`);
    if (/begin|end|pmatrix/.test(t)) throw new Error(`漏出了环境名:${t}`);
    if (t.includes('&')) throw new Error(`还留着 & :${t}`);
  });

  ok('行分隔符后面紧跟命令时,命令不能被吃掉', () => {
    // `\\\beta` 里的三个反斜杠是「2 个行分隔 + 1 个 \beta 自己的」。
    // 按"两个以上"贪婪地吃会把 \beta 也吃掉,拍成字面量 "beta"。
    const out = plain(M(`${BS}alpha&1${BS}${BS}${BS}beta&2`));
    if (!out.includes('α')) throw new Error(`\\alpha 没了:${out}`);
    if (!out.includes('β')) throw new Error(`\\beta 变成了字面量:${out}`);
  });

  ok('括号跟着环境走', () => {
    if (!q(M(`1&0${BS}${BS}0&1`, 'bmatrix')).includes('[1, 0; 0, 1]')) throw new Error(q(M(`1&0${BS}${BS}0&1`, 'bmatrix')));
    if (!q(M(`1&0${BS}${BS}0&1`, 'vmatrix')).includes('|1, 0; 0, 1|')) throw new Error(q(M(`1&0${BS}${BS}0&1`, 'vmatrix')));
  });

  ok('array 的列格式不会被当成内容', () => {
    const t = q(`${BS}begin{array}{cc}1&2${BS}${BS}3&4${BS}end{array}`);
    if (t.includes('cc')) throw new Error(`列格式漏进来了:${t}`);
    if (!t.includes('1, 2; 3, 4')) throw new Error(t);
  });

  ok('环境后面的内容不受影响', () => {
    const t = q(`${M(`1&0${BS}${BS}0&1`)} 的逆矩阵`);
    if (!t.includes('的逆矩阵')) throw new Error(t);
  });

  ok('没配对上的 \\begin 也不漏环境名', () => {
    // 模型截断或写漏 \end 时的兜底。内容留着,环境名必须清掉。
    const t = q(`A=${BS}begin{pmatrix}1&2&3`);
    if (/begin|pmatrix/.test(t)) throw new Error(t);
    if (!t.includes('1')) throw new Error(`内容被吃掉了:${t}`);
  });

  ok('不认识的环境原样保留,不吃内容', () => {
    const t = q(`${BS}begin{tikzpicture}甲--乙${BS}end{tikzpicture}`);
    if (!t.includes('甲')) throw new Error(`内容被吃掉了:${t}`);
  });
}

console.log('\n标题:模型给的短名优先 —— 标题里不该有公式');

{
  const BS = String.fromCharCode(92);
  const deriv = (label?: string) => ({
    kind: 'derivation',
    label,
    statement: `${BS}lim_{x${BS}to 0}${BS}sin${BS}frac{1}{x}${BS} ${BS}text{不存在}`,
    steps: [{ id: 'a', latex: '1', reason: 'r' }],
  });

  ok('给了 label 就用它', () => {
    const t = titleFor(parseSpec(deriv('极限不存在的证明')));
    if (t !== '极限不存在的证明') throw new Error(`得到 "${t}"`);
  });

  ok('没给 label 才退化到自动派生', () => {
    const t = titleFor(parseSpec(deriv()));
    if (!t.includes('lim')) throw new Error(`没有退化:${t}`);
    if (t.includes('$') || t.includes(BS)) throw new Error(`退化结果里还有 LaTeX:${t}`);
  });

  ok('label 也会被截断', () => {
    const t = titleFor(parseSpec(deriv('一'.repeat(80))));
    if (t.length > TITLE_MAX) throw new Error(`没截断:${t.length}`);
  });

  ok('空 label 当作没给', () => {
    if (titleFor(parseSpec(deriv('   '))).trim() === '') throw new Error('标题成了空的');
  });

  ok('改 label 能穿过 edit_artifact 的 patch', () => {
    // edit_artifact 走的是 patch 浅合并 + parseSpec 复检。label 不是 kind 的一部分,
    // 所以那一层必须原样放它过去 —— 否则模型改不了名字。
    const before = parseSpec(deriv('旧名字'));
    const after = parseSpec({ ...before, label: '新名字' });
    if (titleFor(after) !== '新名字') throw new Error(titleFor(after));
  });

  ok('新标题不再重复类别 —— 徽章已经在说这件事了', () => {
    const t = titleFor(parseSpec({ kind: 'quiz', question: '这个极限存在吗?' }));
    if (t.startsWith('测验')) throw new Error(`还带着类别前缀:${t}`);
    if (t !== '这个极限存在吗?') throw new Error(`得到 "${t}"`);
  });

  ok('每个 kind 的工具都带 label 参数', () => {
    // 在工具层统一注入的,所以这条是防止有人漏掉注入那一步
    const missing = TOOLS.filter((t) => t.name !== 'read_artifact' && t.name !== 'edit_artifact')
      .filter((t) => !(t.parameters as { properties?: Record<string, unknown> })?.properties?.label)
      .map((t) => t.name);
    if (missing.length) throw new Error(`这些工具没有 label 参数:${missing.join(', ')}`);
  });
}

console.log('\n流程 / 逻辑图 —— 解析');

const DG_SPEC = {
  kind: 'diagram',
  nodes: [
    { id: 'a', label: '前提', role: 'given' },
    { id: 'b', label: '引理', role: 'key' },
    { id: 'c', label: '结论', role: 'conclusion' },
  ],
  edges: [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c', label: '取反' },
  ],
};

ok('能解析出节点和边', () => {
  const s = parseSpec(DG_SPEC);
  if (s.kind !== 'diagram') throw new Error('kind 错了');
  if (s.nodes.length !== 3 || s.edges.length !== 2) throw new Error('数量不对');
  if (s.edges[1].label !== '取反') throw new Error('边上的标注丢了');
});
ok('三种语义角色都能解析', () => {
  const s = parseSpec(DG_SPEC);
  if (s.kind !== 'diagram') throw new Error('kind 错了');
  if (s.nodes[0].role !== 'given' || s.nodes[1].role !== 'key') throw new Error('role 丢了');
});
ok('不填 role 时是 undefined(落到普通样式)', () => {
  const s = parseSpec({ kind: 'diagram', nodes: [{ id: 'x', label: 'x' }] });
  if (s.kind !== 'diagram' || s.nodes[0].role !== undefined) throw new Error('不该有 role');
});
ok('可以没有边(只有节点)', () => {
  const s = parseSpec({ kind: 'diagram', nodes: [{ id: 'x', label: 'x' }] });
  if (s.kind !== 'diagram' || s.edges.length !== 0) throw new Error('edges 应当为空数组');
});
ok('方向', () => {
  const s = parseSpec({ ...DG_SPEC, direction: 'right' });
  if (s.kind !== 'diagram' || s.direction !== 'right') throw new Error('方向丢了');
});
ok('标题优先用 note', () => {
  const s = parseSpec({ ...DG_SPEC, note: '证明的结构' });
  if (titleFor(s) !== '证明的结构') throw new Error(`得到 ${titleFor(s)}`);
});
ok('没有 note 时用关键节点的标签', () => {
  const t = titleFor(parseSpec(DG_SPEC));
  if (!t.includes('引理')) throw new Error(`得到 ${t}`);
});

// 这条最要紧:不报的话布局会**静默丢掉**那条边,学生看到的图上凭空少一条关系
rejects('边指向不存在的节点', {
  ...DG_SPEC,
  edges: [{ from: 'a', to: '不存在' }],
}, '不存在');
rejects('边引用不存在的起点', {
  ...DG_SPEC,
  edges: [{ from: 'zzz', to: 'c' }],
}, 'zzz');
ok('报错信息里列出了已定义的节点,好让模型自己改', () => {
  try {
    parseSpec({ ...DG_SPEC, edges: [{ from: 'a', to: 'nope' }] });
  } catch (e) {
    const m = (e as Error).message;
    if (!m.includes('a') || !m.includes('b') || !m.includes('c')) throw new Error(`没列出可用节点:${m}`);
    return;
  }
  throw new Error('本该被拒绝');
});

rejects('节点 id 重复', { ...DG_SPEC, nodes: [...DG_SPEC.nodes, { id: 'a', label: '重复' }] }, '重复');
rejects('自环', { ...DG_SPEC, edges: [{ from: 'a', to: 'a' }] }, '自己');
rejects('没有节点', { kind: 'diagram', nodes: [] }, 'nodes');
rejects('节点太多', {
  kind: 'diagram',
  nodes: Array.from({ length: 41 }, (_, i) => ({ id: `n${i}`, label: 'x' })),
}, '40');
rejects('role 用了没定义的值', {
  kind: 'diagram',
  nodes: [{ id: 'x', label: 'x', role: '重要' }],
}, 'role');
rejects('direction 用了没定义的值', { ...DG_SPEC, direction: 'up' }, 'direction');
rejects('节点缺 label', { kind: 'diagram', nodes: [{ id: 'x' }] }, 'label');

console.log('\n转义折叠:该折的折,不该折的不许碰');

{
  const BS = String.fromCharCode(92);
  const collapse = (s: string) => collapseOverEscaped(s);

  // 该折的
  ok('双反斜杠的命令被折成单层', () => {
    if (collapse(`2${BS}${BS}times2`) !== `2${BS}times2`) throw new Error(collapse(`2${BS}${BS}times2`));
  });
  ok('分式也折', () => {
    const got = collapse(`${BS}${BS}frac{1}{2}`);
    if (got !== `${BS}frac{1}{2}`) throw new Error(got);
  });

  // **不该折的** —— 这几条比上面更要紧。合法 LaTeX 里的 `\\` 是换行符,
  // 矩阵和 aligned 环境全靠它,折错了整块公式就毁了。
  ok('真正的换行(后面是空格)不许碰', () => {
    const src = `a ${BS}${BS} b`;
    if (collapse(src) !== src) throw new Error(`被误折成 ${collapse(src)}`);
  });
  ok('aligned 里的换行不许碰', () => {
    const src = `${BS}begin{aligned}a&=b ${BS}${BS} c&=d${BS}end{aligned}`;
    if (collapse(src) !== src) throw new Error(`被误折成 ${collapse(src)}`);
  });
  ok('换行后跟可选间距参数(\\\\[2pt])不许碰', () => {
    const src = `a ${BS}${BS}[2pt] b`;
    if (collapse(src) !== src) throw new Error(`被误折成 ${collapse(src)}`);
  });
  ok('换行后跟括号不许碰', () => {
    const src = `a ${BS}${BS}(b)`;
    if (collapse(src) !== src) throw new Error(`被误折成 ${collapse(src)}`);
  });
  ok('单层的命令本来就不该动', () => {
    const src = `${BS}times`;
    if (collapse(src) !== src) throw new Error(`被改了 ${collapse(src)}`);
  });
  ok('不认识的命令名也不动(宁可漏折,不可乱折)', () => {
    const src = `${BS}${BS}不认识`;
    if (collapse(src) !== src) throw new Error(`被改了 ${collapse(src)}`);
  });
}

console.log(`\n${pass} 通过, ${fail} 失败\n`);
if (fail) process.exit(1);
