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
      return clip(spec.statement ? `推导：${spec.statement}` : '推导');
    case 'quiz':
      return clip(`测验：${spec.question}`);
    case 'html':
      return '交互内容';
  }
}

function clip(s: string, max = 42): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
