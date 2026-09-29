/**
 * 运行时校验原语。
 *
 * 模型的输出是不可信输入,和用户输入同级 —— 类型断言不算校验。
 * 每个失败都带明确的位置说明,因为错误信息会原样回给模型让它自我修正。
 */

export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}

export type Rec = Record<string, unknown>;

export function obj(v: unknown, where: string): Rec {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw new ToolInputError(`${where} 必须是一个对象,收到 ${describe(v)}`);
  }
  return v as Rec;
}

export function arr(v: unknown, where: string): unknown[] {
  if (!Array.isArray(v)) throw new ToolInputError(`${where} 必须是数组,收到 ${describe(v)}`);
  return v;
}

export function str(v: unknown, where: string): string {
  if (typeof v !== 'string' || !v.trim()) {
    throw new ToolInputError(`${where} 必须是非空字符串,收到 ${describe(v)}`);
  }
  return v;
}

export function num(v: unknown, where: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new ToolInputError(`${where} 必须是有限数字,收到 ${describe(v)}`);
  }
  return v;
}

export function bool(v: unknown, where: string): boolean {
  if (typeof v !== 'boolean') throw new ToolInputError(`${where} 必须是布尔值,收到 ${describe(v)}`);
  return v;
}

/** [lo, hi] 区间,且要求 lo < hi。 */
export function pair(v: unknown, where: string): [number, number] {
  const a = arr(v, where);
  if (a.length !== 2) throw new ToolInputError(`${where} 必须是恰好两个数的数组 [起, 止]`);
  const lo = num(a[0], `${where}[0]`);
  const hi = num(a[1], `${where}[1]`);
  if (!(lo < hi)) throw new ToolInputError(`${where} 要求 起 < 止,收到 [${lo}, ${hi}]`);
  return [lo, hi];
}

export function oneOf<T extends string>(v: unknown, allowed: readonly T[], where: string): T {
  const s = str(v, where);
  if (!(allowed as readonly string[]).includes(s)) {
    throw new ToolInputError(`${where} 只能是 ${allowed.join(' | ')},收到 "${s}"`);
  }
  return s as T;
}

export const optObj = (v: unknown, where: string): Rec | undefined =>
  v === undefined || v === null ? undefined : obj(v, where);

export const optArr = (v: unknown, where: string): unknown[] | undefined =>
  v === undefined || v === null ? undefined : arr(v, where);

export const optStr = (v: unknown, where: string): string | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new ToolInputError(`${where} 必须是字符串,收到 ${describe(v)}`);
  return v.trim() || undefined;
};

export const optBool = (v: unknown, where: string): boolean | undefined =>
  v === undefined || v === null ? undefined : bool(v, where);

export const optNum = (v: unknown, where: string): number | undefined =>
  v === undefined || v === null ? undefined : num(v, where);

export function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `数组(长度 ${v.length})`;
  const t = typeof v;
  if (t === 'string') return `字符串 "${(v as string).slice(0, 40)}"`;
  if (t === 'number' || t === 'boolean') return `${t} ${String(v)}`;
  return t;
}
