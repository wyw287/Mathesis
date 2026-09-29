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
  /**
   * 折叠多余的转义层 —— **提前做,不是出错才做**。
   *
   * 这是上一版写错的地方:`2\\times2` 对 KaTeX 来说**根本不是错误** ——
   * 它把 `\\` 当成换行符,规规矩矩渲染出一个断行。所以"渲染失败才折叠"的
   * 策略永远碰不到它:输出既不报错也不空白,只是**凭空多了一行**。
   *
   * 这个折叠只对 `\\` 后面紧跟**已知命令名**的情况生效,而这种写法在合法
   * LaTeX 里不存在 —— 矩阵换行、`aligned` 里的 `\\` 后面总是空格或 `[`。
   * 所以提前折叠不会误伤。
   */
  const source = useMemo(() => collapseOverEscaped(unwrap(tex)), [tex]);

  const html = useMemo(() => {
    if (!source) return null;
    try {
      return katex.renderToString(source, {
        displayMode: display,
        throwOnError: true,
        strict: false,
        trust: false,
      });
    } catch {
      return null;
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
