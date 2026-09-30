import { useEffect, useMemo, useState } from 'react';
import { safeEval } from '../../lib/math';
import {
  determinant,
  dotProducts,
  inverse,
  isSquare,
  multiply,
  transpose,
  type Matrix,
} from '../../lib/matrixn';
import { ParamSliders } from '../../renderers/ParamSliders';
import type { CanvasEvent, MatrixSpec } from '../../types/artifact';

interface Props {
  spec: MatrixSpec;
  scope: Record<string, number>;
  artifactId: string;
  rev: number;
  onParam: (name: string, value: number) => void;
  emit: (e: CanvasEvent) => void;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 小而整齐的数字直接写,其余留四位有效数字 —— 它旁边还会有推导,不必显示十几位。 */
function fmt(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) < 1e-10) return '0';
  if (Number.isInteger(n) && Math.abs(n) < 1e6) return String(n);
  return String(Number(n.toPrecision(4)));
}

/** 一行里显示的紧凑形式:`[1 3; 2 4]`。派生量(转置、逆)用它就够了,不必再画一张网格。 */
function inline(m: Matrix): string {
  return `[${m.map((row) => row.map(fmt).join(' ')).join('; ')}]`;
}

export function MatrixView({ spec, scope, artifactId, rev, onParam, emit }: Props) {
  /**
   * 聚焦哪一格。**只改本地状态,不写回 spec** —— 点一下不该变成一次"编辑",
   * 那会让卡片上的修订号无谓地涨、也会把一次查看变成一次对模型的指令。
   * 模型想知道学生点了哪儿,靠的是下面发出去的 select 事件。
   *
   * spec.focus 是**开场**停在哪儿(模型可以说"看第 2 行第 1 列")。
   * 内容被改过就回到开场 —— 学生点的那一格可能已经不存在了。
   */
  const [focus, setFocus] = useState<[number, number]>(spec.focus ?? [0, 0]);
  useEffect(() => setFocus(spec.focus ?? [0, 0]), [spec, rev]);

  /** 把表达式矩阵在**当前参数**下求值。有一项无定义就整块不显示,不硬凑。 */
  const evaluate = (rows: string[][]): Matrix | null => {
    const out = rows.map((row) => row.map((e) => safeEval(e, scope)));
    return out.every((row) => row.every(Number.isFinite)) ? out : null;
  };

  const A = useMemo(() => evaluate(spec.rows), [spec.rows, scope]);
  const B = useMemo(() => (spec.multiplyBy ? evaluate(spec.multiplyBy) : null), [spec.multiplyBy, scope]);
  const product = useMemo(() => (A && B ? multiply(A, B) : null), [A, B]);

  // 乘积的尺寸由 B 的列数决定;没有 B 时,聚焦的是 A 自己的格子
  const rowCount = A?.length ?? 0;
  const colCount = B ? (B[0]?.length ?? 0) : (A?.[0]?.length ?? 0);
  const ri = clamp(focus[0], 0, Math.max(0, rowCount - 1));
  const cj = clamp(focus[1], 0, Math.max(0, colCount - 1));

  const terms = A && B ? dotProducts(A, B, ri, cj) : null;

  /** 点格子。A 里点的是**行**,B 里点的是**列**,乘积里点的是那一格本身。 */
  const pick = (which: 'A' | 'B' | 'C', i: number, j: number) => {
    setFocus(which === 'A' ? [i, cj] : which === 'B' ? [ri, j] : [i, j]);
    const what =
      which === 'A' ? `A 的第 ${i + 1} 行` : which === 'B' ? `B 的第 ${j + 1} 列` : `A·B 的第 ${i + 1} 行第 ${j + 1} 列`;
    emit({ type: 'select', artifactId, target: what });
  };

  const dA = A && isSquare(A) ? determinant(A) : null;
  const invA = A && isSquare(A) ? inverse(A) : null;

  return (
    <div className="mx">
      {spec.note && <div className="plot-note">{spec.note}</div>}

      {A ? (
        <>
          <div className="mx-row">
            <Grid label="A" m={A} hiRows={[ri]} hiCols={[]} sel={null} onPick={(i, j) => pick('A', i, j)} />
            {B && (
              <>
                <div className="mx-op">×</div>
                <Grid label="B" m={B} hiRows={[]} hiCols={[cj]} sel={null} onPick={(i, j) => pick('B', i, j)} />
              </>
            )}
            {product && (
              <>
                <div className="mx-op">=</div>
                <Grid
                  label="A·B"
                  m={product}
                  hiRows={[ri]}
                  hiCols={[cj]}
                  sel={[ri, cj]}
                  onPick={(i, j) => pick('C', i, j)}
                />
              </>
            )}
          </div>

          {B && !product && (
            // 维数配不上时**明说**,而不是显示一个空的位置让人猜
            <div className="mx-warn">
              A 是 {A.length}×{A[0].length},B 是 {B.length}×{B[0].length} —— 前者列数要等于后者行数才能相乘。
            </div>
          )}

          {terms && A && B && (
            <div className="mx-step">
              <span className="mx-step-head">
                {B ? `第 ${ri + 1} 行 × 第 ${cj + 1} 列` : `第 ${ri + 1} 行第 ${cj + 1} 列`}
              </span>
              <code className="mx-step-body">
                {terms.map((_, k) => `${fmt(A[ri][k])}×${fmt(B[k][cj])}`).join(' + ')}
                {' = '}
                {terms.map((t) => fmt(t)).join(' + ')}
                {' = '}
                <strong>{fmt(terms.reduce((s, t) => s + t, 0))}</strong>
              </code>
            </div>
          )}

          <div className="mx-derived">
            {dA !== null && (
              <span className={Math.abs(dA) < 1e-12 ? 'mx-fact warn' : 'mx-fact'}>
                <span className="mx-fact-name">det A</span>
                <span className="mx-fact-value">{fmt(dA)}</span>
                {Math.abs(dA) < 1e-12 && <span className="mx-fact-note">等于 0 ⇒ 不可逆</span>}
              </span>
            )}
            <span className="mx-fact">
              <span className="mx-fact-name">Aᵀ</span>
              <span className="mx-fact-value">{inline(transpose(A))}</span>
            </span>
            {isSquare(A) && (
              <span className={invA ? 'mx-fact' : 'mx-fact warn'}>
                <span className="mx-fact-name">A⁻¹</span>
                {/* 不可逆是**正常的数学情形**,而且正是要讲给学生听的那一种 ——
                    所以这里明说不存在,不编一个假的矩阵出来 */}
                <span className="mx-fact-value">{invA ? inline(invA) : '不存在'}</span>
              </span>
            )}
          </div>

          <ParamSliders
            params={spec.params ?? []}
            scope={scope}
            onChange={onParam}
            onCommit={(name, value) => emit({ type: 'paramChange', artifactId, param: name, value })}
          />
        </>
      ) : (
        <div className="mx-warn">矩阵里有的项在当前参数下无定义</div>
      )}
    </div>
  );
}

/** 一张矩阵网格。格子可点 —— 点 A 选行、点 B 选列、点乘积选那一格。 */
function Grid({
  label,
  m,
  hiRows,
  hiCols,
  sel,
  onPick,
}: {
  label: string;
  m: Matrix;
  hiRows: number[];
  hiCols: number[];
  sel: [number, number] | null;
  onPick: (i: number, j: number) => void;
}) {
  const cols = m[0]?.length ?? 1;
  return (
    <div className="mx-grid-wrap">
      <div className="mx-grid-label">{label}</div>
      <div className="mx-grid" style={{ gridTemplateColumns: `repeat(${cols}, minmax(2.6em, auto))` }}>
        {m.map((row, i) =>
          row.map((v, j) => {
            const cls = ['mx-cell'];
            if (hiRows.includes(i)) cls.push('hi-row');
            if (hiCols.includes(j)) cls.push('hi-col');
            if (sel && sel[0] === i && sel[1] === j) cls.push('sel');
            return (
              <button
                key={`${i}-${j}`}
                type="button"
                className={cls.join(' ')}
                onClick={() => onPick(i, j)}
                title={`第 ${i + 1} 行第 ${j + 1} 列`}
              >
                {fmt(v)}
              </button>
            );
          }),
        )}
      </div>
    </div>
  );
}
