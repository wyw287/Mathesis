import { useShallow } from 'zustand/react/shallow';
import { MathText } from '../../renderers/Markdown';
import { useSession } from '../../store/session';
import type { CompareSpec, Plot2DSpec } from '../../types/artifact';
import { Derivation } from '../derivation/Derivation';
import type { RendererProps } from '../module';
import { Plot2D } from '../plot2d/Plot2D';

/**
 * 并排对比。
 *
 * **各格共享同一个 artifactId**,于是它们天然共用一份参数作用域 ——
 * 拖一个滑块两边同时变。这是"对比"最有用的形态:同一个 a 对两个函数
 * 各有什么影响,一眼就能看出来。各自独立反而丢掉了这个。
 *
 * 代价是嵌进来的 Plot2D 都会用同一个 clipPath id,所以每一格要传不同的
 * `clipKey` —— 重复的 DOM id 会让 `url(#clip-…)` 解析到第一个节点,
 * 两格宽度不同时就会剪错。
 */
export function Compare({ spec, artifactId, rev, emit }: RendererProps<CompareSpec>) {
  // 各格声明的参数合并成一份。同名的以最后一个声明为准 ——
  // 工具描述里要求只声明一次,所以正常情况下不会撞。
  const scope = useSession(
    useShallow((s) => ({ ...defaultsOf(spec), ...s.runtime[artifactId] })),
  );
  const setParam = useSession((s) => s.setParam);

  return (
    <div className="cmp">
      {spec.claim && (
        <div className="cmp-claim">
          <MathText text={spec.claim} />
        </div>
      )}
      {spec.note && (
        // 放在图**上面** —— 它是"请留意哪里"的提示,不是看完之后的结论
        <div className="cmp-note">
          <MathText text={spec.note} />
        </div>
      )}

      <div className="cmp-grid">
        {spec.items.map((item, i) => (
          <div className="cmp-cell" key={`${item.label}-${i}`}>
            <div className="cmp-label">
              <MathText text={item.label} />
            </div>
            {item.spec.kind === 'plot2d' ? (
              <Plot2D
                spec={item.spec}
                scope={scope}
                artifactId={artifactId}
                clipKey={`${artifactId}-${i}`}
                rev={rev}
                emit={emit}
                onParam={(name, value) => setParam(artifactId, name, value)}
              />
            ) : (
              <Derivation spec={item.spec} artifactId={artifactId} rev={rev} emit={emit} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function defaultsOf(spec: CompareSpec): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of spec.items) {
    if (item.spec.kind !== 'plot2d') continue;
    for (const p of (item.spec as Plot2DSpec).params ?? []) out[p.name] = p.value;
  }
  return out;
}
