/**
 * plot3d —— 三维曲面。
 *
 * 只做**高度图**和**参数曲面**两种。它们和 2D 的网格采样是同一件事再加一维,
 * 所以模型的表达难度和 plot2d 一样(还是 mathjs 表达式)。
 *
 * 隐式曲面(F(x,y,z)=0)需要 marching cubes,是独立课题,刻意不做 ——
 * 与其做一个会撕出洞的版本,不如不做,并在工具描述里说清楚。
 */
import { clip } from '../../lib/text';
import { obj, oneOf, optArr, optBool, optNum, optObj, optStr, pair } from '../../lib/validate';
import type { TeachingTool } from '../../tools/types';
import type { Plot3DSpec, Surface3D } from '../../types/artifact';
import type { KindModule, RendererProps } from '../module';
import { useShallow } from 'zustand/react/shallow';
import { useSession } from '../../store/session';
import { parseExpr, parseParam } from '../plot2d';
import { Plot3D } from './Plot3D';

function parseSurface(v: unknown): Surface3D {
  const o = obj(v, 'spec.surface');
  const type = oneOf(o.type, ['height', 'parametric'] as const, 'spec.surface.type');
  const over = obj(o.over, 'spec.surface.over');
  const label = optStr(o.label, 'spec.surface.label');

  if (type === 'height') {
    return {
      type,
      expr: parseExpr(o.expr, 'spec.surface.expr'),
      over: {
        x: pair(over.x, 'spec.surface.over.x'),
        y: pair(over.y, 'spec.surface.over.y'),
      },
      label,
    };
  }
  return {
    type,
    x: parseExpr(o.x, 'spec.surface.x'),
    y: parseExpr(o.y, 'spec.surface.y'),
    z: parseExpr(o.z, 'spec.surface.z'),
    over: {
      u: pair(over.u, 'spec.surface.over.u'),
      v: pair(over.v, 'spec.surface.over.v'),
    },
    label,
  };
}

export function parsePlot3DSpec(v: unknown): Plot3DSpec {
  const o = obj(v, 'spec');
  const surface = parseSurface(o.surface);

  const viewRaw = optObj(o.view, 'spec.view');
  let view: Plot3DSpec['view'];
  if (viewRaw) {
    view = {
      yaw: optNum(viewRaw.yaw, 'spec.view.yaw'),
      pitch: optNum(viewRaw.pitch, 'spec.view.pitch'),
    };
  }

  const resolution = optNum(o.resolution, 'spec.resolution');

  return {
    kind: 'plot3d',
    surface,
    view,
    // 夹一下:太小看不清形状,太大拖拽时会卡(每帧要投影并在 CPU 上排序所有面片)
    params: optArr(o.params, 'spec.params')?.map((p, i) => parseParam(p, `spec.params[${i}]`)),
    resolution: resolution === undefined ? undefined : Math.round(Math.min(90, Math.max(8, resolution))),
    wireframe: optBool(o.wireframe, 'spec.wireframe'),
    note: optStr(o.note, 'spec.note'),
  };
}

function title(spec: Plot3DSpec): string {
  const s = spec.surface;
  if (s.label) return clip(s.label);
  if (s.type === 'height') return clip(`z = ${s.expr}`);
  return clip(`曲面 (${s.x}, ${s.y}, ${s.z})`);
}

export const plot3dTool: TeachingTool = {
  name: 'plot3d',
  description:
    '画三维曲面,学生可以拖着转。\n' +
    '\n' +
    '什么时候用:多元函数(z = x²−y²、鞍面、抛物面)、旋转体、球面环面这类。\n' +
    '**需要"转着看才明白"的图形一定要用它** —— 马鞍面在平面图上看不出来是马鞍。\n' +
    '\n' +
    '两种写法,用 over 指定参数范围:\n' +
    '\n' +
    '1. 高度图 z = f(x, y):{ type:"height", expr:"x^2 - y^2", over:{ x:[-2,2], y:[-2,2] } }\n' +
    '\n' +
    '2. 参数曲面 (u,v) → (x,y,z):\n' +
    '   球面: { type:"parametric", x:"R*cos(u)*sin(v)", y:"R*sin(u)*sin(v)", z:"R*cos(v)",\n' +
    '           over:{ u:[0, 6.2832], v:[0, 3.1416] } }\n' +
    '   环面、旋转体也走这一种。变量是 u 和 v,可以引用 params 里的参数。\n' +
    '\n' +
    '**这个工具只画函数图像和参数曲面。** 隐式曲面(如 sin(x)+sin(y)+sin(z)=0 这类\n' +
    '无法解出 z 的)和三维向量场都不支持 —— 不要用别的参数硬凑,那只会画出形状错误的图,\n' +
    '而学生没法察觉一个三维形状是错的。碰到这类需求,用文字讲清楚,或者退回到 2D 的截面。',
  parameters: {
    type: 'object',
    properties: {
      surface: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['height', 'parametric'] },
          expr: { type: 'string', description: 'height:z 关于 x、y 的表达式' },
          x: { type: 'string', description: 'parametric:x 关于 u、v 的表达式' },
          y: { type: 'string', description: 'parametric:y 关于 u、v 的表达式' },
          z: { type: 'string', description: 'parametric:z 关于 u、v 的表达式' },
          over: {
            type: 'object',
            description: '参数范围。height 用 x/y,parametric 用 u/v。',
            properties: {
              x: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
              y: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
              u: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
              v: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
            },
          },
          label: { type: 'string', description: '给这个曲面起个名字,用作卡片标题' },
        },
        required: ['type', 'over'],
      },
      view: {
        type: 'object',
        description: '相机初始朝向,单位是度。省略则用一个能看到三条轴的斜视角。',
        properties: {
          yaw: { type: 'number', description: '绕 z 轴转' },
          pitch: { type: 'number', description: '抬升角,0 = 平视,90 = 正上方俯视' },
        },
      },
      resolution: {
        type: 'number',
        description: '网格密度,默认 44。曲面有细节(比如高频振荡)时才需要调高,调高会变卡。',
      },
      wireframe: { type: 'boolean', description: '画网格线,默认开' },
      note: { type: 'string', description: '一句话说明这张图要人注意什么' },
    },
    required: ['surface'],
  },
  run: (args) => {
    const spec = parsePlot3DSpec(args);
    return { message: `已绘制曲面：${title(spec)}`, created: [{ spec, title: title(spec) }] };
  },
};

/** 默认参数值 + 运行时覆盖 —— 和 plot2d 同一套规则。 */
function defaultsOf(spec: Plot3DSpec): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of spec.params ?? []) out[p.name] = p.value;
  return out;
}

function Body({ spec, artifactId, rev, emit }: RendererProps<Plot3DSpec>) {
  const scope = useSession(
    useShallow((s) => ({ ...defaultsOf(spec), ...s.runtime[artifactId] })),
  );
  const setParam = useSession((s) => s.setParam);
  return (
    <Plot3D
      spec={spec}
      scope={scope}
      artifactId={artifactId}
      rev={rev}
      emit={emit}
      onParam={(name, value) => setParam(artifactId, name, value)}
    />
  );
}

export const plot3dModule: KindModule<Plot3DSpec> = {
  kind: 'plot3d',
  parse: parsePlot3DSpec,
  title,
  Body,
  tool: plot3dTool,
};
