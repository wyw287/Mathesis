/**
 * 3D 相机、投影与曲面采样的自检。
 *
 * 这几层是选"手写而不是 three.js"的**全部理由**:投影和采样是纯数学,能写断言。
 * WebGL 在这个环境里一行都验证不了,而这两块可以。
 *
 * 所以这里测的不是"有没有输出",是**投出来的位置对不对**:
 * 目标点必须落在画布正中、相机右侧的点必须投到右边、远处的点深度必须更大、
 * 自动装框之后所有点必须落在视口内。
 *
 * 运行:npm run check:scene
 */
import {
  DEFAULT_CAMERA,
  boundsOf,
  clampPitch,
  fitCamera,
  project,
  viewBasis,
  type Camera,
  type Vec3,
} from '../src/lib/scene3d';
import { sampleHeightMap, sampleParametricSurface } from '../src/lib/surface3d';

let pass = 0;
let fail = 0;

function ok(name: string, cond: boolean, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** 沿某个方向走 k 步。**三个分量都要带上** —— 只取 x、y 会把 z 方向的分量丢掉。 */
const along = (v: Vec3, k: number): Vec3 => [v[0] * k, v[1] * k, v[2] * k];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const VIEWPORT = { w: 800, h: 500 };

async function main() {
  console.log('\n相机基向量');

  {
    let worstOrtho = 0;
    let worstNorm = 0;
    for (const yaw of [0, 1, 2, -3, Math.PI]) {
      for (const pitch of [0, 0.3, 1.2, -1.2, 1.55]) {
        const b = viewBasis({ ...DEFAULT_CAMERA, yaw, pitch });
        worstOrtho = Math.max(
          worstOrtho,
          Math.abs(dot(b.right, b.up)),
          Math.abs(dot(b.right, b.toward)),
          Math.abs(dot(b.up, b.toward)),
        );
        for (const v of [b.right, b.up, b.toward]) {
          worstNorm = Math.max(worstNorm, Math.abs(Math.hypot(...v) - 1));
        }
      }
    }
    ok('三个基向量处处两两正交', worstOrtho < 1e-12, worstOrtho.toExponential(2));
    ok('三个基向量都是单位长度', worstNorm < 1e-12, worstNorm.toExponential(2));
  }

  {
    // 俯视到极角时 right 仍然良定义 —— 这是"right 只依赖 yaw"换来的,
    // 否则正上方看下去时会出现万向锁,画面直接翻掉
    const b = viewBasis({ ...DEFAULT_CAMERA, yaw: 0.7, pitch: Math.PI / 2 });
    ok('正上方俯视时不退化', b.right.every(Number.isFinite) && Math.abs(dot(b.right, b.up)) < 1e-12);
  }

  console.log('\n投影');

  {
    const cam: Camera = { ...DEFAULT_CAMERA, target: [1, -2, 0.5], distance: 6 };
    const p = project([1, -2, 0.5], cam, VIEWPORT);
    ok('目标点投在画布正中', Math.abs(p.x - VIEWPORT.w / 2) < 1e-9 && Math.abs(p.y - VIEWPORT.h / 2) < 1e-9, `(${p.x}, ${p.y})`);
    ok('而且在相机前方', p.depth > 0);
  }

  {
    const cam: Camera = { ...DEFAULT_CAMERA, yaw: 0, pitch: 0, target: [0, 0, 0], distance: 5 };
    const b = viewBasis(cam);
    const center = project([0, 0, 0], cam, VIEWPORT);

    const rightPoint = project(along(b.right, 1), cam, VIEWPORT);
    ok('沿 right 方向的点投到右边', rightPoint.x > center.x, `${rightPoint.x} vs ${center.x}`);

    const upPoint = project(along(b.up, 1), cam, VIEWPORT);
    // 屏幕 y 向下增大,所以"上方"的点 y 更小
    ok('沿 up 方向的点投到上方', upPoint.y < center.y, `${upPoint.y} vs ${center.y}`);

    const towardPoint = project(along(b.toward, 1), cam, VIEWPORT);
    ok('靠向相机的点深度更小', towardPoint.depth < center.depth, `${towardPoint.depth} vs ${center.depth}`);
  }

  {
    // 透视投影:同样大小的横向偏移,远处的点应当偏移更小。
    // 注意"横向"要用 right 方向 —— 相机朝向随 yaw/pitch 变,写死 x/y/z 会测错轴。
    const cam: Camera = { ...DEFAULT_CAMERA, yaw: 0.4, pitch: 0.3, target: [0, 0, 0], distance: 8 };
    const b = viewBasis(cam);
    const near = project(add(along(b.right, 1), along(b.toward, 0)), cam, VIEWPORT);
    const far = project(add(along(b.right, 1), along(b.toward, -3)), cam, VIEWPORT);
    const dNear = Math.abs(near.x - VIEWPORT.w / 2);
    const dFar = Math.abs(far.x - VIEWPORT.w / 2);
    ok('透视:同样偏移在远处投得更靠中心', dFar < dNear, `近 ${dNear.toFixed(1)} 远 ${dFar.toFixed(1)}`);
  }

  {
    const cam: Camera = { ...DEFAULT_CAMERA, yaw: 0, pitch: 0, target: [0, 0, 0], distance: 5 };
    const b = viewBasis(cam);
    // "相机后面"是沿着 toward 反方向走过 distance 之外,不是某个写死的轴
    const behind = project(along(b.toward, cam.distance + 5), cam, VIEWPORT);
    ok('相机后面的点 depth <= 0(调用方据此丢弃)', behind.depth <= 0, String(behind.depth));
  }

  console.log('\n自动装框');

  {
    // 一个偏心的、非等比的长方体 —— 覆盖"包围盒中心不在原点"和"某一维特别长"两种
    const pts: Vec3[] = [];
    for (let i = 0; i <= 10; i++) {
      for (let j = 0; j <= 10; j++) {
        pts.push([-3 + i * 0.6, 5 + j * 0.1, Math.sin(i) * 2]);
      }
    }
    const bounds = boundsOf(pts);
    ok('包围盒中心算对', Math.abs(bounds.center[0]) < 1e-9 && Math.abs(bounds.center[1] - 5.5) < 1e-9, JSON.stringify(bounds.center));

    for (const [w, h] of [[800, 500], [400, 500], [900, 300]] as [number, number][]) {
      const vp = { w, h };
      const fit = fitCamera(pts, DEFAULT_CAMERA.fov, w / h);
      const cam: Camera = { ...DEFAULT_CAMERA, ...fit };
      const inside = pts.every((p) => {
        const q = project(p, cam, vp);
        return q.depth > 0 && q.x >= 0 && q.x <= w && q.y >= 0 && q.y <= h;
      });
      ok(`装框后所有点都在视口内 (${w}×${h})`, inside);
    }
  }

  {
    ok('pitch 被夹在 ±89°', Math.abs(clampPitch(Math.PI / 2)) < Math.PI / 2 && Math.abs(clampPitch(-9)) < Math.PI / 2);
  }

  console.log('\n曲面采样');

  {
    const mesh = sampleHeightMap((x, y) => x * y, [-2, 2], [-2, 2], 20);
    ok('高度图铺出完整网格', mesh.quads.length === 20 * 20, `${mesh.quads.length} 个四边形`);
    ok('顶点数对', mesh.verts.length === 21 * 21, String(mesh.verts.length));
    ok('z 范围算对', Math.abs(mesh.zRange[0] + 4) < 1e-9 && Math.abs(mesh.zRange[1] - 4) < 1e-9, JSON.stringify(mesh.zRange));
    ok('所有顶点都在曲面上', mesh.verts.every((v) => Math.abs(v[2] - v[0] * v[1]) < 1e-12));
  }

  {
    // 一块无定义的区域:相关格子必须整块丢掉,而不是硬凑出曲面
    const mesh = sampleHeightMap((x, y) => (x * x + y * y < 1 ? NaN : 0), [-2, 2], [-2, 2], 20);
    const full = 20 * 20;
    ok('无定义的区域被挖掉', mesh.quads.length < full && mesh.quads.length > 0, `${mesh.quads.length}/${full}`);
    ok('剩下的顶点都有效', mesh.verts.every((v) => v.every(Number.isFinite)));
    ok('所有索引都指向存在的顶点', mesh.quads.every((q) => q.every((i) => i >= 0 && i < mesh.verts.length)));
  }

  {
    // 1/(xy) 在网格上会取到极大值。不做分位截断的话,min/max 被那个尖峰拉走,
    // 整张曲面会被压成一块平板。
    const mesh = sampleHeightMap((x, y) => 1 / (x * y), [0.05, 2], [0.05, 2], 30);
    const zmax = Math.max(...mesh.verts.map((v) => v[2]));
    const zmin = Math.min(...mesh.verts.map((v) => v[2]));
    ok('尖峰被截断,没有把范围拉到无穷', Number.isFinite(zmax) && Number.isFinite(zmin), `[${zmin}, ${zmax}]`);
    ok('截断后高度仍然有区分度', zmax - zmin > 1, `跨度 ${(zmax - zmin).toFixed(2)}`);
  }

  {
    // 球面:所有顶点必须落在球面上。这条能抓出 u/v 参数化写反之类的错误。
    const R = 2;
    const mesh = sampleParametricSurface(
      (u, v) => [R * Math.cos(u) * Math.sin(v), R * Math.sin(u) * Math.sin(v), R * Math.cos(v)],
      [0, 2 * Math.PI],
      [0, Math.PI],
      24,
    );
    const worst = Math.max(...mesh.verts.map((v) => Math.abs(Math.hypot(...v) - R)));
    ok('参数曲面的顶点都落在球面上', worst < 1e-12, worst.toExponential(2));
    ok('球面铺出完整网格', mesh.quads.length === 24 * 24, `${mesh.quads.length} 个`);
  }

  {
    const mesh = sampleHeightMap(() => NaN, [-1, 1], [-1, 1], 10);
    ok('整片无定义时不产出任何面', mesh.quads.length === 0 && mesh.verts.length === 0);
    ok('z 范围退化成有限值而不是 [Infinity, -Infinity]', mesh.zRange.every(Number.isFinite), JSON.stringify(mesh.zRange));
  }

  console.log(`\n${pass} 通过, ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
}

void main();
