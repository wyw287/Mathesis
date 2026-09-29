/**
 * 假 IndexedDB。
 *
 * node 里没有 IndexedDB,而存储层的行为只在真实落盘路径上体现 —— 事务提交时序、
 * 合并窗口、序列化次数、以及**升级**。所以必须造一个能被观察的替身。
 *
 * 三个自检脚本共用它(storage / image / agent),所以单独一个文件。
 */
import { closeDb, KV_STORE } from '../src/lib/idb';
import { resetImageStore } from '../src/lib/blob-store';

export interface FakeIdbOptions {
  /** open 直接失败 —— 无痕模式,或者被另一个标签页挡住。 */
  failOpen?: boolean;
  /** 写入失败 —— 配额满。 */
  failWrites?: boolean;
  /**
   * 装一个**已经存在**的旧数据库。
   *
   * 这是升级路径唯一能被走到的方式:替身必须记得当前版本和已有的 store,
   * 否则 `open(name, 2)` 每次都等于从零开始,`onupgradeneeded` 里"按存在与否创建"
   * 那段逻辑永远只走真分支。
   */
  existing?: { version: number; seed?: Record<string, Record<string, string>> };
}

export function installIndexedDB(opts: FakeIdbOptions = {}) {
  // 连接在 lib/idb.ts 里是记忆化的、图片库那边还多缓存了一层 backend ——
  // 换后端之前必须把这两样都放掉,否则这里注入的失败、或者新装的 store,
  // 都会被上一个用例的连接静默吃掉。
  closeDb();
  resetImageStore();

  const stores = new Map<string, Map<string, string>>();
  let version = 1;

  if (opts.existing) {
    version = opts.existing.version;
    for (const [name, entries] of Object.entries(opts.existing.seed ?? {})) {
      stores.set(name, new Map(Object.entries(entries)));
    }
  }
  if (!stores.has(KV_STORE)) stores.set(KV_STORE, new Map());

  /** kv 的每一次写入,按顺序。落盘次数就是数它。 */
  const writes: string[] = [];
  /** 全部读写操作,形如 "get blobs"。用来断言缓存有没有真的挡住后端。 */
  const ops: string[] = [];

  const makeRequest = (produce: () => unknown, failWith?: Error) => {
    const r: any = {};
    // 回调必须**异步**触发:产品代码是在拿到 request **之后**才挂 onsuccess 的,
    // 同步触发会让两个 handler 都还是 undefined —— 表现是 promise 永不 settle、
    // 整个测试挂死,而不是失败。
    queueMicrotask(() => {
      if (failWith) {
        r.error = failWith;
        r.onerror?.();
        return;
      }
      try {
        r.result = produce();
      } catch (e) {
        // 真实的 IndexedDB 用 error 事件报告失败,而不是让异常炸穿到这里
        r.error = e;
        r.onerror?.();
        return;
      }
      r.onsuccess?.();
    });
    return r;
  };

  /** 当前打开着的连接。真实的 IndexedDB 允许同时开多个,各自独立关闭。 */
  const connections = new Set<any>();

  /**
   * 造一条**独立的连接**。
   *
   * 每次 open 都给一个新的,而不是全库共用一个对象 —— 这一点是必须的:
   * 产品代码在版本升级时会关掉连接,而共用对象的话"关掉"看起来毫无效果,
   * 「连接关了但缓存的后端还拿着它」那个 bug 就永远测不出来。
   */
  const makeConnection = () => {
    let closed = false;

    const storeHandle = (name: string) => {
      const data = () => {
        if (closed) throw new Error('InvalidStateError: 连接已关闭');
        const m = stores.get(name);
        // 真实的 IndexedDB 在 store 不存在时抛 NotFoundError。替身也抛,
        // 升级没把 store 建出来才会当场暴露,而不是静默读写一个空 Map。
        if (!m) throw new Error(`object store "${name}" 不存在`);
        return m;
      };
      return {
        get: (k: string) => {
          ops.push(`get ${name}`);
          return makeRequest(() => data().get(k));
        },
        put: (v: string, k: string) => {
          ops.push(`put ${name}`);
          if (name === KV_STORE) writes.push(v);
          return makeRequest(() => void data().set(k, v), opts.failWrites ? new Error('写入失败') : undefined);
        },
        delete: (k: string) => {
          ops.push(`delete ${name}`);
          return makeRequest(() => void data().delete(k));
        },
        getAllKeys: () => {
          ops.push(`keys ${name}`);
          return makeRequest(() => [...data().keys()]);
        },
      };
    };

    const db: any = {
      objectStoreNames: { contains: (n: string) => stores.has(n) },
      createObjectStore: (n: string) => {
        stores.set(n, new Map());
        return storeHandle(n);
      },
      transaction: (name: string) => {
        if (closed) throw new Error('InvalidStateError: 连接已关闭');
        if (!stores.has(name)) throw new Error(`object store "${name}" 不存在`);
        const tx: any = { objectStore: () => storeHandle(name) };
        // 提交是宏任务,请求回调是微任务 —— 真实 IDB 也是这个顺序,
        // 而产品代码要靠它才能在这两者之间把 oncomplete 挂上
        setTimeout(() => tx.oncomplete?.(), 0);
        return tx;
      },
      close: () => {
        closed = true;
        connections.delete(db);
      },
    };
    connections.add(db);
    return db;
  };

  (globalThis as any).indexedDB = {
    open: (_name: string, reqVersion: number) => {
      const r: any = {};
      queueMicrotask(() => {
        if (opts.failOpen) {
          r.error = new Error('打不开');
          r.onerror?.();
          return;
        }
        if (reqVersion < version) {
          // 真实的 IndexedDB 会抛 VersionError —— 旧版本的代码打不开新版本的库
          r.error = new Error('VersionError');
          r.onerror?.();
          return;
        }
        r.result = makeConnection();
        if (reqVersion > version) {
          r.oldVersion = version;
          version = reqVersion;
          r.onupgradeneeded?.();
        }
        r.onsuccess?.();
      });
      return r;
    },
  };

  return {
    /** 每个 store 的最终内容。 */
    stores,
    /** kv 的内容 —— storage-check 里那些断言直接看它。 */
    data: stores.get(KV_STORE)!,
    writes,
    ops,
    /** 当前版本号,升级用例断言它。 */
    version: () => version,
    /**
     * 模拟"另一个标签页要用更高的版本打开"。
     *
     * 真实的 IndexedDB 会对每一条旧连接触发 `versionchange`;产品代码在那一刻
     * 必须关掉自己的连接,而且必须把**拿着那条连接的东西**一起放掉。
     * 这是唯一能把这个场景造出来的入口。
     */
    raiseVersionChange: () => {
      for (const db of [...connections]) db.onversionchange?.();
    },
    /**
     * 把库的版本推到当前代码声明的版本**前面**去。
     *
     * 用来造"这个页面已经落后了"的局面:它重开时会拿到 VersionError,
     * 只能退回内存 —— 而那一步必须被界面知道。
     */
    bumpVersionAhead: () => {
      version += 1;
    },
    uninstall: () => {
      closeDb();
      resetImageStore();
      connections.clear();
      delete (globalThis as any).indexedDB;
    },
  };
}
