/**
 * 图片库。
 *
 * ## 为什么要单独一个 object store
 *
 * zustand 的持久化存档每 400ms 就把**整个 state** `JSON.stringify` 一遍再整体重写
 * (见 idb-storage.ts 里那段说明)。图片是 data URL 字符串,动辄几十万字符 ——
 * 塞进存档之后,每一次拖滑块、每一个流式分片都要重刷全部历史图片。分开存之后
 * 存档里只留下几百字节的元数据,两边各自独立。
 *
 * ## 为什么存 data URL 字符串而不是 Blob
 *
 * 两个消费者要的都是字符串:发给模型的 API 载荷、界面上的 `<img src>`。存字符串
 * 意味着一份缓存服务两边,而且不用碰 `FileReader` / `createObjectURL` / revoke
 * 那一整套生命周期。代价是磁盘上多 33% —— 压过之后再接受。
 *
 * 还有一条不显眼但重要的:**它仍然能在 node 里跑通真实路径**。这个项目每一层都有
 * 自检脚本,而 `FileReader` 在 node 里不存在 —— 用 Blob 存这一层就会变成不可测。
 *
 * ## 失败的处理是不对称的,这是刻意的
 *
 * `putImage` **抛** ——它是用户刚做的动作(贴了一张图),存不下必须当场说,
 * 和 `idb-storage` 的 flush「绝不向上抛」正相反,那个是后台写入。
 * 其余几个只记日志:它们跑在渲染路径和回收路径上,抛出去没人接。
 */
import { BLOB_STORE, idbBackend, idbKeys, memoryBackend, onConnectionDropped, openDb, type Backend } from './idb';

/** 缓存条数上限。超出只丢缓存,`getDataUrl` 会回 IDB 再读一次。 */
const CACHE_MAX = 24;

const cache = new Map<string, string>();

function cacheGet(id: string): string | undefined {
  const hit = cache.get(id);
  if (hit === undefined) return undefined;
  // 取用即挪到末尾 —— Map 的插入顺序就是 LRU 的顺序
  cache.delete(id);
  cache.set(id, hit);
  return hit;
}

function cachePut(id: string, dataUrl: string): void {
  cache.delete(id);
  cache.set(id, dataUrl);
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

let ready: Promise<Backend> | null = null;

// 和 idb-storage 同理:连接被别的标签页的版本升级关掉时,这个 backend 会失效。
// 下一次取用时重新解析。图片这一侧失败是会抛的(见上面那段),但一直指着一个
// 已关闭的库同样糟糕 —— 会变成"每次贴图都报一个看不懂的错"。
onConnectionDropped(() => {
  ready = null;
});

async function resolveBackend(): Promise<Backend> {
  if (typeof indexedDB !== 'undefined') {
    try {
      return idbBackend(await openDb(), BLOB_STORE);
    } catch (e) {
      console.warn('[mathesis] 图片库打不开,这次会话的图片只会留在内存里', e);
    }
  }
  // 退到内存:图片只在当前标签页活着。顶栏那条「存储不可用」的提示已经覆盖了
  // 这个状态的沟通,不用再新做一套 UI。
  return memoryBackend();
}

function backend(): Promise<Backend> {
  if (!ready) ready = resolveBackend();
  return ready;
}

/** 存一张图。**失败会抛** —— 调用方要把它变成用户看得见的提示。 */
export async function putImage(id: string, dataUrl: string): Promise<void> {
  // 先落盘再进缓存:缓存里只该有确实存住了的东西
  await (await backend()).set(id, dataUrl);
  cachePut(id, dataUrl);
}

/** 读一张图。读不到(没存过、被回收了、后端坏了)一律返回 null,不抛。 */
export async function getDataUrl(id: string): Promise<string | null> {
  const hit = cacheGet(id);
  if (hit !== undefined) return hit;
  try {
    const v = await (await backend()).get(id);
    if (v) cachePut(id, v);
    return v;
  } catch (e) {
    console.warn('[mathesis] 读图片失败', e);
    return null;
  }
}

export async function deleteImages(ids: string[]): Promise<void> {
  if (!ids.length) return;
  for (const id of ids) cache.delete(id);
  try {
    const b = await backend();
    for (const id of ids) await b.remove(id);
  } catch (e) {
    console.warn('[mathesis] 删图片失败', e);
  }
}

/** 库里所有图片 id。IndexedDB 用不了时返回空 —— 那也没有需要回收的东西。 */
export async function listImageIds(): Promise<string[]> {
  try {
    return await idbKeys(await openDb(), BLOB_STORE);
  } catch {
    return [];
  }
}

/**
 * 只留下 `keep` 里的,其余删掉,返回被删的 id。
 *
 * 这是"载入时兜底"用的全量扫描。会话内的删除走的是**精确删除**
 * (谁丢弃消息就删谁引用的图片),不走这里 —— 扫描会把输入框里
 * 还没发送的草稿当成孤儿删掉。
 */
export async function sweepImages(keep: Set<string>): Promise<string[]> {
  const orphans = (await listImageIds()).filter((id) => !keep.has(id));
  if (orphans.length) await deleteImages(orphans);
  return orphans;
}

/**
 * 丢掉后端和缓存。
 *
 * 和 `lib/idb.ts` 的 `closeDb()` 是同一件事的两半:那里放掉连接,这里放掉
 * 抓着那条连接的 backend 和缓存。测试每个用例都要装一个全新的假 IndexedDB,
 * 不重置的话第二个用例会静默复用第一个的。
 */
export function resetImageStore(): void {
  ready = null;
  cache.clear();
}
