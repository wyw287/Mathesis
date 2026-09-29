/**
 * zustand persist 的存储后端:IndexedDB,带写入合并,不可用时降级到内存。
 *
 * 这个文件解决两个不显眼但会致命的问题。
 *
 * **一、序列化 + 写放大。** zustand 的 persist 把**每一次 setState** 都变成一次落盘。
 * 而流式回复一次有一两千个分片,每个分片都会改 messages。
 *
 * 注意这里实现的是 `PersistStorage` 而不是 `StateStorage`:如果用
 * `createJSONStorage` 包一个 StateStorage,序列化发生在**调用存储之前**,
 * 节流就只挡掉了写、挡不掉 `JSON.stringify(整个 state)`——而那一项才是大头。
 * 所以这两件事都推到 flush 时刻:窗口内的中间态只登记对象引用,不序列化。
 *
 * **二、静默丢数据。** 直接退到内存意味着用户聊了一小时、刷新全没、毫无提示。
 * 所以把落在哪一级**暴露出去**,让界面能说清楚"当前内容不会被保存"。
 *
 * 曾经还有过第三级(localStorage),删掉了:它只在 IndexedDB 不可用时才生效,
 * 而那种情况下浏览器通常连 localStorage 也不给(无痕模式),真正起作用的
 * 只有内存那一级 —— 多一级只是多一套要单独测、单独想清楚键冲突的后端。
 *
 * 连接、事务原语和降级后端都在 `lib/idb.ts`,和图片存储共用。
 */
import type { PersistStorage, StorageValue } from 'zustand/middleware';
import { KV_STORE, idbBackend, memoryBackend, openDb, type Backend } from './idb';

/** 写入合并窗口。流式回复一秒能产生几十次 setState,合并掉绝大多数。 */
const FLUSH_DELAY_MS = 400;

export type StorageTier = 'indexeddb' | 'memory';

export interface PersistStorageHandle<S> extends PersistStorage<S> {
  /** 实际落在哪一级存储。界面据此决定要不要提示"不会被保存"。 */
  tier: () => StorageTier;
  /** 立刻落盘。页面隐藏、以及每次请求结束时都要调 —— 合并窗口内的内容不能丢。 */
  flush: () => Promise<void>;
}

// ------------------------------------------------------------------ 主体

export function createPersistStorage<S>(): PersistStorageHandle<S> {
  let tier: StorageTier = 'memory';
  let ready: Promise<Backend> | null = null;

  async function resolveBackend(): Promise<Backend> {
    if (typeof indexedDB !== 'undefined') {
      try {
        const db = await openDb();
        tier = 'indexeddb';
        // 申请持久化存储。否则浏览器在存储压力下会驱逐 IndexedDB ——
        // 而这是用户唯一的一份学习记录。
        void navigator.storage?.persist?.().catch(() => {});
        return idbBackend(db, KV_STORE);
      } catch (e) {
        console.warn('[mathesis] IndexedDB 不可用,退到内存', e);
      }
    }
    // 走到这里说明内容**不会**被保存。tier() 会告诉界面,由它明确提示用户,
    // 不能默默降级 —— 那等于让用户以为自己在被保存。
    tier = 'memory';
    return memoryBackend();
  }

  function backendReady(): Promise<Backend> {
    if (!ready) ready = resolveBackend();
    return ready;
  }

  /** 待写内容。value 为 null 表示删除;存的是**对象引用**,不是序列化结果。 */
  const pending = new Map<string, StorageValue<S> | null>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** 串行化写入队列 —— 并发事务会让 IndexedDB 抛错,而且顺序无法保证。 */
  let queue: Promise<void> = Promise.resolve();

  async function doFlush(): Promise<void> {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    const entries = [...pending];
    pending.clear();
    if (!entries.length) return;

    const b = await backendReady();
    queue = queue.then(async () => {
      for (const [key, value] of entries) {
        try {
          if (value === null) {
            await b.remove(key);
          } else {
            // 序列化在这里发生 —— 一个合并窗口内只做一次,而不是每个分片一次
            await b.set(key, JSON.stringify(value));
          }
        } catch (e) {
          // 绝不向上抛:调用方(zustand)不 await 这个 promise,
          // 抛出去就是一条 unhandledrejection,而且用户完全无感。
          console.warn('[mathesis] 写入存储失败', e);
        }
      }
    });
    await queue;
  }

  function scheduleFlush(): void {
    if (timer !== undefined) return;
    timer = setTimeout(() => void doFlush(), FLUSH_DELAY_MS);
  }

  // 页面被隐藏或卸载时立刻落盘。合并窗口内的内容不能就这么丢掉。
  if (typeof window !== 'undefined') {
    window.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void doFlush();
    });
    window.addEventListener('pagehide', () => void doFlush());
  }

  return {
    getItem: async (name) => {
      // 刚写还没落盘的值优先 —— 否则读到的比内存里旧
      if (pending.has(name)) return pending.get(name) ?? null;
      try {
        const raw = await (await backendReady()).get(name);
        if (!raw) return null;
        return JSON.parse(raw) as StorageValue<S>;
      } catch (e) {
        console.warn('[mathesis] 读取存储失败,当作没有存档', e);
        return null;
      }
    },

    // 同步返回、永不抛。真正的序列化和写入交给合并窗口。
    setItem: (name, value) => {
      pending.set(name, value);
      scheduleFlush();
    },

    removeItem: (name) => {
      pending.set(name, null);
      scheduleFlush();
    },

    tier: () => tier,
    flush: doFlush,
  };
}
