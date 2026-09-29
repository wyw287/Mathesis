/**
 * plot2d —— 二维绘图。
 *
 * 这个目录装着这个 artifact 类型的全部东西:spec 校验、标题生成、渲染器、
 * 以及产出它的教学工具。框架侧只通过 ../module.ts 的接口认识它。
 */
import { useShallow } from 'zustand/react/shallow';
import { ExprError, compileExpr } from '../../lib/math';
import { clip } from '../../lib/text';
import {
  ToolInputError,
  arr,
  num,
  obj,
  oneOf,
  optArr,
  optBool,
  optNum,
  optObj,
  optStr,
  pair,
  str,
} from '../../lib/validate';
import { useSession } from '../../store/session';
import type { TeachingTool } from '../../tools/types';
import type { Annotation, Curve, LineStyle, ParamSpec, Plot2DSpec, PlotPoint } from '../../types/artifact';
import type { KindModule, RendererProps } from '../module';
import { Plot2D } from './Plot2D';

const DASHES = ['solid', 'dashed', 'dotted'] as const;

/**
 * 表达式校验:既查安全性(无赋值/多语句),也查可解析性 —— 解析不了的式子早点报出来。
 *
 * 导出是为了让别的 kind 复用同一套规则(反例工作台的条件检查项也是可求值表达式)。
 * 各写一份的话,两边迟早会对"什么算合法表达式"产生分歧。
 */
export function parseExpr(v: unknown, where: string): string {
  const s = str(v, where);
  try {
    compileExpr(s);
  } catch (e) {
    const msg = e instanceof ExprError ? e.message : String(e);
    throw new ToolInputError(`${where} 不是合法的数学表达式：${msg}`);
  }
  return s;
}

/**
 * 隐式方程的校验。
 *
 * 不能直接拿整串去 `parseExpr` —— 那个规则**刻意禁止等号**(为了挡掉 `f(x)=x^2`
 * 这类赋值式)。所以按等号切成两半,各自过一遍校验,再把原串原样存下来
 * (渲染层拿它显示,求值时用 field.ts 的 toZeroForm 化简)。
 */
export function parseImplicitEq(v: unknown, where: string): string {
  const s = str(v, where);
  const parts = s.split('=');
  if (parts.length === 1) {
    parseExpr(s, where); // 没等号:F(x,y),视作等于 0
    return s;
  }
  if (parts.length !== 2) {
    throw new ToolInputError(`${where} 里等号不止一个,方程要写成 x^2+y^2=1 这样的形式`);
  }
  parseExpr(parts[0], `${where} 等号左边`);
  parseExpr(parts[1], `${where} 等号右边`);
  return s;
}

function parseStyle(v: unknown, where: string): LineStyle | undefined {
  const o = optObj(v, where);
  if (!o) return undefined;
  const out: LineStyle = {};
  const color = optStr(o.color, `${where}.color`);
  // 只放过十六进制色值和简单色名,避免任意字符串进 SVG 属性
  if (color && /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,20})$/.test(color)) out.color = color;
  if (o.dash !== undefined) out.dash = oneOf(o.dash, DASHES, `${where}.dash`);
  const width = optNum(o.width, `${where}.width`);
  if (width !== undefined) out.width = Math.max(0.5, Math.min(8, width));
  return Object.keys(out).length ? out : undefined;
}

function parseCurve(v: unknown, where: string): Curve {
  const o = obj(v, where);
  const type = oneOf(
    o.type,
    ['explicit', 'parametric', 'sequence', 'implicit', 'vectorField'] as const,
    `${where}.type`,
  );
  switch (type) {
    case 'explicit':
      return {
        type,
        expr: parseExpr(o.expr, `${where}.expr`),
        domain: o.domain === undefined ? undefined : pair(o.domain, `${where}.domain`),
        label: optStr(o.label, `${where}.label`),
        style: parseStyle(o.style, `${where}.style`),
      };
    case 'parametric':
      return {
        type,
        x: parseExpr(o.x, `${where}.x`),
        y: parseExpr(o.y, `${where}.y`),
        t: pair(o.t, `${where}.t`),
        label: optStr(o.label, `${where}.label`),
        style: parseStyle(o.style, `${where}.style`),
      };
    case 'sequence':
      return {
        type,
        expr: parseExpr(o.expr, `${where}.expr`),
        n: pair(o.n, `${where}.n`),
        label: optStr(o.label, `${where}.label`),
        style: parseStyle(o.style, `${where}.style`),
      };
    case 'implicit':
      return {
        type,
        eq: parseImplicitEq(o.eq, `${where}.eq`),
        label: optStr(o.label, `${where}.label`),
        style: parseStyle(o.style, `${where}.style`),
      };
    case 'vectorField': {
      const density = optNum(o.density, `${where}.density`);
      return {
        type,
        fx: parseExpr(o.fx, `${where}.fx`),
        fy: parseExpr(o.fy, `${where}.fy`),
        // 夹一下:太密会糊成一片,太疏看不出场的样子
        density: density === undefined ? undefined : Math.round(Math.min(40, Math.max(4, density))),
        scale:
          o.scale === undefined
            ? undefined
            : oneOf(o.scale, ['fixed', 'magnitude'] as const, `${where}.scale`),
        label: optStr(o.label, `${where}.label`),
        style: parseStyle(o.style, `${where}.style`),
      };
    }
  }
}

function parseParam(v: unknown, where: string): ParamSpec {
  const o = obj(v, where);
  const min = num(o.min, `${where}.min`);
  const max = num(o.max, `${where}.max`);
  if (!(min < max)) throw new ToolInputError(`${where} 要求 min < max,收到 [${min}, ${max}]`);
  const value = num(o.value, `${where}.value`);
  return {
    name: str(o.name, `${where}.name`),
    value: Math.min(max, Math.max(min, value)),
    min,
    max,
    step: optNum(o.step, `${where}.step`) ?? (max - min) / 100,
    label: optStr(o.label, `${where}.label`),
  };
}

export function parsePlot2DSpec(v: unknown): Plot2DSpec {
  const o = obj(v, 'spec');
  const viewO = obj(o.view, 'spec.view');
  const view: Plot2DSpec['view'] = { x: pair(viewO.x, 'spec.view.x') };
  if (viewO.y !== undefined) view.y = pair(viewO.y, 'spec.view.y');

  const curvesRaw = arr(o.curves, 'spec.curves');
  if (!curvesRaw.length) throw new ToolInputError('spec.curves 至少要有一条曲线');

  const paramsRaw = optArr(o.params, 'spec.params') ?? [];

  return {
    kind: 'plot2d',
    view,
    curves: curvesRaw.map((c, i) => parseCurve(c, `spec.curves[${i}]`)),
    points: optArr(o.points, 'spec.points')?.map((p, i) => parsePoint(p, `spec.points[${i}]`)),
    params: paramsRaw.map((p, i) => parseParam(p, `spec.params[${i}]`)),
    annotations: optArr(o.annotations, 'spec.annotations')?.map((a, i) => parseAnnotation(a, `spec.annotations[${i}]`)),
    note: optStr(o.note, 'spec.note'),
  };
}

/** 两个表达式组成的坐标对。点的坐标要能引用参数(如 (a, f(a)) 随滑块移动)。 */
function exprPair(v: unknown, where: string): [string, string] {
  const a = arr(v, where);
  if (a.length !== 2) throw new ToolInputError(`${where} 必须是恰好两个表达式的数组 [x, y]`);
  return [parseExpr(a[0], `${where}[0]`), parseExpr(a[1], `${where}[1]`)];
}

function parsePoint(v: unknown, where: string): PlotPoint {
  const o = obj(v, where);
  return {
    name: str(o.name, `${where}.name`),
    at: exprPair(o.at, `${where}.at`),
    label: optStr(o.label, `${where}.label`),
    movable: optBool(o.movable, `${where}.movable`),
    style: parseStyle(o.style, `${where}.style`),
  };
}

function parseAnnotation(v: unknown, where: string): Annotation {
  const o = obj(v, where);
  return { at: exprPair(o.at, `${where}.at`), text: str(o.text, `${where}.text`) };
}
const STYLE = {
  type: 'object',
  description: '可省略。不填则用默认配色。',
  properties: {
    color: { type: 'string', description: '十六进制色值,如 "#2563eb"' },
    dash: { type: 'string', enum: ['solid', 'dashed', 'dotted'] },
    width: { type: 'number' },
  },
};

const RANGE = (what: string) => ({
  type: 'array',
  items: { type: 'number' },
  minItems: 2,
  maxItems: 2,
  description: `${what},格式 [起, 止],必须 起 < 止`,
});

/** 画布目录的文本形式。查找失败时附在错误里,让模型能自己纠正 id。 */
/**
 * 导出是为了让「反例工作台」复用同一份参数 schema。
 * 抄一份的话,plot2d 加字段时反例那条路会静默落后。
 */
export const plot2dTool: TeachingTool = {
  name: 'plot2d',
  description:
    '在画布上画一张二维图。这是最常用的工具 —— 任何能用图说清楚的东西都用它,不要用文字描述图像。\n' +
    '一个图里可以放多条曲线用于对比,请优先这样做,不要为每条函数各开一张图。',
  parameters: {
    type: 'object',
    properties: {
      view: {
        type: 'object',
        description: '坐标范围。y 省略时自动适配。',
        properties: {
          x: RANGE('x 轴范围'),
          y: RANGE('y 轴范围'),
        },
        required: ['x'],
      },
      curves: {
        type: 'array',
        minItems: 1,
        description: '要画的曲线,可以多条',
        items: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['explicit', 'parametric', 'sequence', 'implicit', 'vectorField'],
              description:
                'explicit = y=f(x);parametric = 参数方程 (x(t), y(t));sequence = 数列 a_n 的点列;' +
                'implicit = 隐式方程(圆、椭圆、水平集、等高线、相图边界);' +
                'vectorField = 向量场(方向场、梯度场)',
            },
            eq: {
              type: 'string',
              description:
                'implicit 用。写成方程 x^2+y^2=1,或者直接写表达式 x^2+y^2-1(视作等于 0)。' +
                '变量是 x 和 y,也可以引用 params 里的参数名 —— ' +
                '把半径做成参数 x^2+y^2-a^2,学生就能拖着看圆怎么变。',
            },
            fx: { type: 'string', description: 'vectorField 用:x 方向分量,可用 x、y 和 params' },
            fy: { type: 'string', description: 'vectorField 用:y 方向分量' },
            density: {
              type: 'number',
              description: 'vectorField 用。每个方向上画多少个箭头,默认 14。太密会糊成一片。',
            },
            scale: {
              type: 'string',
              enum: ['fixed', 'magnitude'],
              description:
                'vectorField 用。fixed(默认)= 所有箭头等长,只看方向,适合方向场;' +
                'magnitude = 箭头长度反映模长,适合看梯度的大小。',
            },
            expr: {
              type: 'string',
              description:
                'explicit / sequence 用的表达式。变量是 x(或数列的 n)。' +
                '幂用 ^(写 x^2,不要写 x**2)。' +
                '可以使用 params 里声明的参数名。只能用单个数学式子,不能有赋值或函数定义。',
            },
            x: { type: 'string', description: 'parametric: x 关于 t 的表达式' },
            y: { type: 'string', description: 'parametric: y 关于 t 的表达式' },
            t: RANGE('parametric: 参数 t 的范围'),
            n: RANGE('sequence: n 的范围'),
            domain: RANGE('explicit: x 的定义域,省略则用 view.x'),
            label: { type: 'string', description: '图例名称,如 "y = sin(1/x)"' },
            style: STYLE,
          },
          required: ['type'],
        },
      },
      params: {
        type: 'array',
        description:
          '可拖动滑块。声明后曲线表达式和点坐标里就可以引用这些参数名。' +
          '讲参数对图形的影响时一定要用它,让学生自己拖,比讲解十句都管用。',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '参数名,在表达式里引用' },
            value: { type: 'number', description: '初始值' },
            min: { type: 'number' },
            max: { type: 'number' },
            step: { type: 'number' },
            label: { type: 'string' },
          },
          required: ['name', 'value', 'min', 'max'],
        },
      },
      points: {
        type: 'array',
        description: '高亮的点。坐标是表达式,可以引用参数,例如 (a, f(a)) 这样随滑块移动的点。',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            at: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 2, description: '[x表达式, y表达式]' },
            label: { type: 'string' },
            movable: { type: 'boolean', description: '学生能否拖动这个点' },
            style: STYLE,
          },
          required: ['name', 'at'],
        },
      },
      annotations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            at: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 2 },
            text: { type: 'string' },
          },
          required: ['at', 'text'],
        },
      },
      note: { type: 'string', description: '一句话说明这张图要人注意什么,会显示在图上方' },
    },
    required: ['view', 'curves'],
  },
  run: (args) => {
    const spec = parsePlot2DSpec(args);
    return { message: `已绘制：${title(spec)}`, created: [{ spec, title: title(spec) }] };
  },
};

// ---------------------------------------------------------------- derivation
function title(spec: Plot2DSpec): string {
  const label = spec.curves.find((c) => c.label)?.label;
  if (label) return clip(label);
  if (spec.note) return clip(spec.note);
  const c = spec.curves[0];
  if (c.type === 'explicit') return clip(`y = ${c.expr}`);
  if (c.type === 'parametric') return clip(`(${c.x}, ${c.y})`);
  if (c.type === 'sequence') return clip(`aₙ = ${c.expr}`);
  if (c.type === 'implicit') return clip(c.eq);
  return clip(`向量场 (${c.fx}, ${c.fy})`);
}

/**
 * 把纯渲染器和 store 接起来。
 *
 * Plot2D 本身不碰 store —— 它只吃 scope 和 onParam。接线留在这一层,
 * 渲染器就能单独看、单独测,不用为了画一张图去理解整个 store。
 */
function Body({ spec, artifactId, rev, emit }: RendererProps<Plot2DSpec>) {
  // useShallow 是必须的:选择器每次都构造新对象,zustand v5 默认按 Object.is 比较,
  // 不加浅比较会无限重渲染。
  const scope = useSession(useShallow((s) => ({ ...defaultsOf(spec), ...s.runtime[artifactId] })));
  const setParam = useSession((s) => s.setParam);
  return (
    <Plot2D
      spec={spec}
      scope={scope}
      artifactId={artifactId}
      rev={rev}
      emit={emit}
      onParam={(name, value) => setParam(artifactId, name, value)}
    />
  );
}

/** 滑块的初始值来自 spec 里的 params。运行时值只是覆盖它,不写回 spec。 */
function defaultsOf(spec: Plot2DSpec): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of spec.params ?? []) out[p.name] = p.value;
  return out;
}

export const plot2dModule: KindModule<Plot2DSpec> = {
  kind: 'plot2d',
  parse: parsePlot2DSpec,
  title,
  Body,
  tool: plot2dTool,
};
