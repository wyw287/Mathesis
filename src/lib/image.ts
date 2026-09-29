/**
 * 粘贴进来的图片,存之前先压。
 *
 * ## 为什么要压
 *
 * 视觉模型按 patch 计费,一张 1568² 的图大约 3k token;不压的话一张 4K 截图
 * 是 20k+,上传和推理也都更慢。长边压到 1568 大致是各家视觉模型内部会缩到的
 * 那一档,再往上给只是白花带宽和钱。
 *
 * ## 为什么先试 PNG
 *
 * 数学截图是高对比度线稿:细笔画、上下标、积分号。JPEG 在强边缘附近的振铃
 * 恰好损害这些地方 —— 而那正是模型要认的东西。所以先试无损的 PNG,
 * 只有它实在太大时才退到 JPEG。
 *
 * 这一层只在浏览器里跑得起来(canvas),所以它**不进自检链**;唯一能纯函数化的
 * 几何部分(`fitWithin`)抽出来了,那里有覆盖。
 */

export const MAX_LONG_SIDE = 1568;
/** PNG 超过这个字节数就换 JPEG。 */
const PNG_BUDGET = 900 * 1024;
/** 换过 JPEG 还超过这个数,就再压小一档重来。 */
const HARD_BUDGET = 2 * 1024 * 1024;
const FALLBACK_LONG_SIDE = 1024;
/** 输入上限。再大就不像是"一道题的截图"了。 */
export const MAX_INPUT_BYTES = 20 * 1024 * 1024;
/** 一条消息最多几张。 */
export const MAX_IMAGES = 4;

const OK_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export interface PreparedImage {
  id: string;
  dataUrl: string;
  w: number;
  h: number;
  mime: string;
  bytes: number;
}

/**
 * 按长边等比缩到 max 以内。
 *
 * **只缩不放。** 放大一个本来就比 max 小的图,只是凭空多出插值出来的像素 ——
 * 既不会让模型看得更清,又照样按像素收钱。
 */
export function fitWithin(w: number, h: number, max: number): { w: number; h: number } {
  const long = Math.max(w, h);
  if (long === 0 || long <= max) return { w, h };
  const k = max / long;
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

export function newImageId(): string {
  const rnd =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `img-${rnd}`;
}

/**
 * Blob → data URL。
 *
 * 刻意**不用 `FileReader`**:那是浏览器专有的,用了它这一层就完全没法在 node 里
 * 走一遍。`arrayBuffer()` + base64 两边都能跑。
 *
 * 分块不是优化,是必须的:`String.fromCharCode(...bytes)` 在一张几 MB 的图上
 * 会把调用栈直接撑爆。
 */
export async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(bin)}`;
}

function makeCanvas(w: number, h: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function toBlob(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  mime: string,
  quality: number,
): Promise<Blob> {
  if (typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas) {
    return canvas.convertToBlob({ type: mime, quality });
  }
  const c = canvas as HTMLCanvasElement;
  return new Promise((resolve, reject) =>
    c.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('画布导出失败'))),
      mime,
      quality,
    ),
  );
}

async function encode(
  bmp: ImageBitmap,
  side: number,
  mime: string,
  quality: number,
): Promise<Omit<PreparedImage, 'id'>> {
  const { w, h } = fitWithin(bmp.width, bmp.height, side);
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext('2d') as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!ctx) throw new Error('拿不到 2D 画布上下文');
  ctx.drawImage(bmp, 0, 0, w, h);
  const blob = await toBlob(canvas, mime, quality);
  return {
    dataUrl: await blobToDataUrl(blob),
    w,
    h,
    mime: blob.type || mime,
    bytes: blob.size,
  };
}

/**
 * 解码 → 缩放 → 编码,产出可以直接 `putImage` 的东西。
 *
 * 失败一律抛,带上能读懂的原因:调用方要把这句话显示给学生,
 * 而不是让一张图静默消失。
 */
export async function prepareImage(file: Blob): Promise<PreparedImage> {
  if (!OK_MIME.has(file.type)) {
    throw new Error(`不支持的图片格式:${file.type || '未知'}`);
  }
  if (file.size > MAX_INPUT_BYTES) {
    throw new Error(`图片太大(${Math.round(file.size / 1024 / 1024)}MB),上限 20MB`);
  }

  const bmp = await createImageBitmap(file);
  try {
    // 本来就是照片(JPEG)的,不必强行转成 PNG —— 那只会更大,而它本来也没有
    // "线稿边缘"要保护。
    const first = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    let out = await encode(bmp, MAX_LONG_SIDE, first, 0.85);

    if (out.mime !== 'image/jpeg' && out.bytes > PNG_BUDGET) {
      out = await encode(bmp, MAX_LONG_SIDE, 'image/jpeg', 0.85);
    }
    if (out.bytes > HARD_BUDGET) {
      out = await encode(bmp, FALLBACK_LONG_SIDE, 'image/jpeg', 0.85);
    }
    return { id: newImageId(), ...out };
  } finally {
    bmp.close();
  }
}
