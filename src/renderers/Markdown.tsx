/**
 * Markdown 渲染。
 *
 * ## 为什么现在用库而不是手写
 *
 * 之前这里是手写的解析器(~250 行),理由是"不想碰 innerHTML,避免 XSS"。
 * 那个理由只排除了 `marked` / `markdown-it` 这一类**产出 HTML 字符串**的库,
 * 却没排除 `react-markdown` —— 它跑在 AST 上、直接产出 React 元素,安全性质
 * 和手写版完全一样。
 *
 * 换掉它的真正原因是**覆盖面**:手写版连续漏了 `\text{中文}`、多转义一层、表格,
 * 而且三次都是用户撞出来的,不是测试发现的。自己在实现一份别人已经实现过的规范,
 * 漏是必然的。
 *
 * ## 安全边界(换库之后要重新确认的两条)
 *
 * · **不接 `rehype-raw`。** 默认情况下 markdown 里的原始 HTML 不会被渲染,
 *   这正是我们要的 —— 一旦接上,模型输出就能注入真实 DOM。
 * · **URL 由 react-markdown 的 urlTransform 过滤**,`javascript:` 之类的协议会被
 *   剥掉。这两条都有测试盯着(render-check 里那组恶意输出用例)。
 */
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { collapseOverEscaped } from '../lib/latex-plain';
import { Latex } from './Latex';

// ------------------------------------------------------------------ 插件

interface HastNode {
  type?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  value?: string;
  children?: HastNode[];
}

/**
 * 在 `rehype-katex` **之前**跑:把多转义一层的反斜杠折回来。
 *
 * 模型经常在 JSON 里把 LaTeX 多转义一层(`\\times`),而 `\\` 在 LaTeX 里是
 * **换行符** —— KaTeX 不会报错,它会规规矩矩渲染出一个断行。所以这个折叠
 * 必须提前做,不能等出错再补救。
 *
 * 只对 `\\` 后面紧跟已知命令名的情况生效;合法 LaTeX 里不存在这种写法
 * (矩阵换行、aligned 里的 `\\` 后面总是空格或 `[`),所以不会误伤。
 */
function rehypeFixEscapes() {
  return (tree: HastNode): void => {
    const walk = (node: HastNode) => {
      // 数学节点是 `<code class="language-math math-inline">`,**不是 `<span>`** ——
      // 这是实测出来的:`remark-math` → `remark-rehype` 产出的是 code 元素,
      // `rehype-katex` 也靠 `language-math` 这个类名去找它。
      // 第一版按 span 匹配,一次都没命中,插件等于没接上。
      const cls = node.properties?.className;
      const isMath =
        node.tagName === 'code' && Array.isArray(cls) && cls.includes('language-math');
      if (isMath) {
        const text = node.children?.find((c) => c.type === 'text' && typeof c.value === 'string');
        if (text?.value) text.value = collapseOverEscaped(text.value);
      }
      for (const child of node.children ?? []) walk(child);
    };
    walk(tree);
  };
}

const KATEX_OPTIONS = {
  // 出错时渲染成红色内联提示而不是抛错 —— 一条坏公式不该让整段消息消失
  throwOnError: false,
  // 中文和部分符号在严格模式下会报警;我们这里的内容本来就杂
  strict: false as const,
  // trust:false 是必须的:它挡掉 \href、\htmlClass 这类能往外发请求的命令
  trust: false,
};

const COMPONENTS: Components = {
  // 外链统一加 noopener,并且新开标签 —— 否则点一个链接就把学生的画布顶掉了
  a: ({ node: _node, href, children, ...props }) => {
    // react-markdown 的 urlTransform 会把 `javascript:` 之类的协议剥成空串。
    // 留一个 href="" 的链接,点了会刷新页面;不如把文字原样显示出来 ——
    // 学生看到的是「这里本来有个链接但被拦了」,而不是一个莫名其妙的空链接。
    if (!href) return <span {...props}>{children}</span>;
    return (
      <a {...props} href={href} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    );
  },
  pre: ({ node: _node, ...props }) => <pre className="md-pre" {...props} />,
  // 表格外面套一层可横向滚动的壳 —— 数学内容的表格经常很宽,
  // 撑破对话栏比能滚动难看多了
  table: ({ node: _node, ...props }) => (
    <div className="md-table-wrap">
      <table className="md-table" {...props} />
    </div>
  ),
};

// ------------------------------------------------------------------ 对外

export function Markdown({ source }: { source: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeFixEscapes, [rehypeKatex, KATEX_OPTIONS]]}
      components={COMPONENTS}
    >
      {source}
    </ReactMarkdown>
  );
}

/**
 * 给「本来应该是公式」的字段用(命题、前提)。
 *
 * 规则刻意简单到没有猜测空间:含 `$` 说明是混排,交给 Markdown;
 * 否则整句当公式渲染。这些字段在 schema 里本来就声明成 LaTeX,
 * 而 KaTeX 对中文和 `\text{}` 都能正常处理,不需要猜。
 */
export function MathBlock({ tex }: { tex: string }) {
  return tex.includes('$') ? <Markdown source={tex} /> : <Latex tex={tex} display />;
}

/**
 * 一行文字,可能是散文夹公式(带 `$`),也可能整句就是 LaTeX(不带 `$`)。
 *
 * 模型写标签和说明时两种都用:有时写 `f 在 0 处可导`,有时直接写 `f'(0)=0`。
 * 只认一种就会把另一种原样打印出来。
 */
export function MathText({ text }: { text: string }) {
  return text.includes('$') ? <Markdown source={text} /> : <Latex tex={text} />;
}
