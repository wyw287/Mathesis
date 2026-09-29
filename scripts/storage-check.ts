/**
 * 存储层自检。
 *
 * 这一层的全部意义是两件事:
 *   **一、把序列化和写入都推迟到合并窗口** —— 否则流式回复一两千个分片,
 *       每个分片都会 `JSON.stringify` 一遍整个 state,那才是真正的性能杀手。
 *   **二、落不了盘时不骗人** —— 落到内存必须如实报告,否则用户以为在被保存。
 *
 * 两件事都不体现在正常路径上,只能专门测。node 里没有 IndexedDB,所以造一个
 * 替身来观察真实的写入与序列化次数 —— 顺带把 IndexedDB 这条路本身(事务提交、
 * 请求回调的时序)也纳入了覆盖,而它在生产里是唯一会走的那条。
 *
 * 运行:npm run check:storage
 */
import { createPersistStorage } from '../src/lib/idb-storage';
import { BLOB_STORE } from '../src/lib/idb';
import { installIndexedDB } from './fake-idb';

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 有一项测试是故意喂坏存档的,产品代码会如实把它记进控制台。
// 那条日志是给线上排障用的,在这里只会淹掉断言结果 —— 滤掉。
const realWarn = console.warn;
console.warn = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].includes('[mathesis]')) return;
  realWarn(...args);
};
const val = (n: number) => ({ state: { messages: [`分片 ${n}`] }, version: 1 });

/** 数一数 `JSON.stringify` 被调了几次。 */
function countStringify() {
  const real = JSON.stringify;
  let calls = 0;
  (JSON as any).stringify = (...args: unknown[]) => {
    calls++;
    return (real as any)(...args);
  };
  return {
    get: () => calls,
    restore: () => {
      (JSON as any).stringify = real;
    },
  };
}

async function main() {
  console.log('\n落点要如实报告');

  {
    const { data, uninstall } = installIndexedDB();
    const s = createPersistStorage();
    await s.getItem('probe'); // 触发后端解析
    ok('有 IndexedDB 时落在 IndexedDB 上', s.tier() === 'indexeddb', s.tier());
    s.setItem('k', val(1));
    await s.flush();
    ok('确实写进去了', data.get('k')?.includes('分片 1') === true, String(data.get('k')));
    uninstall();
  }

  {
    // 无痕模式、或者被另一个标签页占着 —— openDb 会 reject
    const { uninstall } = installIndexedDB({ failOpen: true });
    const s = createPersistStorage();
    await s.getItem('probe');
    ok('IndexedDB 打不开时退到内存', s.tier() === 'memory', s.tier());
    s.setItem('k', val(7));
    await s.flush();
    const back = (await s.getItem('k')) as any;
    ok('内存档下仍能读回本次会话写的内容', back?.state?.messages?.[0] === '分片 7', JSON.stringify(back));
    uninstall();
  }

  {
    // node 里本来就没有 —— 这才是真的"什么都不给"
    const s = createPersistStorage();
    await s.getItem('probe');
    ok('连 IndexedDB 都没有时也退到内存', s.tier() === 'memory', s.tier());
  }

  console.log('\n合并写入 —— 这一层的存在理由');

  {
    const { writes, uninstall } = installIndexedDB();
    const s = createPersistStorage();
    await s.getItem('probe');

    // 模拟流式回复:一次长回复会改 messages 上千次
    for (let i = 0; i < 1000; i++) s.setItem('mathesis', val(i));
    await s.flush();

    ok('一千次 setItem 只落盘一次', writes.length === 1, String(writes.length));
    ok('而且落盘的是最后一次的值', writes[0].includes('分片 999'), writes[0].slice(0, 60));
    uninstall();
  }

  {
    // 这条才是这次改动的核心:序列化必须也被推迟,
    // 否则每个分片都要 stringify 一遍整个 state。
    const { uninstall } = installIndexedDB();
    const counter = countStringify();
    const s = createPersistStorage();
    await s.getItem('probe');
    const before = counter.get();

    for (let i = 0; i < 1000; i++) s.setItem('mathesis', val(i));
    const duringSet = counter.get() - before;
    await s.flush();
    const total = counter.get() - before;
    counter.restore();

    ok('setItem 阶段完全不做序列化', duringSet === 0, `做了 ${duringSet} 次`);
    ok('一千次 setItem 只在 flush 时序列化一次', total === 1, `做了 ${total} 次`);
    uninstall();
  }

  {
    const { uninstall } = installIndexedDB();
    const s = createPersistStorage();
    await s.getItem('probe');
    for (let i = 0; i < 50; i++) s.setItem('k', val(i));
    const before = (await s.getItem('k')) as any;
    ok('flush 之前 getItem 返回待写值,不读到旧值', before?.state?.messages?.[0] === '分片 49');
    await s.flush();
    const after = (await s.getItem('k')) as any;
    ok('flush 之后仍是最后的值', after?.state?.messages?.[0] === '分片 49');
    uninstall();
  }

  console.log('\n定时器与强制落盘');

  {
    const { writes, uninstall } = installIndexedDB();
    const s = createPersistStorage();
    await s.getItem('probe');
    s.setItem('k', val(1));
    ok('setItem 之后没有立刻写', writes.length === 0, String(writes.length));
    await sleep(700); // FLUSH_DELAY_MS 是 400
    ok('合并窗口到期后自动落盘', writes.length === 1, String(writes.length));
    uninstall();
  }

  {
    const { writes, data, uninstall } = installIndexedDB();
    const s = createPersistStorage();
    await s.getItem('probe');
    s.setItem('k', val(1));
    s.removeItem('k');
    await s.flush();
    ok('删除也走同一个队列', !data.has('k'));
    // 更好的结果:紧随其后的删除把那次写抵消掉了,一次落盘都没有。
    // 中间态根本不该到达存储。
    ok('写入被随后的删除抵消,一次都没落盘', writes.length === 0, `落了 ${writes.length} 次`);
    uninstall();
  }

  console.log('\n失败不能把调用方炸掉');

  {
    // zustand 不 await 这个 promise,抛出去就是一条 unhandledrejection,
    // 而且用户完全无感
    const { uninstall } = installIndexedDB({ failWrites: true });
    const s = createPersistStorage();
    await s.getItem('probe');
    let threw = false;
    try {
      s.setItem('k', val(1));
      await s.flush();
    } catch {
      threw = true;
    }
    ok('后端抛错时 flush 不向外抛', !threw);
    uninstall();
  }

  {
    // 存档损坏时应当当作没有存档,而不是让整个应用起不来
    const { data, uninstall } = installIndexedDB();
    data.set('mathesis', '{这不是合法 JSON');
    const s = createPersistStorage();
    ok('损坏的存档返回 null 而不是抛错', (await s.getItem('mathesis')) === null);
    uninstall();
  }

  console.log('\n从 v1 升到 v2 —— 加 blobs 不能碰坏已有的存档');

  {
    // 用户浏览器里现在就是这个状态:版本 1,只有 kv,里面是他全部的会话。
    // 升级最坏的结果是"打开就丢数据",而它恰恰是最容易被静默搞砸的一步。
    const idb = installIndexedDB({
      existing: { version: 1, seed: { kv: { 'mathesis.session': JSON.stringify(val(42)) } } },
    });
    ok('起点确实只有 kv', !idb.stores.has(BLOB_STORE), [...idb.stores.keys()].join(','));

    const s = createPersistStorage();
    const back = (await s.getItem('mathesis.session')) as any;
    ok('升级之后旧存档还在', back?.state?.messages?.[0] === '分片 42', JSON.stringify(back));
    ok('版本升到了 2', idb.version() === 2, String(idb.version()));
    ok('blobs 被建出来了', idb.stores.has(BLOB_STORE), [...idb.stores.keys()].join(','));
    idb.uninstall();
  }

  {
    // 升级之后写入仍然正常 —— 建新 store 不能把 kv 的连接带坏
    const idb = installIndexedDB({ existing: { version: 1 } });
    const s = createPersistStorage();
    await s.getItem('probe');
    s.setItem('k', val(7));
    await s.flush();
    ok('升级后新的写入照常落进 kv', idb.data.get('k')?.includes('分片 7') === true, String(idb.data.get('k')));
    idb.uninstall();
  }

  console.log('\n连接被别的标签页的版本升级关掉时');

  {
    // 这一条盯的是"让路"这个修法自己引进来的 bug:连接关掉了,但**缓存着它的
    // backend** 还拿着一个已关闭的库。之后每一次 db.transaction() 都抛
    // InvalidStateError,被 doFlush 吞成一条 console.warn ——
    // 写入永久失败,而顶栏一切正常。
    const idb = installIndexedDB();
    const s = createPersistStorage();

    await s.getItem('probe'); // 解析后端
    s.setItem('k', val(1));
    await s.flush();
    ok('先正常写进去了', idb.data.get('k')?.includes('分片 1') === true, String(idb.data.get('k')));

    idb.data.clear();
    idb.raiseVersionChange(); // 别的标签页要用新版本

    s.setItem('k', val(2));
    await s.flush();
    ok('连接被关掉之后,写入不能静默失败', idb.data.get('k')?.includes('分片 2') === true, String(idb.data.get('k')));
    idb.uninstall();
  }

  {
    // 重开失败(本页版本落后)时只能落回内存 —— 但那必须**被界面知道**,
    // 否则就是"默默降级",和这个项目一开始要防的是同一件事。
    const idb = installIndexedDB();
    const seen: string[] = [];
    const s = createPersistStorage({ onTierChange: (t) => seen.push(t) });

    await s.getItem('probe');
    ok('落在 IndexedDB 上时报告一次', s.tier() === 'indexeddb' && seen.includes('indexeddb'), seen.join(','));

    idb.bumpVersionAhead(); // 这个页面已经落后了
    idb.raiseVersionChange();

    s.setItem('k', val(1));
    await s.flush();
    ok('重开失败后退回内存', s.tier() === 'memory', s.tier());
    ok('而且把这次变化报了出去(界面才能提示)', seen.includes('memory'), seen.join(','));
    idb.uninstall();
  }

  console.log(`\n${pass} 通过, ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
}

void main();
