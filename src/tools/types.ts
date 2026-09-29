/**
 * 工具层的类型契约。
 *
 * 单独一个文件是为了打断循环:每个 kind 模块都要 import 这些类型,
 * 如果它们留在 tools/index.ts 里,就会形成
 * tools/index → kinds/* → tools/index 的环。
 */
import type { ArtifactIndexEntry, ArtifactSpec, CanvasArtifact } from '../types/artifact';

export interface ToolContext {
  artifacts: ArtifactIndexEntry[];
  focus?: string;
  readArtifact: (id: string) => CanvasArtifact | undefined;
  /**
   * 这张图上的滑块**现在**停在哪儿。没拖过的参数不在里面。
   *
   * 和 spec 里 `params[].value` 不是一回事:那个是**默认值**,学生一拖就不再是
   * 屏幕上显示的数了。在此之前模型完全看不到这个值 —— 目录里只有"拖过 12 次"
   * 这个计数,而 `read_artifact` 给的是默认值,于是它会照着一个和屏幕不同的数字
   * 自信地作答。
   *
   * 只挂在按需调用的 `read_artifact` 上,不塞进每轮都发的目录 ——
   * 那样上下文会随学生拖滑块的次数一直长。
   */
  runtime: (id: string) => Record<string, number>;
}

export interface ToolOutcome {
  /** 回给模型的一句话。约定:不包含完整 spec。 */
  message: string;
  created?: { spec: ArtifactSpec; title: string }[];
  /** title 也一并给出:它是 spec 的派生数据,而 store 不认识 kind,算不了它。 */
  patched?: { id: string; patch: Partial<ArtifactSpec>; title: string };
}

export interface TeachingTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** 入参是 unknown 而不是具体类型:它接收的是模型的原始输出,是不可信输入。 */
  run: (args: unknown, ctx: ToolContext) => ToolOutcome;
}
