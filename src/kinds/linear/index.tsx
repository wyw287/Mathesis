/**
 * linear —— 2×2 线性变换的几何视图。
 *
 * 线代里最难用文字讲清的部分是「矩阵到底对空间做了什么」。**让模型只写矩阵,
 * 其余全由渲染器算** —— 变换后的网格、单位正方形的像、行列式、特征方向,
 * 这些让模型自己算的话全是它容易写错的地方,而且学生看不出来。
 *
 * 矩阵的四个元素是表达式而不是数字,于是每个都能挂滑块。拖一下就看见平面
 * 被扭成什么样 —— 那是这个 kind 几乎全部的价值。
 */
import { useShallow } from 'zustand/react/shallow';
import { clip } from '../../lib/text';
import { ToolInputError, obj, optArr, optStr, pair } from '../../lib/validate';
import type { TeachingTool } from '../../tools/types';
import { useSession } from '../../store/session';
import type { LinearSpec } from '../../types/artifact';
import type { KindModule, RendererProps } from '../module';
import { parseExpr, parseParam } from '../plot2d';
import { LinearView } from './LinearView';

function parseMatrix(v: unknown): [[string, string], [string, string]] {
  // 必须是 ToolInputError:只有它会被当成"模型写错了"回给模型让它自己改,
  // 裸 Error 会被当成系统故障,模型得不到修正的机会
  if (!Array.isArray(v) || v.length !== 2) {
    throw new ToolInputError('spec.matrix 必须是两行,例如 [["a","b"],["c","d"]]');
  }
  const row0 = v[0];
  const row1 = v[1];
  if (!Array.isArray(row0) || !Array.isArray(row1) || row0.length !== 2 || row1.length !== 2) {
    throw new ToolInputError('spec.matrix 的每一行必须恰好两个元素,例如 [["a","b"],["c","d"]]');
  }
  return [
    [parseExpr(row0[0], 'spec.matrix[0][0]'), parseExpr(row0[1], 'spec.matrix[0][1]')],
    [parseExpr(row1[0], 'spec.matrix[1][0]'), parseExpr(row1[1], 'spec.matrix[1][1]')],
  ];
}

export function parseLinearSpec(v: unknown): LinearSpec {
  const o = obj(v, 'spec');
  const viewRaw = o.view === undefined || o.view === null ? undefined : obj(o.view, 'spec.view');
  const probeRaw = o.probe === undefined || o.probe === null ? undefined : obj(o.probe, 'spec.probe');

  return {
    kind: 'linear',
    matrix: parseMatrix(o.matrix),
    params: optArr(o.params, 'spec.params')?.map((p, i) => parseParam(p, `spec.params[${i}]`)),
    view: viewRaw
      ? { x: pair(viewRaw.x, 'spec.view.x'), y: pair(viewRaw.y, 'spec.view.y') }
      : undefined,
    probe: probeRaw
      ? {
          x: parseExpr(probeRaw.x, 'spec.probe.x'),
          y: parseExpr(probeRaw.y, 'spec.probe.y'),
          label: optStr(probeRaw.label, 'spec.probe.label'),
        }
      : undefined,
    note: optStr(o.note, 'spec.note'),
  };
}

function title(spec: LinearSpec): string {
  const [[a, b], [c, d]] = spec.matrix;
  return clip(`矩阵 [${a} ${b}; ${c} ${d}]`);
}

export const linearTool: TeachingTool = {
  name: 'linear',
  description:
    '画一个 2×2 矩阵**对平面做了什么**:网格被扭成什么样、单位正方形的像、' +
    '行列式(面积的缩放倍数)、特征方向。学生可以拖滑块实时改矩阵。\n' +
    '\n' +
    '什么时候用:线性变换的几何、行列式、特征值与特征向量、秩与可逆性、' +
    '基变换、PCA / SVD 里"旋转—缩放—旋转"的直觉。**这些用文字讲十句不如拖一下。**\n' +
    '\n' +
    '**你只需要写矩阵。** 变换后的网格、面积、特征值全由系统计算 —— ' +
    '不要自己算好再画,那既是浪费也容易出错。\n' +
    '\n' +
    '矩阵写成两行的嵌套数组: matrix: [["a","b"],["c","d"]] 表示 [a b; c d]。' +
    '四个元素都是**表达式**,可以引用 params 里的参数名 —— ' +
    '把矩阵元素做成参数,学生拖滑块就能看见平面被连续地扭动。\n' +
    '\n' +
    '系统会显示:\n' +
    '· 原网格和变换后的网格重叠对照\n' +
    '· 单位正方形(虚线)和它的像(实心),后者面积 = |det|\n' +
    '· 特征方向(方向不变的直线)。**判别式小于零时它不会画线** —— ' +
    '那说明这个变换含旋转,平面上没有任何方向不变,这时界面会明说。\n' +
    '· det = 0 时会指出"整个平面被压到一条线上,不可逆"\n' +
    '\n' +
    '可选的 probe 是给学生拖的一个探测向量:它会同时显示 v 和 Av。',
  parameters: {
    type: 'object',
    properties: {
      matrix: {
        type: 'array',
        description: '2×2 矩阵,按行。例如 [["cos(t)","-sin(t)"],["sin(t)","cos(t)"]] 是旋转矩阵。',
        items: {
          type: 'array',
          items: { type: 'string' },
          minItems: 2,
          maxItems: 2,
        },
        minItems: 2,
        maxItems: 2,
      },
      params: {
        type: 'array',
        description:
          '可拖动参数。矩阵元素和 probe 都能引用这些名字 —— ' +
          '这是这个工具最有价值的地方:让矩阵动起来,而不是给一个死数。',
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
      view: {
        type: 'object',
        description:
          '显示范围,默认按矩阵自动撑开(所以缩放大时也看得见)。一般不用填。',
        properties: {
          x: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
          y: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
        },
      },
      probe: {
        type: 'object',
        description:
          '可选。一个探测向量,同时画出它和它的像 Av。坐标是表达式,可引用 params —— ' +
          '配合滑块用效果最好("看这个向量被转到哪里去了")。',
        properties: {
          x: { type: 'string' },
          y: { type: 'string' },
          label: { type: 'string' },
        },
        required: ['x', 'y'],
      },
      note: { type: 'string', description: '一句话说明这张图要人注意什么' },
    },
    required: ['matrix'],
  },
  run: (args) => {
    const spec = parseLinearSpec(args);
    return { message: `已展示线性变换：${title(spec)}`, created: [{ spec, title: title(spec) }] };
  },
};

function defaultsOf(spec: LinearSpec): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of spec.params ?? []) out[p.name] = p.value;
  return out;
}

function Body({ spec, artifactId, rev, emit }: RendererProps<LinearSpec>) {
  const scope = useSession(
    useShallow((s) => ({ ...defaultsOf(spec), ...s.runtime[artifactId] })),
  );
  const setParam = useSession((s) => s.setParam);
  return (
    <LinearView
      spec={spec}
      scope={scope}
      artifactId={artifactId}
      rev={rev}
      emit={emit}
      onParam={(name, value) => setParam(artifactId, name, value)}
    />
  );
}

export const linearModule: KindModule<LinearSpec> = {
  kind: 'linear',
  parse: parseLinearSpec,
  title,
  Body,
  tool: linearTool,
};
