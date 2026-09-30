/**
 * matrix —— 矩阵作为**代数对象**。
 *
 * 和 `linear` 分工明确,不是重复:
 *   · `linear` 是"矩阵对空间做了什么"(2×2 的几何:网格怎么扭、面积怎么变)
 *   · `matrix` 是"矩阵本身是什么"(任意尺寸的行列、乘法、转置、逆)
 *
 * 它补上的另一件事:在此之前矩阵只能作为 `linear` 面板里的一小块、或者
 * `derivation` 里的一串 LaTeX 出现 —— **不是一个可以被引用的对象**。
 * 现在模型可以说"看 @a3 的第 2 行",学生也能点。
 *
 * 和 `linear` 一样,**模型只写元素,其余全由代码算**:乘积、转置、逆、det
 * 都在 `lib/matrixn.ts` 里,那边能在 node 里逐条验 —— 逆矩阵算错了从画面上
 * 是看不出来的,它长得就是个矩阵。
 */
import { useShallow } from 'zustand/react/shallow';
import { MAX_DIM } from '../../lib/matrixn';
import { clip } from '../../lib/text';
import { ToolInputError, arr, obj, optArr, optStr } from '../../lib/validate';
import { useSession } from '../../store/session';
import type { TeachingTool } from '../../tools/types';
import type { MatrixSpec } from '../../types/artifact';
import type { KindModule, RendererProps } from '../module';
import { parseExpr, parseParam } from '../plot2d';
import { MatrixView } from './MatrixView';

/** 一叠表达式,按行。空矩阵、行列不齐、太大 —— 都在这里拦掉。 */
function parseRows(v: unknown, where: string): string[][] {
  const raw = arr(v, where);
  if (!raw.length) throw new ToolInputError(`${where} 不能是空矩阵`);

  const rows = raw.map((r, i) =>
    arr(r, `${where}[${i}]`).map((c, j) => parseExpr(c, `${where}[${i}][${j}]`)),
  );
  const width = rows[0].length;
  if (!width) throw new ToolInputError(`${where} 的每一行不能是空的`);

  const uneven = rows.findIndex((r) => r.length !== width);
  if (uneven >= 0) {
    throw new ToolInputError(
      `${where} 每行的列数必须一样:第 1 行有 ${width} 个,第 ${uneven + 1} 行有 ${rows[uneven].length} 个`,
    );
  }
  if (rows.length > MAX_DIM || width > MAX_DIM) {
    throw new ToolInputError(
      `${where} 最大 ${MAX_DIM}×${MAX_DIM},现在是 ${rows.length}×${width} —— 画布上放不下更大的`,
    );
  }
  return rows;
}

export function parseMatrixSpec(v: unknown): MatrixSpec {
  const o = obj(v, 'spec');

  let focus: [number, number] | undefined;
  if (o.focus !== undefined && o.focus !== null) {
    const parts = arr(o.focus, 'spec.focus');
    if (parts.length !== 2) throw new ToolInputError('spec.focus 要写成 [行, 列]');
    const pair = parts.map((x, i) => {
      if (typeof x !== 'number' || !Number.isFinite(x)) {
        throw new ToolInputError(`spec.focus[${i}] 必须是数字`);
      }
      return Math.max(0, Math.floor(x));
    });
    focus = [pair[0], pair[1]];
  }

  return {
    kind: 'matrix',
    rows: parseRows(o.rows, 'spec.rows'),
    params: optArr(o.params, 'spec.params')?.map((p, i) => parseParam(p, `spec.params[${i}]`)),
    multiplyBy:
      o.multiplyBy === undefined || o.multiplyBy === null
        ? undefined
        : parseRows(o.multiplyBy, 'spec.multiplyBy'),
    focus,
    note: optStr(o.note, 'spec.note'),
  };
}

/**
 * 标题是尺寸,不是元素。
 *
 * 矩阵的元素列出来又长又认不出是哪张;而"3×2 乘 2×2"这种尺寸一眼就能对上
 * 学生在算的是哪一步。想要更好的名字,用 spec.label。
 */
function title(spec: MatrixSpec): string {
  const dims = `${spec.rows.length}×${spec.rows[0].length}`;
  if (!spec.multiplyBy) return clip(`${dims} 矩阵`);
  return clip(`${dims} 乘 ${spec.multiplyBy.length}×${spec.multiplyBy[0].length}`);
}

const tool: TeachingTool = {
  name: 'matrix',
  description:
    '把一个矩阵作为**对象**放到画布上:它的行与列、两个矩阵相乘的过程、转置与逆。\n' +
    '\n' +
    '**和 linear 的分工**(选错了学生会看不到想讲的东西):\n' +
    '· 讲"矩阵对空间做了什么"—— 网格被扭成什么样、面积、特征方向 → 用 **linear**(它只吃 2×2)\n' +
    '· 讲矩阵**本身**的操作:尺寸不是 2×2、要做乘法、要看行与列 → 用这里\n' +
    '\n' +
    '**元素是表达式**,可以引用 params 里的参数名 —— 于是每个元素都能挂滑块。\n' +
    '学生的操作是**点格子**:点 A 的格子选中那一**行**,点 B 的格子选中那一**列**,' +
    '点结果矩阵的格子选中那一格。选中了什么会作为一条操作告诉你。\n' +
    '\n' +
    '给了 multiplyBy 就会画出 A·B,并**逐步列出**那一格的算法:' +
    '`3×5 + 4×7 = 15 + 28 = 43` —— "行乘列"是从文字上最难建立直觉的一步,\n' +
    '把它展开成这一串是这张卡最主要的价值。维数配不上时会明说,不会显示一个空位。\n' +
    '\n' +
    '系统还会算(都是**代码算的,不要你自己算了写进来**):\n' +
    '· det A(方阵才显示,等于 0 时指出"不可逆")\n' +
    '· Aᵀ\n' +
    '· A⁻¹(方阵且可逆才有;不可逆时明说"不存在"—— 那也是要讲的情形之一)\n' +
    '\n' +
    '尺寸上限 6×6。',
  parameters: {
    type: 'object',
    properties: {
      rows: {
        type: 'array',
        description: '主矩阵,按行。例如 [["1","2"],["3","4"]] 表示 [1 2; 3 4]。元素是表达式。',
        items: { type: 'array', items: { type: 'string' } },
      },
      multiplyBy: {
        type: 'array',
        description:
          '可选。再给一个矩阵,系统会画出 A·B 并逐步演示第 i 行 × 第 j 列的算法。' +
          '维数要配得上(A 的列数 = 这个矩阵的行数),否则卡片上会明说不能相乘。',
        items: { type: 'array', items: { type: 'string' } },
      },
      params: {
        type: 'array',
        description:
          '可拖动参数。矩阵元素可以引用这些名字 —— 让某一个元素动起来,' +
          '看乘积/行列式/逆怎么跟着变。',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            value: { type: 'number' },
            min: { type: 'number' },
            max: { type: 'number' },
            step: { type: 'number' },
            label: { type: 'string' },
          },
          required: ['name', 'value', 'min', 'max'],
        },
      },
      focus: {
        type: 'array',
        description: '开场聚焦哪一格 [行, 列],从 0 开始数。默认 [0,0]。',
        items: { type: 'number' },
      },
      note: { type: 'string', description: '一句话说明这张卡要人注意什么,显示在卡片上方' },
    },
    required: ['rows'],
  },
  run: (args) => {
    const spec = parseMatrixSpec(args);
    return { message: `已展示矩阵：${title(spec)}`, created: [{ spec, title: title(spec) }] };
  },
};

function defaultsOf(spec: MatrixSpec): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of spec.params ?? []) out[p.name] = p.value;
  return out;
}

function Body({ spec, artifactId, rev, emit }: RendererProps<MatrixSpec>) {
  const scope = useSession(useShallow((s) => ({ ...defaultsOf(spec), ...s.runtime[artifactId] })));
  const setParam = useSession((s) => s.setParam);
  return (
    <MatrixView
      spec={spec}
      scope={scope}
      artifactId={artifactId}
      rev={rev}
      emit={emit}
      onParam={(name, value) => setParam(artifactId, name, value)}
    />
  );
}

export const matrixModule: KindModule<MatrixSpec> = {
  kind: 'matrix',
  parse: parseMatrixSpec,
  title,
  Body,
  tool,
};
