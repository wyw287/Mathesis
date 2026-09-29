import { useMemo } from 'react';
import { layoutGraph, type LayoutOptions } from '../../lib/graph-layout';
import { latexToPlain } from '../../lib/latex-plain';
import { MathText } from '../../renderers/Markdown';
import type { CanvasEvent, DiagramRole, DiagramSpec } from '../../types/artifact';

const PAD = 14;

/**
 * 节点宽度按**最长标签**估出来,而不是写死。
 *
 * 布局要求所有节点等宽(不等宽的话分层算法的坐标计算要复杂一大截),
 * 但等宽不代表要浪费:按内容估一个,整体就不会留出大片空白或挤成一团。
 * 用 `latexToPlain` 估长度,是因为标签多半是 LaTeX —— 直接按字符数算的话
 * `\lim_{x\to 0}` 会被当成 12 个字。
 */
function measureWidth(spec: DiagramSpec): number {
  let longest = 0;
  for (const n of spec.nodes) longest = Math.max(longest, latexToPlain(n.label).length);
  return Math.max(120, Math.min(240, longest * 9 + 28));
}

const ROLE_CLASS: Record<DiagramRole, string> = {
  plain: 'dg-plain',
  given: 'dg-given',
  key: 'dg-key',
  conclusion: 'dg-conclusion',
};

interface Props {
  spec: DiagramSpec;
  artifactId: string;
  emit: (e: CanvasEvent) => void;
}

export function Diagram({ spec, artifactId, emit }: Props) {
  const { layout, nodeW, nodeH, options } = useMemo(() => {
    const w = measureWidth(spec);
    const h = 46;
    const opts: LayoutOptions = {
      direction: spec.direction ?? 'down',
      nodeW: w,
      nodeH: h,
      gapX: 22,
      gapY: 38,
    };
    return {
      layout: layoutGraph(
        spec.nodes.map((n) => n.id),
        spec.edges,
        opts,
      ),
      nodeW: w,
      nodeH: h,
      options: opts,
    };
  }, [spec.nodes, spec.edges, spec.direction]);

  const byId = useMemo(() => new Map(spec.nodes.map((n) => [n.id, n])), [spec.nodes]);
  const width = layout.width + PAD * 2;
  const height = layout.height + PAD * 2;
  const down = options.direction === 'down';

  /** 边的两个端点:从源节点的下(右)缘中点,到目标节点的上(左)缘中点。 */
  const anchor = (id: string, side: 'out' | 'in'): [number, number] | null => {
    const n = layout.nodes.get(id);
    if (!n) return null;
    if (down) return [n.x + nodeW / 2 + PAD, side === 'out' ? n.y + nodeH + PAD : n.y + PAD];
    return [side === 'out' ? n.x + nodeW + PAD : n.x + PAD, n.y + nodeH / 2 + PAD];
  };

  return (
    <div className="diagram">
      {spec.note && <div className="plot-note">{spec.note}</div>}

      <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} className="dg-svg">
        <defs>
          <marker id={`dg-arrow-${artifactId}`} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
            <path d="M0,0 L8,4 L0,8 Z" fill="currentColor" />
          </marker>
        </defs>

        {/* 边先画,节点压在上面 */}
        <g>
          {layout.edges.map((e, i) => {
            const a = anchor(e.from, 'out');
            const b = anchor(e.to, 'in');
            if (!a || !b) return null;
            const mx = (a[0] + b[0]) / 2;
            const my = (a[1] + b[1]) / 2;
            return (
              <g key={i} className="dg-edge">
                <line
                  x1={a[0]}
                  y1={a[1]}
                  x2={b[0]}
                  y2={b[1]}
                  markerEnd={`url(#dg-arrow-${artifactId})`}
                  style={{ color: 'currentColor' }}
                />
                {e.label && (
                  <text x={down ? mx + 6 : mx} y={down ? my : my - 5} className="dg-edge-label">
                    {e.label}
                  </text>
                )}
              </g>
            );
          })}
        </g>

        {/* 节点 */}
        <g>
          {spec.nodes.map((node) => {
            const n = layout.nodes.get(node.id);
            if (!n) return null;
            const cls = `dg-node ${ROLE_CLASS[node.role ?? 'plain']}`;
            return (
              <g
                key={node.id}
                transform={`translate(${n.x + PAD}, ${n.y + PAD})`}
                className={cls}
                // 点节点 → 追问。流程图是死的,而画布是活的:点一下就让老师展开讲。
                // 复用已有的 select 事件,不新增协议。
                onClick={() => emit({ type: 'select', artifactId, target: node.id })}
              >
                <rect width={nodeW} height={nodeH} rx={8} />
                <foreignObject x={0} y={0} width={nodeW} height={nodeH}>
                  <div className="dg-label">
                    <MathText text={node.label} />
                  </div>
                </foreignObject>
              </g>
            );
          })}
        </g>
      </svg>

      {layout.ignored.length > 0 && (
        // 回边不能静默丢掉。环形关系(`A ⟺ B`、互相引用)在教学里很常见,
        // 分层布局画不了它们 —— 与其画一张错的,不如说清楚哪几条没画进去。
        <div className="dg-note">
          有 {layout.ignored.length} 条边指回了上一层,分层布局画不出环形关系,已略去：
          {layout.ignored.map((e) => `${short(byId.get(e.from)?.label ?? e.from)} → ${short(byId.get(e.to)?.label ?? e.to)}`).join('、')}
        </div>
      )}

      {spec.nodes.some((n) => n.role && n.role !== 'plain') && (
        <div className="dg-legend">
          <Legend cls="dg-given" text="前提" />
          <Legend cls="dg-key" text="关键" />
          <Legend cls="dg-conclusion" text="结论" />
        </div>
      )}
    </div>
  );
}

function Legend({ cls, text }: { cls: string; text: string }) {
  return (
    <span className="dg-legend-item">
      <span className={`dg-swatch ${cls}`} />
      {text}
    </span>
  );
}

function short(s: string, n = 12): string {
  const flat = latexToPlain(s).replace(/\s+/g, ' ');
  return flat.length <= n ? flat : `${flat.slice(0, n)}…`;
}
