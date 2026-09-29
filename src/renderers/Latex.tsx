import { useEffect, useMemo, useRef } from 'react';
import katex from 'katex';
import { collapseOverEscaped } from '../lib/latex-plain';

/**
 * 纯数学公式渲染。
 *
 * **必须先剥掉定界符。** 模型很自然地会写 $\lim...$ 或 \[...\],
 * 而 KaTeX 在数学模式里遇到 `$` 会直接抛错 —— 之前没有这一步,
 * 结果是整条公式降级成原始 LaTeX 文本显示出来。
 * 与其在提示词里反复叮嘱模型别加,不如在这里容错。
 */
export function unwrap(input: string): string {
  const t = input.trim();
  const wrappers: [string, string][] = [
    ['$$', '$$'],
    ['\\[', '\\]'],
    ['\\(', '\\)'],
    ['\\begin{equation}', '\\end{equation}'],
    ['$', '$'],
  ];
  for (const [open, close] of wrappers) {
    if (t.length > open.length + close.length && t.startsWith(open) && t.endsWith(close)) {
      return t.slice(open.length, t.length - close.length).trim();
    }
  }
  return t;
}

interface Props {
  tex: string;
  display?: boolean;
}

/** KaTeX 渲染。渲染失败时退回原始 LaTeX —— 总比一片空白好,而且能看到错在哪。 */
export function Latex({ tex, display = false }: Props) {
  const source = useMemo(() => unwrap(tex), [tex]);

  const html = useMemo(() => {
    if (!source) return null;
    const options = { displayMode: display, throwOnError: true, strict: false, trust: false };
    try {
      return katex.renderToString(source, options);
    } catch {
      // 有些模型把反斜杠多转义了一层(`\times`)。那在 LaTeX 里是**换行符**,
      // 渲染出来要么报错、要么变成莫名其妙的分行 —— 看起来像模型写错了公式,
      // 其实是转义层数的问题。
      //
      // 判据交给 KaTeX 自己:原样不行就试折叠过的。**不猜**,因为猜错的代价是
      // 把一个本来正确的公式改坏。
      const collapsed = collapseOverEscaped(source);
      if (collapsed === source) return null;
      try {
        return katex.renderToString(collapsed, options);
      } catch {
        return null;
      }
    }
  }, [source, display]);

  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (html === null || !ref.current) return;
    ref.current.innerHTML = html;
  }, [html]);

  if (html === null) {
    return (
      <code className="latex-fallback" title="KaTeX 渲染失败,下面是原始输入">
        {source}
      </code>
    );
  }
  return <span ref={ref} className={display ? 'latex-display' : 'latex-inline'} />;
}
