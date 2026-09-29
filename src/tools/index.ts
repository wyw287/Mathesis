/**
 * 教学工具注册表。
 *
 * 这里**不认识任何具体的 kind** —— 每种 artifact 的工具定义在
 * `src/kinds/<kind>/` 里,和它的 spec、渲染器放在一起。这个文件只负责组装:
 *   各 kind 的工具 + 与 kind 无关的操作(read_artifact / edit_artifact)
 *
 * 所以新增一种 artifact,不需要动这个文件。
 *
 * 两条贯穿全层的约定:
 *   · 工具的 description 不只是给模型看的文档,也是产品设计的载体。
 *     「一个图里放多条曲线」「用 unjustified 诚实标注省略的步骤」这类要求
 *     写在 schema 描述里的效果,比写在系统提示词里更牢。
 *   · run() 返回给模型的是**一句话**,不是它刚写的 spec。
 *     一张 300 行的 spec 如果每轮都回灌,聊十轮上下文就爆了。
 */
import { KIND_MODULES } from '../kinds/registry';
import { editArtifact, readArtifact } from './artifact-ops';
import type { TeachingTool } from './types';

export type { TeachingTool, ToolContext, ToolOutcome } from './types';

/** 各 kind 自己声明的工具,加上两个通用操作。没有工具的 kind 会被跳过(如 html)。 */
export const TOOLS: TeachingTool[] = [
  ...KIND_MODULES.map((m) => m.tool).filter((t): t is TeachingTool => !!t),
  readArtifact,
  editArtifact,
];

export function toolByName(name: string): TeachingTool | undefined {
  return TOOLS.find((t) => t.name === name);
}

/** 转成 OpenAI 兼容的 tools 字段。 */
export function toOpenAiTools(): unknown[] {
  return TOOLS.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/**
 * 降级路径用:把工具说明渲染成纯文本塞进提示词。
 * 排除 read/edit —— 那两个依赖真实的画布状态,在文本模式下无从谈起。
 */
export function toolsAsText(): string {
  return TOOLS.filter((t) => t.name !== 'read_artifact' && t.name !== 'edit_artifact')
    .map((t) => `### ${t.name}\n${t.description}\n参数 JSON Schema:\n${JSON.stringify(t.parameters)}`)
    .join('\n\n');
}
