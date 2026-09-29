/**
 * 降级路径:当 provider 不支持 tool calling 时,让模型用带标记的文本块输出 spec,
 * 前端从文本里把 spec 抠出来。
 *
 * 这不是可有可无的兼容层。BYOK 意味着用户可能接任何 OpenAI 兼容中转,
 * 其中相当一部分对 tools 的支持是残的。没有这条路,产品在那些环境下就是纯聊天。
 */

const FENCE = /```artifact\s*\n([\s\S]*?)```/g;

export interface ExtractedBlock {
  raw: string;
  spec: unknown;
}

/** 从助手文本里抽出所有 artifact 块。JSON 不合法就跳过该块(不抛错,不中断整条消息)。 */
export function extractArtifactBlocks(text: string): ExtractedBlock[] {
  const out: ExtractedBlock[] = [];
  for (const m of text.matchAll(FENCE)) {
    const raw = m[1].trim();
    try {
      out.push({ raw, spec: JSON.parse(raw) });
    } catch {
      // 模型写坏了 JSON,当普通文本留在对话里,让它自己看得见
    }
  }
  return out;
}

/** 把已渲染的 artifact 块从展示文本里去掉,避免同一份内容显示两遍。 */
export function stripArtifactBlocks(text: string): string {
  return text.replace(FENCE, '').replace(/\n{3,}/g, '\n\n').trim();
}

/** 追加给模型的降级指令。 */
export const FALLBACK_INSTRUCTION = `\n\n[系统] 当前环境不支持工具调用。请改用带标记的文本块输出可视化内容,格式为:

\`\`\`artifact
{ 完整的 spec JSON }
\`\`\`

spec 的 kind 取 "plot2d" | "derivation" | "quiz",字段定义见你的工具说明。
一个块一个完整 spec,JSON 必须合法可解析。普通讲解文字照常输出。`;
