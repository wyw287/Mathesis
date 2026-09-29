/**
 * html —— Tier 2 逃生舱口。
 *
 * 固定 schema 表达不了的需求才走这里(比如"把这张图变成动画")。它跑在
 * iframe sandbox="allow-scripts" 里,**绝不能加 allow-same-origin** ——
 * 两个同时给等于没沙箱,里面的脚本能直接摸到 IndexedDB 里的 API Key。
 *
 * 这个 kind **没有工具**:给了它一等公民的入口,模型会当成常规选项来用。
 * 而降级路径(文本块)下模型仍然可以产出它 —— 逃生舱口只在正门走不通时才用。
 */
import { obj, optArr, optNum, str } from '../../lib/validate';
import type { HtmlSpec } from '../../types/artifact';
import type { KindModule } from '../module';
import { HtmlBlock } from './HtmlBlock';

/** 标题不从这里派生 —— html 没有结构化内容可归纳,统一叫"交互内容"。 */
const TITLE = '交互内容';

export function parseHtmlSpec(v: unknown): HtmlSpec {
  const o = obj(v, 'spec');
  return {
    kind: 'html',
    html: str(o.html, 'spec.html'),
    height: optNum(o.height, 'spec.height'),
    capabilities: optArr(o.capabilities, 'spec.capabilities')?.map((c, i) => str(c, `spec.capabilities[${i}]`)),
  };
}

/** 按 kind 分派。patch 合并后的完整 spec 也走这里复检。 */
export const htmlModule: KindModule<HtmlSpec> = {
  kind: 'html',
  parse: parseHtmlSpec,
  title: () => TITLE,
  Body: HtmlBlock,
};
