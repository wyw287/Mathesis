import type { ParamSpec } from '../types/artifact';

interface Props {
  params: ParamSpec[];
  /** 当前值(运行时覆盖 + spec 默认值) */
  scope: Record<string, number>;
  /** 拖动过程中连续回调。只改本地渲染,零延迟。 */
  onChange: (name: string, value: number) => void;
  /** 松手时才回调一次。这里才发事件给模型 —— 拖一次发几百条会把上下文撑爆。 */
  onCommit: (name: string, value: number) => void;
}

/**
 * 参数滑块。plot2d、plot3d、counterexample 共用。
 *
 * 拖动/提交分成两个回调是刻意的:拖动时只更新本地渲染(否则每移动一个像素
 * 都要写 store、还要发事件),松手才作为一次操作上报。
 */
export function ParamSliders({ params, scope, onChange, onCommit }: Props) {
  if (!params.length) return null;
  return (
    <div className="params">
      {params.map((p) => {
        const value = scope[p.name] ?? p.value;
        return (
          <label key={p.name} className="param">
            <span className="param-name">{p.label ?? p.name}</span>
            <input
              type="range"
              min={p.min}
              max={p.max}
              step={p.step ?? (p.max - p.min) / 100}
              value={value}
              onChange={(e) => onChange(p.name, Number(e.target.value))}
              onPointerUp={() => onCommit(p.name, value)}
              onKeyUp={() => onCommit(p.name, value)}
            />
            <span className="param-value">{value.toFixed(2)}</span>
          </label>
        );
      })}
    </div>
  );
}
