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
  if (t !== '推导：R\\{0}') throw new Error(`得到 "${t}"`);
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
    title: '测验：这个极限存在吗?',
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

console.log(`\n${pass} 通过, ${fail} 失败\n`);
if (fail) process.exit(1);
