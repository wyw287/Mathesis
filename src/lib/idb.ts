/**
 * IndexedDB 的共享连接与事务原语。
 *
 * 单独一个文件是因为现在有**两个**消费者:持久化存档(`idb-storage.ts`)和图片
 * (`blob-store.ts`)。它们共用同一个数据库,也**必须**共用同一个连接 ——
 * 各自 `openDb` 会出现两个连接各自触发升级,而升级正是最容易卡住的地方。
 */

export const DB_NAME = 'mathesis';
/** zustand persist 的存档。整个 state 序列化成一个值放在这里。 */
export const KV_STORE = 'kv';
/** 图片。一个 key 一张,和存档分开放 —— 见 blob-store.ts 里的说明。 */
export const BLOB_STORE = 'blobs';
/**
 * 加 `blobs` 时从 1 升到 2。
 *
 * 升级本身不丢数据(IndexedDB 不会因为版本变化清掉 object store),但它有一个
 * 安静的陷阱:**另一个标签页正开着旧版本的连接时,新页面会被 block。**
 * 老代码没有 `onversionchange` 处理、不会让路,于是 `openDb` 超时 reject、
 * 整个存储降级到内存 —— 界面显示"存储不可用",看上去像数据全丢了。
 * 所以这里必须挂 `onversionchange`,让**以后**每次升级都不会重演。
 */
export const DB_VERSION = 2;

/** 一个键值后端。值一律是字符串 —— 序列化由调用方决定。 */
export interface Backend {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string) => Promise<void>;
  remove: (key: string) => Promise<void>;
}

export function memoryBackend(): Backend {
  const m = new Map<string, string>();
  return {
    get: async (k) => m.get(k) ?? null,
    set: async (k, v) => {
      m.set(k, v);
    },
    remove: async (k) => {
      m.delete(k);
    },
  };
}

export function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB 请求失败'));
  });
}

/** 等事务真正提交。只等 put 的 request 成功是不够的 —— 页面紧接着关闭时可能没落盘。 */
export function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 事务失败'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 事务中止'));
  });
}

export function idbBackend(db: IDBDatabase, store: string): Backend {
  return {
    get: async (key) => {
      const tx = db.transaction(store, 'readonly');
      const v = await req(tx.objectStore(store).get(key));
      return typeof v === 'string' ? v : null;
    },
    set: async (key, value) => {
      const tx = db.transaction(store, 'readwrite');
      await req(tx.objectStore(store).put(value, key));
      await txDone(tx);
    },
    remove: async (key) => {
      const tx = db.transaction(store, 'readwrite');
      await req(tx.objectStore(store).delete(key));
      await txDone(tx);
    },
  };
}

/** 所有键。用于扫描出孤儿图片,见 blob-store 的 sweepImages。 */
export async function idbKeys(db: IDBDatabase, store: string): Promise<string[]> {
  const tx = db.transaction(store, 'readonly');
  const keys = await req(tx.objectStore(store).getAllKeys());
  return keys.map(String);
}

let conn: Promise<IDBDatabase> | null = null;

/**
 * 连接被关掉时要通知谁。
 *
 * 这个模块只负责"连接",而**拿着连接的 backend 缓存在别人那里** ——
 * `idb-storage` 和 `blob-store` 各自记了一份 `ready`。连接一关,那些 backend
 * 就永久指向一个已经关闭的库:之后每一次 `db.transaction(...)` 都抛
 * `InvalidStateError`,而 persist 那边是**静默吞掉**的(只留一条 console.warn),
 * 于是写入永久失败、界面却毫无表示。
 *
 * 所以关连接的时候必须回头把它们也放掉 —— 这里留一个订阅口,避免
 * `idb.ts` 反过来 import 那两个模块(那会成环)。
 */
const droppedListeners: Array<() => void> = [];

export function onConnectionDropped(fn: () => void): void {
  droppedListeners.push(fn);
}

function dropConnection(): void {
  conn = null;
  for (const fn of droppedListeners) {
    // 一个订阅者出问题不该让其他人的清理也停在那儿
    try {
      fn();
    } catch (e) {
      console.warn('[mathesis] 释放存储连接时出错', e);
    }
  }
}

function openOnce(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    // 按存在与否创建,而不是"升到 2 就建 blobs" —— 从 v0(全新)和从 v1 升上来
    // 都会走到这里,幂等的写法两边都对。
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(KV_STORE)) db.createObjectStore(KV_STORE);
      if (!db.objectStoreNames.contains(BLOB_STORE)) db.createObjectStore(BLOB_STORE);
    };
    r.onsuccess = () => {
      const db = r.result;
      // 别的标签页要升级时让路。没有这一条,那个标签页会一直占着连接,
      // 把新页面挡在 onblocked 上 —— 也就是把"用旧版本的那个页面"变成
      // "打开新版本就丢数据"。
      //
      // 但**让路不等于完事**:连接一关,缓存着它的那些 backend 就全废了,
      // 必须一并放掉(dropConnection 就是干这个的)。少了那一步,这个"修法"
      // 自己会变成一个新 bug:写入从此静默失败,直到刷新。
      db.onversionchange = () => {
        db.close();
        dropConnection();
      };
      resolve(db);
    };
    r.onerror = () => reject(r.error ?? new Error('IndexedDB 打开失败'));
    // 另一个标签页正开着旧版本时会被阻塞。宁可降级,也不要无限等。
    r.onblocked = () => reject(new Error('IndexedDB 被另一个标签页占用'));
  });
}

/**
 * 打开(并记住)连接。
 *
 * 记忆化是必须的:两个消费者各开一次就会出现两个连接。但**失败不能也被记住** ——
 * 一次阻塞或异常之后如果一直返回同一个 rejected promise,浏览器里就再也没有
 * 重试的机会了。
 */
export function openDb(): Promise<IDBDatabase> {
  if (!conn) {
    conn = openOnce().catch((e) => {
      conn = null;
      throw e;
    });
  }
  return conn;
}

/**
 * 关掉并忘掉连接。
 *
 * 记忆化的代价:进程里从此只有一条连接,谁想换一个后端都得先经过这里。
 * 测试就是这么用的 —— 每个用例装一个全新的假 IndexedDB,不关掉上一个的话
 * 会静默地复用旧连接,`failOpen` 之类的注入根本不会生效。
 */
export function closeDb(): void {
  const c = conn;
  conn = null;
  void c?.then((db) => db.close()).catch(() => {});
}
