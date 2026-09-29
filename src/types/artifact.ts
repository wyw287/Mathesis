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
 *
 * 六种变体里,前三种的采样方式是"沿着 x 或 t 走一遍";后两种没有这个前提
 * (一个 x 可能对应多个 y),要在视口上铺二维网格,所以实现路径完全不同。
 */
export type Curve =
  | { type: 'explicit'; expr: string; domain?: [number, number]; label?: string; style?: LineStyle }
  | { type: 'parametric'; x: string; y: string; t: [number, number]; label?: string; style?: LineStyle }
  | { type: 'sequence'; expr: string; n: [number, number]; label?: string; style?: LineStyle }
  /**
   * 隐式曲线:满足 eq 的点集。`eq` 写成 `x^2+y^2=1` 或直接写 `x^2+y^2-1`
   * (后者视作等于 0)。这是水平集、圆、等高线、相图边界的画法。
   */
  | { type: 'implicit'; eq: string; label?: string; style?: LineStyle }
  /**
   * 向量场:每个网格点上画一个 (fx, fy) 方向的箭头。
   * 方向场(解 ODE 草图)、梯度场、线性变换的切向量场都用它。
   */
  | {
      type: 'vectorField';
      fx: string;
      fy: string;
      /** 每个方向上画多少个箭头,默认 14。太大就糊成一片。 */
      density?: number;
      /** fixed(默认,只看方向)或 magnitude(箭头长度反映模长) */
      scale?: 'fixed' | 'magnitude';
      label?: string;
      style?: LineStyle;
    };

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

/**
 * 一步的机器可读形式,交给 CAS 核对。
 *
 * **为什么必须由模型额外提供**:LaTeX 是排版语言,不是语义 —— 把
 * `\frac{d}{dx}x^2` 反解成表达式是出了名的不可靠。所以一个公式要能被核对,
 * 就必须同时有一个 CAS 读得懂的形式。
 *
 * 省略 `check` 是允许的:有些步骤本来就是文字性的(引入假设、说明思路)。
 * 但**能用表达式表达的步骤不给 `check`,等于放弃了被核对的机会**。
 */
export interface StepCheck {
  /** 这一步的式子,普通数学语法(用 ^ 表示幂,不是 LaTeX) */
  expr: string;
  /** 与哪一步比较。省略 = 上一步。上一步是文字性的时用它跳过。 */
  against?: string;
  /** 默认 equivalent;derivativeOf 表示 expr 应当是 against 的导数 */
  relation?: 'equivalent' | 'derivativeOf';
  /** 自由变量,默认 ['x'] */
  vars?: string[];
}

export interface DerivationStep {
  id: string;
  latex: string;
  reason: string;
  from?: string[];
  gap?: GapKind;
  detail?: string;
  check?: StepCheck;
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

// ---------------------------------------------------------------- 3D

/**
 * 三维曲面。
 *
 * 只做这两种 —— 它们和 2D 的网格采样是同一件事再加一维,模型的表达难度也一样。
 *
 * **隐式曲面 F(x,y,z)=0 不在这里**,那需要 marching cubes(256 种情形、约 15 种
 * 歧义,而且经典情形表是已知有洞的),是独立课题,不该和"加个 3D"混在一起。
 */
export type Surface3D =
  | {
      /** 高度图 z = f(x, y) —— 最常用的一种 */
      type: 'height';
      expr: string;
      over: { x: [number, number]; y: [number, number] };
      label?: string;
    }
  | {
      /** 参数曲面 (u, v) → (x, y, z)。球面、环面、旋转体都靠它。 */
      type: 'parametric';
      x: string;
      y: string;
      z: string;
      over: { u: [number, number]; v: [number, number] };
      label?: string;
    };

export interface Plot3DSpec {
  kind: 'plot3d';
  surface: Surface3D;
  /** 可拖动参数。表达式(高度图的 expr、参数曲面的 x/y/z)可以引用这些名字。 */
  params?: ParamSpec[];
  /** 相机的初始朝向,单位是度。省略则用默认的斜视角。 */
  view?: { yaw?: number; pitch?: number };
  /** 每边的网格密度,默认 44。调太高拖拽会卡。 */
  resolution?: number;
  /** 画网格线,默认开 —— 曲面的拓扑靠它才读得出来 */
  wireframe?: boolean;
  note?: string;
}

export type ArtifactSpec =
  | Plot2DSpec
  | DerivationSpec
  | QuizSpec
  | HtmlSpec
  | CounterexampleSpec
  | CompareSpec
  | Plot3DSpec;
export type ArtifactKind = ArtifactSpec['kind'];

// ---------------------------------------------------------------- 并排对比

/** 对比里的一格。 */
export interface CompareItem {
  /** 这一格的标题,例如 "f(x)" / "f'(x)" / "a = 0 的反例" */
  label: string;
  /** 只允许这两种 —— 能并排看的就是"图"和"推导"。 */
  spec: Plot2DSpec | DerivationSpec;
}

/**
 * 并排对比。
 *
 * 正例 vs 反例、f vs f′、两个反例对照 —— 教学效果最强的单项往往是"放在一起看"。
 *
 * **两边共享一套参数。** 拖一个滑块两边同时变,这正是对比最有用的形态:
 * 同一个 a 对两个函数各有什么影响,一眼就能看出来。各自独立反而丢掉了这个。
 *
 * 形态上和 counterexample 一样是**组合**:嵌进去的 spec 由它们各自的解析器和
 * 渲染器处理,这个 kind 只负责布局和那句要点。
 */
export interface CompareSpec {
  kind: 'compare';
  /** 恰好 2 或 3 格。再多就挤得看不清了。 */
  items: CompareItem[];
  /** 正在讨论的命题或问题,可选 */
  claim?: string;
  /**
   * 要学生注意的那个对比点。
   *
   * **这句话才是对比的意义所在。** 没有它,并排只是两张图 —— 学生不会自己
   * 知道该看哪里。
   */
  note?: string;
}

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
   * 学生转动了 3D 曲面的视角。
   *
   * 不带角度数据:相机位置对模型没有意义,它只需要知道"学生转着看了"。
   * 转一个曲面是个相当刻意的动作(比点一下卡片重得多),所以这个信号值得记下来。
   */
  | { type: 'orbit'; artifactId: string }
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
