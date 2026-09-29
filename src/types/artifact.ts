/**
 * Canvas Artifact 契约 —— 见 docs/artifact-schema.md
 *
 * 这个文件是整个系统的中枢。对话层、工具层、画布层、渲染层只通过这里定义的类型通信。
 * 改动这里的成本随时间指数上升,加字段比改字段安全得多。
 */

export const CURRENT_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------- 基础

export interface LineStyle {
  color?: string;
  dash?: 'solid' | 'dashed' | 'dotted';
  width?: number;
}

/** 可拖动 / 可被参数驱动的点。坐标是表达式,可以引用 params 里的参数名。 */
export interface PlotPoint {
  name: string;
  at: [string, string];
  label?: string;
  movable?: boolean;
  style?: LineStyle;
}

export interface ParamSpec {
  name: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  label?: string;
}

export interface Annotation {
  at: [string, string];
  text: string;
}

// ---------------------------------------------------------------- Spec 家族

/**
 * expr 是受限数学表达式,不是 JS。变量为 x(或 t/n)加上 params 里声明的参数名。
 * 由 mathjs 解析;不允许赋值、函数定义、多语句 —— 无副作用,所以不需要沙箱。
 */
export type Curve =
  | { type: 'explicit'; expr: string; domain?: [number, number]; label?: string; style?: LineStyle }
  | { type: 'parametric'; x: string; y: string; t: [number, number]; label?: string; style?: LineStyle }
  | { type: 'sequence'; expr: string; n: [number, number]; label?: string; style?: LineStyle };

export interface Plot2DSpec {
  kind: 'plot2d';
  view: { x: [number, number]; y?: [number, number] };
  curves: Curve[];
  points?: PlotPoint[];
  params?: ParamSpec[];
  annotations?: Annotation[];
  /** 一句话说明这张图要人注意什么。会显示在图上方,也会进上下文。 */
  note?: string;
}

/**
 * gap 是这份契约里最重要的字段:强制模型标注每一步的性质,
 * 让学生看得出哪一步是套定义、哪一步是整个证明真正干活的地方、
 * 以及模型在哪里悄悄跳过了东西。
 */
export type GapKind = 'technical' | 'substantive' | 'unjustified' | 'assumption';

export interface DerivationStep {
  id: string;
  latex: string;
  reason: string;
  from?: string[];
  gap?: GapKind;
  detail?: string;
}

export interface DerivationSpec {
  kind: 'derivation';
  statement?: string;
  given?: string[];
  steps: DerivationStep[];
  collapsed?: boolean;
}

export interface QuizSpec {
  kind: 'quiz';
  question: string;
  choices?: { id: string; text: string }[];
  /** 不下发给渲染层用于展示;作答前不得出现在 DOM 里。 */
  answerKey?: string[];
  explanation?: string;
  freeformPlaceholder?: string;
}

/** Tier 2 逃生舱口。固定 schema 表达不了时才用,一律跑在 iframe 沙箱里。 */
export interface HtmlSpec {
  kind: 'html';
  html: string;
  height?: number;
  capabilities?: string[];
}

// ---------------------------------------------------------------- 反例工作台

/**
 * 一条条件检查。
 *
 * 三种可信度是刻意分开的,用意和 `derivation` 的 `gap` 完全一样:
 * **让学生看得出哪一条是算出来的、哪一条只是模型说的。**
 *
 * 有些前提在数值上根本验不了 —— 连续、可导、一致收敛都属于这类。
 * 把它们和算出来的混在一起显示成同样的对勾,等于让学生以为"系统验过了"。
 * 那比不做检查更糟:它给了一个假的确定性。
 */
export type CounterexampleCheck =
  | {
      id: string;
      /** 给人看的一句话,可含 LaTeX */
      label: string;
      /** 在参数上求值再比对 —— 算出来的 */
      kind: 'numeric';
      /** 可引用 params 里的参数名 */
      expr: string;
      op: 'eq' | 'ne' | 'gt' | 'lt' | 'ge' | 'le';
      value: number;
      /** op 为 eq/ne 时的容差,默认 1e-6 */
      tol?: number;
    }
  | {
      id: string;
      label: string;
      /** 采样判性质 —— 采样验的。采样证明不了普适命题,所以这一类叫"采样",不叫"验证" */
      kind: 'sampled';
      expr: string;
      property: 'positive' | 'negative' | 'signChanges' | 'increasing' | 'decreasing';
      over: [number, number];
    }
  | {
      id: string;
      label: string;
      /** 模型声称成立,我们验不了。必须如实显示成"未验证",不能混进对勾里 */
      kind: 'asserted';
    };

/**
 * 反例工作台。
 *
 * 一个反例 = 满足命题**全部前提**、但让**结论不成立**的对象。
 * 学生的任务就是在参数空间里找到这样的一个点。
 *
 * `plot` 直接复用 Plot2DSpec —— 候选反例本来就是要画出来的函数,
 * 而 plot2d 已经有参数、曲线、点、标注这一整套。所以这个 kind 的渲染
 * 基本是"现有的 Plot2D + 一块条件面板",不需要新的绘图代码。
 */
export interface CounterexampleSpec {
  kind: 'counterexample';
  /** 要反驳的命题(LaTeX) */
  claim: string;
  /** 候选对象。它的 params 就是工作台的滑块,检查项引用同一套参数名。 */
  plot: Plot2DSpec;
  /** 反例必须满足的前提 */
  hypotheses: CounterexampleCheck[];
  /** 反例必须让它不成立的那条结论(写成"结论不成立"的形式) */
  conclusion: CounterexampleCheck;
  /** 全部通过时的一句话,告诉学生他找到了什么 */
  found?: string;
}

export type ArtifactSpec = Plot2DSpec | DerivationSpec | QuizSpec | HtmlSpec | CounterexampleSpec;
export type ArtifactKind = ArtifactSpec['kind'];

// ---------------------------------------------------------------- Artifact

export interface CanvasArtifact<S extends ArtifactSpec = ArtifactSpec> {
  id: string;
  spec: S;
  /** 修订号,从 1 开始。用户改滑块、AI 改定义域都会 +1。 */
  rev: number;
  /** spec 结构本身的版本。只在前端不兼容升级时 +1。 */
  schemaVersion: number;
  origin: 'ai' | 'user';
  /** 人可读,是上下文压缩的抓手:塞给模型的只有这张目录,不是完整 spec。 */
  title: string;
  createdAt: number;
  updatedAt: number;
}

/** 进上下文的最小单元。 */
export interface ArtifactIndexEntry {
  id: string;
  kind: ArtifactKind;
  title: string;
}

export function toIndexEntry(a: CanvasArtifact): ArtifactIndexEntry {
  return { id: a.id, kind: a.spec.kind, title: a.title };
}

// ---------------------------------------------------------------- 事件:画布 → 对话

export type CanvasEvent =
  | { type: 'paramChange'; artifactId: string; param: string; value: number }
  | { type: 'pointDrag'; artifactId: string; point: string; xy: [number, number] }
  | { type: 'select'; artifactId: string; target?: string }
  | { type: 'stepConfused'; artifactId: string; stepId: string }
  | { type: 'stepExpand'; artifactId: string; stepId: string }
  | { type: 'answer'; artifactId: string; response: { choice?: string; text?: string } }
  | { type: 'viewport'; artifactId: string; view: { x: [number, number]; y: [number, number] } }
  /**
   * 学生把这张卡片删掉了。
   *
   * 带上 title 是因为别的字段都能事后去 store 查,这个查不到了 ——
   * 事件真正被读到时,artifact 已经不在画布上了。
   *
   * 有这个事件之前,删除是唯一一条**对模型完全不可见**的变更:创建和修改都走
   * 工具调用(模型看得到工具结果),而删除走 UI 按钮直接改 store。
   * 后果是模型下一轮只看到目录里少了一项,分不清"被删了"和"从没存在过"。
   */
  | { type: 'remove'; artifactId: string; title: string };

/**
 * 只有 stepConfused 必须立刻触发模型调用 —— 它是学生的求救信号。
 * 其余事件落进 pendingEvents,由前端按策略决定何时并入下一条用户消息。
 */
export const IMMEDIATE_EVENTS: ReadonlySet<CanvasEvent['type']> = new Set(['stepConfused']);

// ---------------------------------------------------------------- 版本迁移

type Migration = (spec: any) => any;

/** 加入新的 schemaVersion 时在这里追加。键是「从哪个版本迁出」。 */
const MIGRATIONS: Record<number, Migration> = {
  // 1: (spec) => ({ ...spec, newField: defaultValue }),
};

export function migrateArtifact(a: CanvasArtifact): CanvasArtifact {
  let spec = a.spec;
  let v = a.schemaVersion ?? 0;
  while (v < CURRENT_SCHEMA_VERSION) {
    const m = MIGRATIONS[v];
    if (!m) break;
    spec = m(spec);
    v += 1;
  }
  return v === a.schemaVersion ? a : { ...a, spec: spec as ArtifactSpec, schemaVersion: v };
}
