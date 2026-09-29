/**
 * 与 kind 无关的 artifact 操作。
 *
 * read_artifact / edit_artifact 对任何 kind 都成立,不属于某一种 artifact,
 * 所以留在工具层而不是塞进某个 kind 目录。
 */
import { parseSpec, titleFor } from '../kinds/registry';
import { ToolInputError } from '../lib/validate';
import type { TeachingTool, ToolContext } from './types';

function indexText(ctx: ToolContext): string {
  if (!ctx.artifacts.length) return '(画布当前为空)';
  return ctx.artifacts.map((a) => `[${a.id}] ${a.kind} ${a.title}`).join('\n');
}

// -------------------------------------------------------------------- plot2d
export const readArtifact: TeachingTool = {
  name: 'read_artifact',
  description:
    '读取画布上某个 artifact 的完整内容。画布目录里只有 id、类型和标题,' +
    '需要看具体内容(比如学生问"刚才那个图的定义域是什么")时才调用。',
  parameters: {
    type: 'object',
    properties: { id: { type: 'string', description: 'artifact id' } },
    required: ['id'],
  },
  run: (args, ctx) => {
    const id = String((args as any)?.id ?? '');
    const art = ctx.readArtifact(id);
    if (!art) {
      throw new ToolInputError(`画布上没有 id 为 "${id}" 的内容。当前画布目录:\n${indexText(ctx)}`);
    }
    return { message: JSON.stringify(art.spec) };
  },
};

export const editArtifact: TeachingTool = {
  name: 'edit_artifact',
  description:
    '修改画布上已有的内容。**要改已存在的图时必须用这个,不要重新画一张** —— ' +
    '重画会打断学生的空间记忆,也会让画布堆满近似重复的图。\n' +
    'patch 是浅合并:只需给出要改的字段,数组字段会整体替换。不能改 kind。',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: '要修改的 artifact id' },
      patch: {
        type: 'object',
        description:
          '要覆盖的字段。例如把 x 轴拉宽并换掉曲线:{"view": {"x": [-10, 10]}, "curves": [...]}',
      },
    },
    required: ['id', 'patch'],
  },
  run: (args, ctx) => {
    const a = (args ?? {}) as Record<string, unknown>;
    const id = typeof a.id === 'string' ? a.id : '';
    const patch = a.patch;
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new ToolInputError('patch 必须是一个对象');
    }
    const art = ctx.readArtifact(id);
    if (!art) {
      throw new ToolInputError(`画布上没有 id 为 "${id}" 的内容。当前画布目录:\n${indexText(ctx)}`);
    }
    const merged = { ...art.spec, ...(patch as object) };
    if ((merged as any).kind !== art.spec.kind) {
      throw new ToolInputError(`不能通过 edit_artifact 改变 kind(当前是 ${art.spec.kind})。要换类型请用对应的新建工具。`);
    }
    const spec = parseSpec(merged);
    const title = titleFor(spec);
    return { message: `已更新 [${id}] → ${title}`, patched: { id, patch: spec, title } };
  },
};
