/**
 * 推导步骤的机器核对。
 *
 * ## 为什么需要它
 *
 * `derivation` 的 `gap` 字段是**模型自报**的:它说这一步是"套定义"还是"我跳过了"。
 * 对自学者来说,"这一步到底对不对"恰恰是他没法自己验证的那件事 —— 而学习工具
 * 和参考书之间的差别就在这里。
 *
 * ## LaTeX 不能拿来核对
 *
 * LaTeX 是**排版语言,不是语义**。把 `\frac{d}{dx}x^2` 反解成表达式是出了名的
 * 不可靠。所以模型必须为每一步**额外提供**一个机器可读的形式 —— 就是
 * `DerivationStep.check.expr`。
 *
 * ## 三态是怎么定出来的
 *
 * 实测(见 cas-check)发现:**nerdamer 和 algebrite 都认不出 `sin(2x) = 2sin(x)cos(x)`**。
 * 所以"CAS 算出非零"**不等于"这一步错了"**,只等于"我化简不出来"。混为一谈的话
 * 那一步会被冤枉。
 *
 * 于是用数值抽样来区分两种非零:
 *
 *   simplify(a-b) === 0                        → 机器确认等价
 *   非零,但抽样点上处处一致                     → 化简不出来,弱证据
 *   非零,且抽样点上算出不一致                   → **这一步是错的**
 *
 * 第三行是这套东西最有价值的产出:它让系统第一次能**指出模型讲错了**,
 * 而不是让学生去信任它。
 */
import { safeEval } from './math';

export type VerifyStatus = 'confirmed' | 'differs' | 'unconfirmed' | 'unavailable';

export interface Verdict {
  status: VerifyStatus;
  /** 一句话说明是怎么判出来的,显示在徽章的提示里 */
  note: string;
}

/** 抽样点数。少了区分度不够,多了会拖慢整条推导的核对。 */
const SAMPLES = 60;
/** 抽样区间取 [-3, 3] —— 够宽,又不至于把大多数式子推进无定义区。 */
const RANGE = 3;
/** 相对容差。绝对值比较会在量级差异大时误判。 */
const TOL = 1e-7;
/** 有效抽样点少于这个数就判"无法核对" —— 采样证明不了普适命题。 */
const MIN_USABLE = 8;

type CasModule = typeof import('nerdamer/all.min.js').default;

let casPromise: Promise<CasModule> | null = null;

/**
 * 动态加载 CAS。
 *
 * 426 KB —— 比已经装着的 mathjs(584 KB)和 katex(1.3 MB)都小,但没必要让它进
 * 首屏:大部分画布上根本没有推导。第一次真的要核对时才拉。
 */
export function loadCas(): Promise<CasModule> {
  if (!casPromise) {
    casPromise = import('nerdamer/all.min.js').then((m) => m.default ?? (m as unknown as CasModule));
  }
  return casPromise;
}

/** nerdamer 的化简结果可能很长,报错里截一下就够了。 */
function clip(s: string, n = 60): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

/**
 * 数值抽查:两个表达式在随机点上是否处处一致。
 *
 * **它的用途不是"证明等价"** —— 采样证明不了普适命题,只能证伪。
 * 它的用途是区分上面说的那两种非零。
 *
 * 返回:
 *   false —— 抽到了矛盾点,这两个式子**不是**同一个函数
 *   true  —— 抽样范围内一致(弱证据)
 *   null  —— 有效抽样点太少,判不了
 */
export function numericAgrees(expr: string, target: string, vars: string[]): boolean | null {
  const names = vars.length ? vars : ['x'];
  let usable = 0;

  for (let i = 0; i < SAMPLES; i++) {
    const scope: Record<string, number> = {};
    for (const name of names) scope[name] = (Math.random() * 2 - 1) * RANGE;

    const a = safeEval(expr, scope);
    const b = safeEval(target, scope);
    // 该点无定义就跳过 —— 不是矛盾,只是这次抽样作废
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;

    usable++;
    const scale = Math.max(1, Math.abs(a), Math.abs(b));
    if (Math.abs(a - b) > TOL * scale) return false;
  }

  return usable >= MIN_USABLE ? true : null;
}

export interface VerifyRequest {
  /** 这一步的式子 */
  expr: string;
  /** 与之比较的式子。通常是上一步。 */
  against: string;
  /** 默认等价比较;derivativeOf 表示 expr 应当是 against 的导数 */
  relation?: 'equivalent' | 'derivativeOf';
  /** 自由变量。默认 ['x']。 */
  vars?: string[];
}

export async function verifyStep(req: VerifyRequest): Promise<Verdict> {
  const relation = req.relation ?? 'equivalent';
  const vars = req.vars?.length ? req.vars : ['x'];
  const cas = await loadCas();

  // 求导关系先用 CAS 把目标算出来,再退化成等价比较 ——
  // 这一步是**符号**核对,比数值强
  let target = req.against;
  let how = '等价';
  if (relation === 'derivativeOf') {
    try {
      target = cas.diff(req.against, vars[0]!).toString();
    } catch {
      return { status: 'unavailable', note: 'CAS 没法对这一步求导,核对不了' };
    }
    how = '求导';
  }

  let residual: string;
  try {
    residual = cas(`simplify((${req.expr}) - (${target}))`).toString();
  } catch {
    return { status: 'unavailable', note: '表达式无法解析成 CAS 能读的形式' };
  }

  if (residual === '0') {
    return { status: 'confirmed', note: `机器核对通过（${how}）` };
  }

  const agrees = numericAgrees(req.expr, target, vars);
  if (agrees === false) {
    return {
      status: 'differs',
      note: `这一步与上一步不相等 —— 化简后差为 ${clip(residual)},并在抽样点上算出不一致`,
    };
  }
  if (agrees === true) {
    // 实测里 sin(2x) = 2sin(x)cos(x) 就落在这里:CAS 认不出,但式子是对的。
    // 所以这里**不能**说"错了",也不能说"确认"。
    return { status: 'unconfirmed', note: 'CAS 化简不出等价,但抽样点上处处一致（弱证据,不是证明）' };
  }
  return { status: 'unconfirmed', note: 'CAS 化简不出等价,而且有效抽样点太少,核对不了' };
}
