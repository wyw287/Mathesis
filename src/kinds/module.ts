/**
 * 一个 artifact 类型的完整定义。
 *
 * **新增一种 artifact = 新增一个实现这个接口的目录 + 在 registry.ts 里加一行。**
 * 框架代码(registry、ArtifactCard、store)完全不需要改动。
 *
 * 这个接口是刻意设计成「一个 kind 的所有行为都在一处」的:
 * 类型定义在 types/artifact.ts(那是契约,要保持可通读),
 * 而这个 kind 的解析、标题、渲染、工具四件事全在一起。
 * 拆开的话,想搞清楚"derivation 是怎么回事"要跳四个文件。
 */
import type { ComponentType } from 'react';
import type { ArtifactSpec, CanvasEvent } from '../types/artifact';
import type { TeachingTool } from '../tools/types';

/** 所有渲染器的 props 签名必须一致,注册表才能统一分派。 */
export interface RendererProps<S extends ArtifactSpec = ArtifactSpec> {
  spec: S;
  artifactId: string;
  /** artifact 的修订号。变了说明 AI 改过这张图,渲染器里与本地的临时状态要作废。 */
  rev: number;
  emit: (e: CanvasEvent) => void;
}

export interface KindModule<S extends ArtifactSpec = ArtifactSpec> {
  kind: S['kind'];

  /** 模型的原始输出 → 已验证的 spec。失败抛 ToolInputError。 */
  parse: (v: unknown) => S;

  /** 生成人可读标题。同时用于卡片头部和每轮发给模型的画布目录。 */
  title: (spec: S) => string;

  /** 渲染器。 */
  Body: ComponentType<RendererProps<S>>;

  /**
   * 产出这个 kind 的教学工具。
   *
   * 可以是缺省的 —— `html` 就没有工具:契约里它是 Tier 2 逃生舱口,
   * 只在 plot2d / derivation / quiz 确实表达不了时才该出现。
   * 给它一个一等公民的工具,模型会当成常规选项来用,而 Tier 2 的
   * spec 不可校验、不可引用、不可局部编辑。降级路径下模型仍然可以产出它。
   */
  tool?: TeachingTool;
}

/** 注册表里装的是异构的模块,遍历时分派逻辑只能看到公共部分。 */
export type AnyKindModule = KindModule<any>;
