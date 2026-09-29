/**
 * 文本工具。放在 lib 里是因为每个 kind 的标题逻辑都要用,
 * 而让它们互相 import 会把 kind 之间连成一张网。
 */

/**
 * 标题截断。
 *
 * 标题不只是显示用 —— 它每轮都会作为画布目录发给模型,所以长度直接影响上下文开销。
 * 42 这个数是在「够辨认」和「别太占 token」之间取的。
 */
export function clip(s: string, max = 42): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
