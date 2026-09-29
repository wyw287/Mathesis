/**
 * Kind 注册表 —— 框架侧唯一认识所有 artifact 类型的地方。
 *
 * 这里不再有任何 switch。所有按 kind 分派的行为,都是从下面这张**显式列表**派生的:
 * 解析、标题、渲染、工具。所以新增一种 artifact 只需要新写一个目录 + 在这里加一项。
 *
 * 为什么是显式列表而不是自动发现(import.meta.glob / 自注册)?
 * 因为自动发现和穷尽性检查在根本上是对立的:
 *   · tagged union 的全部价值 = 编译器知道全部成员
 *   · 自注册的意义 = 编译器不知道有什么
 * 想同时要两者,就只能靠 declaration merging 补类型,而类型增强(编译期,文件在就生效)
 * 和运行时注册(副作用,被 import 才生效)是两套独立机制 —— 一个文件完全可以
 * "类型上存在、运行时不存在",编译器对此完全沉默。那正是我们花力气消灭的那类错误。
 *
 * 保持显式列表,代价是一行注册,换来的是类型和运行时**不可能分叉**。
 */
import type { ArtifactKind, ArtifactSpec, CanvasArtifact } from '../types/artifact';
import { migrateArtifact } from '../types/artifact';
import { ToolInputError, obj, str } from '../lib/validate';
import type { AnyKindModule } from './module';
import { plot2dModule } from './plot2d';
import { derivationModule } from './derivation';
import { quizModule } from './quiz';
import { htmlModule } from './html';
import { counterexampleModule } from './counterexample';
import { compareModule } from './compare';
import { plot3dModule } from './plot3d';
import { linearModule } from './linear';
import { diagramModule } from './diagram';

/**
 * 全部已注册的 artifact 类型。**新增 kind 就在这里加一行。**
 *
 * 刻意不加类型标注:加 `as const` 才能让下面那种 `(typeof KIND_MODULES)[number]['kind']`
 * 拿到字面量联合,而那个联合正是完整性断言和工具组装依赖的东西。
 */
export const KIND_MODULES = [
  plot2dModule,
  derivationModule,
  quizModule,
  counterexampleModule,
  compareModule,
  plot3dModule,
  linearModule,
  diagramModule,
  htmlModule,
] as const;

type RegisteredKind = (typeof KIND_MODULES)[number]['kind'];

/**
 * 编译期断言:注册表必须覆盖 ArtifactSpec 的所有 kind。
 *
 * 少注册一个 kind 时这个类型会变成那个 kind(而不是 never),
 * 下面那行赋值就会报错 —— 否则问题会一路潜伏到运行时,
 * 表现为画布上一张空白卡片,而且没有任何线索指向"你忘了注册"。
 */
type MissingFromRegistry = Exclude<ArtifactKind, RegisteredKind>;
export const REGISTRY_IS_COMPLETE: MissingFromRegistry extends never ? true : false = true;

/** 已注册的 kind 文本列表。用于运行时校验和给模型的错误信息。 */
export const KINDS: readonly string[] = KIND_MODULES.map((m) => m.kind);

export function kindModule(kind: string): AnyKindModule | undefined {
  return KIND_MODULES.find((m) => m.kind === kind);
}

/**
 * 按 kind 分派校验。patch 合并后的完整 spec 也走这里复检。
 *
 * 里面有一处类型断言,是全项目唯一的一处。TS 表达不了
 * "按 kind 取出对应模块,并把结果收窄成那个模块的 S"——
 * 每个模块的 parse 只接受自己那个 kind,校验由 parse 自己完成,所以是安全的。
 */
export function parseSpec(v: unknown): ArtifactSpec {
  const o = obj(v, 'spec');
  const kind = str(o.kind, 'spec.kind');
  const mod = kindModule(kind);
  if (!mod) {
    throw new ToolInputError(`不认识的 kind "${kind}"。只支持:${KINDS.join(' | ')}`);
  }
  return mod.parse(v) as ArtifactSpec;
}

/** 按 kind 分派标题生成。 */
export function titleFor(spec: ArtifactSpec): string {
  const mod = kindModule(spec.kind);
  return mod ? mod.title(spec) : '未知内容';
}

/**
 * 把从存储载入的 artifact 对齐到当前这份代码:跑 schema 迁移 + 重算标题。
 *
 * 为什么需要它 —— title 按契约是 artifact 的持久字段,但它其实是 spec 的**派生数据**。
 * 只存不算的后果有两个,都真实发生过:
 *   · 改了标题生成逻辑后,旧 artifact 永远停在旧标题上
 *   · AI 用 edit_artifact 改了内容,标题不跟着变,而目录是每轮发给模型的
 *
 * 为什么放在这里而不是 store 的 persist merge 里 —— 算标题要认识所有 kind,
 * 那会让 store 依赖注册表;而渲染器要读 store,于是形成
 * store → 注册表 → kind 模块 → store 的环。放在 UI 侧由 App 挂载时调一次即可。
 *
 * 没有任何变化时返回原数组引用,避免触发无谓的重渲染。
 */
export function reconcileArtifacts(artifacts: CanvasArtifact[]): CanvasArtifact[] {
  let changed = false;
  const next = artifacts.map((a) => {
    const migrated = migrateArtifact(a);
    if (migrated !== a) changed = true;
    const title = titleFor(migrated.spec);
    if (title === migrated.title) return migrated;
    changed = true;
    return { ...migrated, title };
  });
  return changed ? next : artifacts;
}
