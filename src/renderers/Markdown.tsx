import type { ReactNode } from 'react';
import { Latex } from './Latex';

/**
 * 极简 Markdown 渲染器,输出 React 元素而**不碰 innerHTML**。
 *
 * 为什么不用 marked 之类的库:这个产品的形态是 BYOK,API Key 存在 localStorage 里,
 * 所以模型输出是实打实的不可信输入。用 marked 就得再引一个 sanitizer,
 * 而自己产出 React 元素则从构造上就不可能注入。覆盖面按「模型讲数学时真会写的」
 * 来定:粗体、斜体、行内代码、代码块、标题、列表、引用、分隔线、链接(仅 http/https)、
 * 以及 $...$ / $$...$$ 公式。
 */

const INLINE =
  /(\$\$[\s\S]+?\$\$)|(\$[^$\n]+?\$)|(`[^`\n]+?`)|(\*\*[^\n]+?\*\*)|(__[^\n]+?__)|(\*[^*\n]+?\*)|(\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/g;

export function Markdown({ source }: { source: string }) {
  return <>{parseBlocks(source).map(renderBlock)}</>;
}

/**
 * 给「本来应该是公式」的字段用(命题、前提)。
 *
 * 规则刻意简单到没有猜测空间:只有一种情况需要按混排处理 ——
 * 模型把公式用 $ 包起来夹在说明文字里。其余一律当公式渲染。
 *
 * 这里曾经用「含中文就是说明文字」来判断,是错的:中文数学写作里
 * `\text{不存在}` 这类写法极其常见,那个猜测会把最正常的输入判成正文,
 * 结果整个命题以原始 LaTeX 显示出来。而 KaTeX 本身对中文和 \text{}
 * 都能正常处理,根本不需要猜。
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

// ------------------------------------------------------------------ 行内

function inline(text: string, keyBase = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;

  for (const m of text.matchAll(INLINE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(text.slice(last, idx));
    // 槽位必须和 INLINE 的捕获组严格一一对应。多一个少一个都会静默错位 ——
    // 之前这里多写了一个 emAlt,结果链接那一组被接成了斜体。
    const [, display, inlineMath, code, bold, boldAlt, em, link] = m;
    const k = `${keyBase}-${n++}`;

    if (display) out.push(<Latex key={k} tex={display.slice(2, -2)} display />);
    else if (inlineMath) out.push(<Latex key={k} tex={inlineMath.slice(1, -1)} />);
    else if (code) out.push(<code key={k} className="md-code">{code.slice(1, -1)}</code>);
    else if (bold ?? boldAlt) {
      const inner = (bold ?? boldAlt)!;
      out.push(<strong key={k}>{inline(inner.slice(2, -2), k)}</strong>);
    } else if (em) {
      out.push(<em key={k}>{inline(em.slice(1, -1), k)}</em>);
    } else if (link) {
      const parsed = /^\[([^\]]+)\]\((.+)\)$/.exec(link);
      if (parsed) {
        out.push(
          <a key={k} href={parsed[2]} target="_blank" rel="noreferrer noopener">
            {inline(parsed[1], k)}
          </a>,
        );
      } else {
        out.push(link);
      }
    }
    last = idx + m[0].length;
  }

  if (last < text.length) out.push(text.slice(last));
  return out;
}

// ------------------------------------------------------------------ 块级

type Block =
  | { t: 'p'; lines: string[] }
  | { t: 'head'; level: number; text: string }
  | { t: 'ul'; items: string[] }
  | { t: 'ol'; items: string[] }
  | { t: 'quote'; lines: string[] }
  | { t: 'code'; text: string }
  | { t: 'hr' };

const RE_HR = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const RE_FENCE = /^\s*```/;
const RE_UL = /^\s*[-*+]\s+/;
const RE_OL = /^\s*\d+[.)]\s+/;
const RE_QUOTE = /^\s*>\s?/;

/** 判断这一行是不是某个块级结构的开头(用于决定段落在哪里断)。 */
function startsBlock(l: string): boolean {
  return (
    RE_FENCE.test(l) || RE_HR.test(l) || RE_UL.test(l) || RE_OL.test(l) || RE_QUOTE.test(l) || /^#{1,6}\s+/.test(l)
  );
}

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    if (RE_FENCE.test(line)) {
      i++;
      const buf: string[] = [];
      while (i < lines.length && !RE_FENCE.test(lines[i])) buf.push(lines[i++]);
      i++; // 吃掉收尾的 ```
      out.push({ t: 'code', text: buf.join('\n') });
      continue;
    }

    // 分隔线要排在列表前面判断,否则 --- 会被当成无序列表
    if (RE_HR.test(line)) {
      out.push({ t: 'hr' });
      i++;
      continue;
    }

    const head = /^(#{1,6})\s+(.*)$/.exec(line);
    if (head) {
      out.push({ t: 'head', level: head[1].length, text: head[2] });
      i++;
      continue;
    }

    if (RE_QUOTE.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && RE_QUOTE.test(lines[i])) buf.push(lines[i++].replace(RE_QUOTE, ''));
      out.push({ t: 'quote', lines: buf });
      continue;
    }

    if (RE_UL.test(line)) {
      const items: string[] = [];
      while (i < lines.length && RE_UL.test(lines[i])) items.push(lines[i++].replace(RE_UL, ''));
      out.push({ t: 'ul', items });
      continue;
    }

    if (RE_OL.test(line)) {
      const items: string[] = [];
      while (i < lines.length && RE_OL.test(lines[i])) items.push(lines[i++].replace(RE_OL, ''));
      out.push({ t: 'ol', items });
      continue;
    }

    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) buf.push(lines[i++]);
    out.push({ t: 'p', lines: buf });
  }

  return out;
}

/** 段落内单个换行按换行显示 —— 模型经常用它做紧凑的分行列举。 */
function joinLines(lines: string[], keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  lines.forEach((l, i) => {
    if (i > 0) out.push(<br key={`${keyBase}-br${i}`} />);
    out.push(...inline(l, `${keyBase}-${i}`));
  });
  return out;
}

function renderBlock(b: Block, i: number): ReactNode {
  switch (b.t) {
    case 'p':
      return <p key={i}>{joinLines(b.lines, `p${i}`)}</p>;
    case 'head':
      // 用 div 而不是 h1-h6:这是聊天流里的小标题,不该进文档大纲
      return (
        <div key={i} className={`md-head md-head-${Math.min(b.level, 4)}`}>
          {inline(b.text, `h${i}`)}
        </div>
      );
    case 'ul':
      return (
        <ul key={i}>
          {b.items.map((it, j) => (
            <li key={j}>{inline(it, `u${i}-${j}`)}</li>
          ))}
        </ul>
      );
    case 'ol':
      return (
        <ol key={i}>
          {b.items.map((it, j) => (
            <li key={j}>{inline(it, `o${i}-${j}`)}</li>
          ))}
        </ol>
      );
    case 'quote':
      return <blockquote key={i}>{joinLines(b.lines, `q${i}`)}</blockquote>;
    case 'code':
      return (
        <pre key={i} className="md-pre">
          <code>{b.text}</code>
        </pre>
      );
    case 'hr':
      return <hr key={i} />;
  }
}
