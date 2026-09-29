/**
 * LaTeX → 可读纯文本。**只用于生成标题,不用于渲染。**
 *
 * 标题有两个去处:卡片头部,以及每轮随画布目录发给模型的上下文。
 * 两处都不该出现 `\lim_{x\to 0}\sin\frac{1}{x}\ \text{不存在}` 这种东西 ——
 * 人读不了,模型那边也是纯噪声(它要看细节会调 read_artifact)。
 *
 * 导出的目的是可以被测试直接覆盖。
 */
const LATEX_SYMBOLS: Record<string, string> = {
  to: '→', rightarrow: '→', implies: '⇒', Rightarrow: '⇒', iff: '⇔', Leftrightarrow: '⇔',
  le: '≤', leq: '≤', ge: '≥', geq: '≥', neq: '≠', ne: '≠',
  in: '∈', notin: '∉', subset: '⊂', subseteq: '⊆', cup: '∪', cap: '∩',
  forall: '∀', exists: '∃', infty: '∞', cdot: '·', times: '×', pm: '±', mp: '∓',
  approx: '≈', equiv: '≡', sim: '∼', propto: '∝', emptyset: '∅',
  partial: '∂', nabla: '∇', sum: '∑', prod: '∏', int: '∫',
  setminus: '\\', ldots: '…', cdots: '⋯', circ: '∘', star: '⋆',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε',
  zeta: 'ζ', eta: 'η', theta: 'θ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ',
  pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', phi: 'φ', varphi: 'φ', chi: 'χ',
  psi: 'ψ', omega: 'ω', Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ',
  Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
};

/** 只影响排版的命令,直接丢掉,否则会变成 "left" "quad" 这种噪声词。 */
const LATEX_DROP = new Set([
  'left', 'right', 'quad', 'qquad', 'displaystyle', 'textstyle', 'limits', 'nolimits',
  'big', 'Big', 'bigg', 'Bigg', 'mathstrut', 'phantom', 'strut', 'hspace', 'vspace',
]);

const TEX_TEXT_MACROS = new Set([
  'text', 'textrm', 'mathrm', 'mathbf', 'mathit', 'mathbb', 'mathcal', 'operatorname', 'mbox',
]);
const TEX_FRAC_MACROS = new Set(['frac', 'dfrac', 'tfrac']);
/** 反斜杠后面跟这些字符是空白控制(\, \; \: \! 和 \ )。 */
const TEX_SPACING = /[ ,;:!]/;

/**
 * 矩阵类环境:内容用 `&` 分列、`\\` 分行,外面套什么。
 *
 * 表里没有的环境一律**原样保留**,不猜 —— 宁可标题里多一个词,
 * 也不要把不认识的构造吃掉。
 */
const TEX_ENVS: Record<string, [string, string]> = {
  matrix: ['', ''],
  smallmatrix: ['(', ')'],
  pmatrix: ['(', ')'],
  bmatrix: ['[', ']'],
  Bmatrix: ['{', '}'],
  vmatrix: ['|', '|'],
  Vmatrix: ['‖', '‖'],
  cases: ['{', ''],
  aligned: ['', ''],
  align: ['', ''],
  gather: ['', ''],
  gathered: ['', ''],
  array: ['', ''],
};
/** `\begin{array}{ccc}` 后面那个 `{}` 是列格式,不是内容。 */
const COLSPEC_ENVS = new Set(['array', 'alignedat']);

/** 找到与 start 处的 `{` 配对的 `}` 下标;没有配对的返回 -1。 */
function matchBrace(s: string, start: number): number {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === '\\') {
      i++; // 跳过被转义的字符,别把 \} 当成收尾
      continue;
    }
    if (s[i] === '{') depth++;
    else if (s[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * 单次扫描把 LaTeX 转成纯文本。
 *
 * 这里原本是一串 chained replace,换出了三个 bug,根因都是**各步骤互相污染**:
 *   · \frac 写成了 [dt]frac,匹配不到 \frac 本身
 *   · \setminus 变成 `\` 之后被后面的「反斜杠+空格」规则连同空格一起吃掉
 *   · \mathbb{Q} 展开成 Q 后紧贴 \notin,被命令名正则贪婪吞成 "notinQ"
 * 分词器把「识别 token」和「产出文本」分开,这类交互就不存在了。
 */
function convert(src: string): string {
  const out: string[] = [];
  const lastChar = () => (out.length ? out[out.length - 1].slice(-1) : '');

  let i = 0;
  while (i < src.length) {
    const c = src[i];

    // ---- 反斜杠开头 ----
    if (c === '\\') {
      const next = src[i + 1] ?? '';
      if (!/[a-zA-Z]/.test(next)) {
        // 转义字符或空白控制
        if (TEX_SPACING.test(next)) out.push(' ');
        else if (next) out.push(next); // \{ \} \% \$ \& \# \_ 等:是字面量,保留
        i += 2;
        continue;
      }

      const m = /^\\([a-zA-Z]+)/.exec(src.slice(i));
      if (!m) {
        i++;
        continue;
      }
      const name = m[1];
      i += m[0].length;

      /** 吃掉一个 {...} 参数(允许前面有空格和星号)。 */
      const takeArg = (): string | null => {
        while (src[i] === ' ' || src[i] === '*') i++;
        if (src[i] !== '{') return null;
        const end = matchBrace(src, i);
        if (end < 0) return null;
        const inner = src.slice(i + 1, end);
        i = end + 1;
        return inner;
      };

      if (TEX_TEXT_MACROS.has(name)) {
        out.push(takeArg() ?? name); // 参数里是正文,不再往下解析
        continue;
      }
      if (TEX_FRAC_MACROS.has(name)) {
        const a = takeArg();
        const b = takeArg();
        if (a === null || b === null) {
          out.push(name);
          continue;
        }
        const frac = `${convert(a)}/${convert(b)}`;
        // 前面紧跟字母(如 \sin\frac{1}{x})要加括号,否则会粘成 "sin1/x"
        out.push(/[a-zA-Z]/.test(lastChar()) ? `(${frac})` : frac);
        continue;
      }
      if (name === 'sqrt') {
        const a = takeArg();
        out.push(a !== null ? `√${convert(a)}` : name);
        continue;
      }
      if (name === 'overline' || name === 'bar') {
        const a = takeArg();
        out.push(a !== null ? `${convert(a)}̄` : name);
        continue;
      }
      // 环境起止。正常路径下 `expandEnvs` 已经把整个环境展开掉了,走到这里说明
      // 它没能配对(缺 `\end`、环境名不认识、或者转义层数不对)。至少把环境名丢掉,
      // 别让标题上挂一个 "beginpmatrix"。
      if (name === 'begin' || name === 'end') {
        takeArg();
        continue;
      }

      if (LATEX_SYMBOLS[name] !== undefined) out.push(LATEX_SYMBOLS[name]);
      else if (LATEX_DROP.has(name)) {
        // 纯排版命令,丢掉。留空。
      } else out.push(name); // 不认识就保留名字:宁可多一个词,也不要吃掉内容
      continue;
    }

    // ---- 落单的花括号和公式定界符 ----
    // \$ (转义的)不走这里,它在上面按字面量保留了
    if (c === '{' || c === '}' || c === '$') {
      i++;
      continue;
    }

    // ---- 上下标 ----
    if (c === '_' || c === '^') {
      const start = i + 1;
      let arg: string;
      if (src[start] === '{') {
        const end = matchBrace(src, start);
        if (end < 0) {
          arg = src.slice(start + 1);
          i = src.length;
        } else {
          arg = src.slice(start + 1, end);
          i = end + 1;
        }
      } else {
        arg = src[start] ?? '';
        i = start + 1;
      }
      const shown = convert(arg);
      // 单个字符的上下标不加括号,否则 x^2 会写成 x^(2),全是噪声
      out.push(`${c}${/^[A-Za-z0-9]$/.test(shown) ? shown : `(${shown})`}`);
      // 后面紧跟字母/数字/命令就补一个空格。LaTeX 词间本来没有空格,
      // 不补的话 \lim_{x\to 0}\sin 会粘成 "lim_(x→ 0)sin"。
      if (/[\w\\]/.test(src[i] ?? '')) out.push(' ');
      continue;
    }

    out.push(c);
    i++;
  }

  return out.join('');
}

/**
 * 把 `\begin{...} ... \end{...}` 就地展开成纯文本。
 *
 * 不处理的话 `\begin{pmatrix}1&2\\3&4\end{pmatrix}` 会原样漏成
 * "beginpmatrix1&2 3&4endpmatrix" —— 标题上不但挂着两个环境名,还挂着一串 `&`。
 * 展开成 `(1, 2; 3, 4)` 之后,单元格里的东西(分式、希腊字母)照常走后面的转换,
 * 因为它们只是被拼进了同一个字符串。
 *
 * 一次只展开**最先出现**的那个环境,外层先于内层。矩阵套矩阵在数学里基本不存在,
 * 所以"外层先被拆掉、内层的 `&` 被当成外层的列"这个理论上的偏差不值得为它加一层
 * 括号配对。
 */
function expandEnvs(s: string): string {
  let out = s;
  // 展开一个就重来一次,直到没有可展开的为止。上限只是防止写坏时死循环。
  for (let guard = 0; guard < 20; guard++) {
    const next = expandOneEnv(out);
    if (next === out) break;
    out = next;
  }
  return out;
}

function expandOneEnv(s: string): string {
  const m = /\\begin\{([a-zA-Z]+\*?)\}/.exec(s);
  if (!m) return s;

  const name = m[1].replace(/\*$/, '');
  const delims = TEX_ENVS[name];
  // 不认识的环境原样留着,交给 convert 的兜底去清环境名
  if (!delims) return s;

  const rest = s.slice(m.index + m[0].length);
  const end = new RegExp(`\\\\end\\{${name}\\*?\\}`).exec(rest);
  if (!end) return s;

  let body = rest.slice(0, end.index);
  if (COLSPEC_ENVS.has(name)) body = body.replace(/^\s*\{[^{}]*\}/, '');

  // 行分隔符就是 `\\`,而且**只能是偶数个反斜杠**。
  //
  // 「偶数」这个限制是必须的,不是洁癖:`\\\beta`(一行结束、下一行以 \beta 开头)
  // 里那三个反斜杠是 2 个行分隔符 + 1 个命令的。按"两个以上"贪婪地吃,
  // 会把 `\beta` 自己的反斜杠一起吃掉,变成字面量 "beta"。
  // 而按两个一组吃,`\\` 和 `\\\\`(多转义一层的)都对,`\beta` 也留得下。
  //
  // 也不能加"后面不跟字母才算"那种限制:下一行的第一个单元格常常就是字母开头的
  // (`a&b\\c&d`),那种限制会把最常见的形态当成普通文本。
  const rows = body
    .split(/(?:\\\\)+/)
    .map((row) =>
      row
        .split('&')
        .map((cell) => cell.trim())
        .filter(Boolean)
        .join(', '),
    )
    .filter((row) => row.length > 0);

  const [open, close] = delims;
  const shown = rows.length ? `${open}${rows.join('; ')}${close}` : '';
  return s.slice(0, m.index) + shown + rest.slice(end.index + end[0].length);
}

/**
 * 折叠多余的转义层。
 *
 * 模型经常把 LaTeX 的反斜杠**多转义一层** —— 在 JSON 里写成 `\\times`,
 * 解出来就是 `\\times`(两个反斜杠)。而 `\\` 在 LaTeX 里是**换行符**,
 * 于是 `2\\times2` 会渲染成「2 换行 ×2」,看起来像模型写错了公式,
 * 其实是转义层数错了。
 *
 * **必须在 `convert` 之前跑。** convert 会把 `\\` 当成转义字符吃掉一层,
 * 之后再折叠就晚了 —— 那时拿到的是 `\times` 这样的半成品,分不清它原本
 * 是一层还是两层。这个顺序错了的话,双反斜杠的输入会被折成字面量 `${name}`。
 *
 * 只在后面紧跟**已知命令名**时才折叠:真正的换行 `\\` 后面不会紧跟
 * `times` 这种名字,所以不会误伤 `x \\ y` 这类合法用法。
 */
export function collapseOverEscaped(s: string): string {
  // 除了符号表里的名字,还要算上 convert 能特殊处理的宏(分式、根号、\text 这些)。
  // 漏掉它们的话,多转义一层就会绕过那些规则:比如 `\\frac{1}{2}` 折不出来,
  // 最后变成 "frac12" 而不是 "1/2"。
  const known = (name: string) =>
    LATEX_SYMBOLS[name] !== undefined ||
    LATEX_DROP.has(name) ||
    TEX_TEXT_MACROS.has(name) ||
    TEX_FRAC_MACROS.has(name) ||
    name === 'sqrt' ||
    name === 'overline' ||
    name === 'bar';

  return s.replace(/\\\\([a-zA-Z]+)/g, (whole, name: string, offset: number) =>
    // 前面紧邻的还是一个反斜杠时**不折** —— 那两个反斜杠是**换行符 `\\`**,
    // 后面跟的是下一行的内容,不是"多转义一层的命令"。
    // `\\` + `\beta`(矩阵里一行结束、下一行以 \beta 开头)就是这种:折了的话
    // 会吃掉行分隔符的一个反斜杠,把 `\beta` 连人带反斜杠一起变成字面量 "beta"。
    s[offset - 1] === '\\' || !known(name) ? whole : `\\${name}`,
  );
}

/**
 * 标题是**单行**的:落单的 `\\`(合法 LaTeX 里表示换行)在这里没有意义,
 * 不处理的话卡片头上会挂一个反斜杠。只在标题路径上做 —— 渲染路径里
 * `\\` 可能是矩阵的行分隔符,不能动。
 */
const lineBreakToSpace = (s: string): string => s.replace(/\\\\/g, ' ');

/**
 * 去掉 Markdown 标记。
 *
 * 标题是**纯文本**,而模型很自然地会往里写 Markdown(`**是错的**`)。
 * 不处理的话卡片头上会挂着一串星号。
 */
function stripMarkdown(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '');
}

export function latexToPlain(tex: string): string {
  // 顺序要紧,两条都不能挪:
  // · 折叠转义层必须在 **convert 之前**。convert 会把 `\\` 当成转义字符吃掉一层,
  //   之后再折叠就晚了 —— 拿到的是半成品,分不清原本几层。
  // · 展开环境必须在 **lineBreakToSpace 之前**。那个函数会把 `\\` 换成空格,
  //   而 `\\` 在矩阵里是**行分隔符** —— 先换掉的话矩阵就被压成一长串了。
  const prepared = lineBreakToSpace(expandEnvs(collapseOverEscaped(tex)));
  return stripMarkdown(convert(prepared).replace(/\s+/g, ' ').trim());
}

/** 生成人可读标题。它是上下文压缩的抓手,也是学生在对话里引用这张图的说法。 */
