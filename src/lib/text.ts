/**
 * 文本工具。放在 lib 里是因为每个 kind 的标题逻辑都要用,
 * 而让它们互相 import 会把 kind 之间连成一张网。
 */

/**
 * 标题长度上限。
 *
 * 24 而不是更长:标题是**一行**的,而且卡片头部还有类别徽章、id、修订号、
 * 删除按钮跟它并排,`.artifact-title` 上还挂着 `text-overflow: ellipsis` ——
 * 也就是说超过这里这个数,它会在 CSS 那一层**再被省略一次**,而且省略的位置
 * 取决于窗口宽度。与其让标题在两个地方被切、两边都不好看,不如在这里就切掉。
 *
 * 这个数的前提是**标题里不该有公式**:公式在卡片本体里渲染得好得多。
 * 想让标题"说完整"的冲动,正确做法是让模型给一个短名(`spec.label`),
 * 而不是把上限调大。
 *
 * 它同时是每轮随画布目录发给模型的上下文,所以长度也直接是 token 开销。
 */
export const TITLE_MAX = 24;

/** 标题截断。 */
export function clip(s: string, max = TITLE_MAX): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
