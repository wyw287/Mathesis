/**
 * Spec 的运行时解析与校验。
 *
 * 每个 parse* 都接收 unknown(模型的原始输出),要么返回一个已验证的 spec,
 * 要么抛带具体位置的 ToolInputError。没有任何类型断言混进来。
 */
import { ExprError, compileExpr } from '../lib/math';
import type {
  Annotation,
  ArtifactSpec,
  Curve,
  DerivationSpec,
  DerivationStep,
  GapKind,
  HtmlSpec,
  LineStyle,
  ParamSpec,
  Plot2DSpec,
  PlotPoint,
  QuizSpec,
} from '../types/artifact';
import {
  ToolInputError,
  arr,
  num,
  obj,
  oneOf,
  optArr,
  optBool,
  optNum,
  optObj,
  optStr,
  pair,
  str,
} from './validate';

const DASHES = ['solid', 'dashed', 'dotted'] as const;
const GAPS: readonly GapKind[] = ['technical', 'substantive', 'unjustified', 'assumption'];
const KINDS = ['plot2d', 'derivation', 'quiz', 'html'] as const;

/** 表达式校验:既查安全性(无赋值/多语句),也查可解析性 —— 解析不了的式子早点报出来。 */
function expr(v: unknown, where: string): string {
  const s = str(v, where);
  try {
    compileExpr(s);
  } catch (e) {
    const msg = e instanceof ExprError ? e.message : String(e);
    throw new ToolInputError(`${where} 不是合法的数学表达式：${msg}`);
  }
  return s;
}

function parseStyle(v: unknown, where: string): LineStyle | undefined {
  const o = optObj(v, where);
  if (!o) return undefined;
  const out: LineStyle = {};
  const color = optStr(o.color, `${where}.color`);
  // 只放过十六进制色值和简单色名,避免任意字符串进 SVG 属性
  if (color && /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,20})$/.test(color)) out.color = color;
  if (o.dash !== undefined) out.dash = oneOf(o.dash, DASHES, `${where}.dash`);
  const width = optNum(o.width, `${where}.width`);
  if (width !== undefined) out.width = Math.max(0.5, Math.min(8, width));
  return Object.keys(out).length ? out : undefined;
}

function parseCurve(v: unknown, where: string): Curve {
  const o = obj(v, where);
  const type = oneOf(o.type, ['explicit', 'parametric', 'sequence'] as const, `${where}.type`);
  switch (type) {
    case 'explicit':
      return {
        type,
        expr: expr(o.expr, `${where}.expr`),
        domain: o.domain === undefined ? undefined : pair(o.domain, `${where}.domain`),
        label: optStr(o.label, `${where}.label`),
        style: parseStyle(o.style, `${where}.style`),
      };
    case 'parametric':
      return {
        type,
        x: expr(o.x, `${where}.x`),
        y: expr(o.y, `${where}.y`),
        t: pair(o.t, `${where}.t`),
        label: optStr(o.label, `${where}.label`),
        style: parseStyle(o.style, `${where}.style`),
      };
    case 'sequence':
      return {
        type,
        expr: expr(o.expr, `${where}.expr`),
        n: pair(o.n, `${where}.n`),
        label: optStr(o.label, `${where}.label`),
        style: parseStyle(o.style, `${where}.style`),
      };
  }
}

function parseParam(v: unknown, where: string): ParamSpec {
  const o = obj(v, where);
  const min = num(o.min, `${where}.min`);
  const max = num(o.max, `${where}.max`);
  if (!(min < max)) throw new ToolInputError(`${where} 要求 min < max,收到 [${min}, ${max}]`);
  const value = num(o.value, `${where}.value`);
  return {
    name: str(o.name, `${where}.name`),
    value: Math.min(max, Math.max(min, value)),
    min,
    max,
    step: optNum(o.step, `${where}.step`) ?? (max - min) / 100,
    label: optStr(o.label, `${where}.label`),
  };
}

export function parsePlot2DSpec(v: unknown): Plot2DSpec {
  const o = obj(v, 'spec');
  const viewO = obj(o.view, 'spec.view');
  const view: Plot2DSpec['view'] = { x: pair(viewO.x, 'spec.view.x') };
  if (viewO.y !== undefined) view.y = pair(viewO.y, 'spec.view.y');

  const curvesRaw = arr(o.curves, 'spec.curves');
  if (!curvesRaw.length) throw new ToolInputError('spec.curves 至少要有一条曲线');

  const paramsRaw = optArr(o.params, 'spec.params') ?? [];

  return {
    kind: 'plot2d',
    view,
    curves: curvesRaw.map((c, i) => parseCurve(c, `spec.curves[${i}]`)),
    points: optArr(o.points, 'spec.points')?.map((p, i) => parsePoint(p, `spec.points[${i}]`)),
    params: paramsRaw.map((p, i) => parseParam(p, `spec.params[${i}]`)),
    annotations: optArr(o.annotations, 'spec.annotations')?.map((a, i) => parseAnnotation(a, `spec.annotations[${i}]`)),
    note: optStr(o.note, 'spec.note'),
  };
}

/** 两个表达式组成的坐标对。点的坐标要能引用参数(如 (a, f(a)) 随滑块移动)。 */
function exprPair(v: unknown, where: string): [string, string] {
  const a = arr(v, where);
  if (a.length !== 2) throw new ToolInputError(`${where} 必须是恰好两个表达式的数组 [x, y]`);
  return [expr(a[0], `${where}[0]`), expr(a[1], `${where}[1]`)];
}

function parsePoint(v: unknown, where: string): PlotPoint {
  const o = obj(v, where);
  return {
    name: str(o.name, `${where}.name`),
    at: exprPair(o.at, `${where}.at`),
    label: optStr(o.label, `${where}.label`),
    movable: optBool(o.movable, `${where}.movable`),
    style: parseStyle(o.style, `${where}.style`),
  };
}

function parseAnnotation(v: unknown, where: string): Annotation {
  const o = obj(v, where);
  return { at: exprPair(o.at, `${where}.at`), text: str(o.text, `${where}.text`) };
}

export function parseDerivationSpec(v: unknown): DerivationSpec {
  const o = obj(v, 'spec');
  const stepsRaw = arr(o.steps, 'spec.steps');
  if (!stepsRaw.length) throw new ToolInputError('spec.steps 不能为空');

  const seen = new Set<string>();
  const steps: DerivationStep[] = stepsRaw.map((s, i) => {
    const so = obj(s, `spec.steps[${i}]`);
    const id = str(so.id, `spec.steps[${i}].id`);
    if (seen.has(id)) throw new ToolInputError(`spec.steps[${i}].id "${id}" 重复,每步的 id 必须唯一`);
    seen.add(id);
    return {
      id,
      latex: str(so.latex, `spec.steps[${i}].latex`),
      reason: str(so.reason, `spec.steps[${i}].reason`),
      from: optArr(so.from, `spec.steps[${i}].from`)?.map((f, j) => str(f, `spec.steps[${i}].from[${j}]`)),
      gap: so.gap === undefined ? undefined : oneOf(so.gap, GAPS, `spec.steps[${i}].gap`),
      detail: optStr(so.detail, `spec.steps[${i}].detail`),
    };
  });

  // from 指向不存在的 step 是模型常犯的错,早点报出来
  for (const s of steps) {
    for (const f of s.from ?? []) {
      if (!seen.has(f)) throw new ToolInputError(`步骤 "${s.id}" 的 from 引用了不存在的步骤 "${f}"`);
    }
  }

  return {
    kind: 'derivation',
    statement: optStr(o.statement, 'spec.statement'),
    given: optArr(o.given, 'spec.given')?.map((g, i) => str(g, `spec.given[${i}]`)),
    steps,
    collapsed: optBool(o.collapsed, 'spec.collapsed'),
  };
}

export function parseQuizSpec(v: unknown): QuizSpec {
  const o = obj(v, 'spec');
  const choicesRaw = optArr(o.choices, 'spec.choices');
  const choices = choicesRaw?.map((c, i) => {
    const co = obj(c, `spec.choices[${i}]`);
    return { id: str(co.id, `spec.choices[${i}].id`), text: str(co.text, `spec.choices[${i}].text`) };
  });
  const answerKey = optArr(o.answerKey, 'spec.answerKey')?.map((a, i) => str(a, `spec.answerKey[${i}]`));

  if (choices && answerKey) {
    const ids = new Set(choices.map((c) => c.id));
    for (const k of answerKey) {
      if (!ids.has(k)) throw new ToolInputError(`spec.answerKey 里的 "${k}" 不在 spec.choices 的 id 里`);
    }
  }
  return {
    kind: 'quiz',
    question: str(o.question, 'spec.question'),
    choices,
    answerKey,
    explanation: optStr(o.explanation, 'spec.explanation'),
    freeformPlaceholder: optStr(o.freeformPlaceholder, 'spec.freeformPlaceholder'),
  };
}

export function parseHtmlSpec(v: unknown): HtmlSpec {
  const o = obj(v, 'spec');
  return {
    kind: 'html',
    html: str(o.html, 'spec.html'),
    height: optNum(o.height, 'spec.height'),
    capabilities: optArr(o.capabilities, 'spec.capabilities')?.map((c, i) => str(c, `spec.capabilities[${i}]`)),
  };
}

/** 按 kind 分派。patch 合并后的完整 spec 也走这里复检。 */
export function parseSpec(v: unknown): ArtifactSpec {
  const o = obj(v, 'spec');
  const kind = oneOf(o.kind, KINDS, 'spec.kind');
  switch (kind) {
    case 'plot2d':
      return parsePlot2DSpec(v);
    case 'derivation':
      return parseDerivationSpec(v);
    case 'quiz':
      return parseQuizSpec(v);
    case 'html':
      return parseHtmlSpec(v);
  }
}

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

export function latexToPlain(tex: string): string {
  return convert(tex).replace(/\s+/g, ' ').trim();
}

/** 生成人可读标题。它是上下文压缩的抓手,也是学生在对话里引用这张图的说法。 */
export function titleFor(spec: ArtifactSpec): string {
  switch (spec.kind) {
    case 'plot2d': {
      const label = spec.curves.find((c) => c.label)?.label;
      if (label) return clip(label);
      if (spec.note) return clip(spec.note);
      const c = spec.curves[0];
      if (c.type === 'explicit') return clip(`y = ${c.expr}`);
      if (c.type === 'parametric') return clip(`(${c.x}, ${c.y})`);
      return clip(`aₙ = ${c.expr}`);
    }
    case 'derivation':
      return clip(spec.statement ? `推导：${latexToPlain(spec.statement)}` : '推导');
    case 'quiz':
      return clip(`测验：${latexToPlain(spec.question)}`);
    case 'html':
      return '交互内容';
  }
}

function clip(s: string, max = 42): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
