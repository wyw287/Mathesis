/**
 * 图片库自检。
 *
 * 这一层的失败模式全是安静的:缓存没接上只是慢一点,回收扫错方向是把学生的图
 * 悄悄删掉,而存不进去(配额满)如果不抛,学生看到的是"图发出去了"。
 * 所以三件事都要专门测。
 *
 * 运行:npm run check:image
 */
import { blobToDataUrl, fitWithin, newImageId } from '../src/lib/image';
import {
  deleteImages,
  getDataUrl,
  listImageIds,
  putImage,
  sweepImages,
} from '../src/lib/blob-store';
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

const realWarn = console.warn;
console.warn = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].includes('[mathesis]')) return;
  realWarn(...args);
};

const IMG = 'data:image/png;base64,AAAA';

async function main() {
  console.log('\n存取往返');

  {
    const idb = installIndexedDB();
    await putImage('img-1', IMG);
    ok('存进去能读回来', (await getDataUrl('img-1')) === IMG);
    ok('确实落在 blobs 而不是 kv', idb.stores.get('blobs')?.has('img-1') === true);
    ok('kv 里一个字节都没沾上', idb.data.has('img-1') === false, [...idb.data.keys()].join(','));
    idb.uninstall();
  }

  {
    const idb = installIndexedDB();
    ok('没存过的返回 null', (await getDataUrl('不存在')) === null);
    idb.uninstall();
  }

  {
    const idb = installIndexedDB();
    await putImage('a', IMG);
    await putImage('b', IMG);
    const ids = await listImageIds();
    ok('能列出所有图片 id', ids.length === 2 && ids.includes('a') && ids.includes('b'), ids.join(','));

    await deleteImages(['a']);
    ok('删掉一张之后就只剩一张', (await listImageIds()).join(',') === 'b', (await listImageIds()).join(','));
    idb.uninstall();
  }

  console.log('\n缓存 —— 命中的话不该再碰后端');

  {
    const idb = installIndexedDB();
    await putImage('img-1', IMG);
    // put 已经把它放进缓存了,先把缓存清掉才能观察"读"
    const { resetImageStore } = await import('../src/lib/blob-store');
    resetImageStore();

    await getDataUrl('img-1');
    await getDataUrl('img-1');
    await getDataUrl('img-1');
    const reads = idb.ops.filter((o) => o === 'get blobs').length;
    ok('连读三次只打了一次后端', reads === 1, `打了 ${reads} 次`);
    idb.uninstall();
  }

  {
    // 缓存不能改变"删了就是删了"这件事 —— 否则删掉的图还能从缓存里被读出来
    const idb = installIndexedDB();
    await putImage('img-1', IMG);
    await deleteImages(['img-1']);
    ok('删掉之后读不到(缓存也要一起清)', (await getDataUrl('img-1')) === null);
    idb.uninstall();
  }

  console.log('\n回收');

  {
    const idb = installIndexedDB();
    await putImage('留下', IMG);
    await putImage('孤儿-1', IMG);
    await putImage('孤儿-2', IMG);
    const swept = await sweepImages(new Set(['留下']));
    ok('被引用的留下', (await getDataUrl('留下')) === IMG);
    ok('两个孤儿被清掉', swept.length === 2, swept.join(','));
    ok('清完之后只剩一个', (await listImageIds()).length === 1);
    idb.uninstall();
  }

  {
    const idb = installIndexedDB();
    await putImage('a', IMG);
    const swept = await sweepImages(new Set(['a', 'b'])); // keep 里有不存在的 id 也无妨
    ok('keep 里的东西一个都不能少', swept.length === 0 && (await getDataUrl('a')) === IMG);
    idb.uninstall();
  }

  console.log('\n失败要能被看见');

  {
    // 配额满。这是用户刚做完的动作,存不下必须抛出去 ——
    // 和后台落盘那条"绝不向上抛"正相反
    const idb = installIndexedDB({ failWrites: true });
    let err: Error | null = null;
    try {
      await putImage('img-1', IMG);
    } catch (e) {
      err = e as Error;
    }
    ok('存不进去时 putImage 抛错', err !== null, String(err));
    ok('而且没有把没存住的东西留在缓存里', idb.stores.get('blobs')?.size === 0);
    idb.uninstall();
  }

  {
    // 读和删跑在渲染/回收路径上,抛出去没人接 —— 它们只记日志
    const idb = installIndexedDB({ failWrites: true });
    let threw = false;
    try {
      await deleteImages(['img-1']);
      await getDataUrl('img-1');
    } catch {
      threw = true;
    }
    ok('删除和读取出错时不向外抛', !threw);
    idb.uninstall();
  }

  {
    // 没有 IndexedDB:图片只活在内存里,但读写仍然要能用,不能崩
    installIndexedDB().uninstall();
    await putImage('mem', IMG);
    ok('退到内存后照样能读回来', (await getDataUrl('mem')) === IMG);
    ok('内存档下列不出 id(没什么可回收的)', (await listImageIds()).length === 0);
  }

  console.log('\n连接被别的标签页的版本升级关掉时');

  {
    // 图片库这边失败是会抛的,所以症状不是"静默",而是"之后每次贴图都报一个
    // 看不懂的错"。同样得在连接被关掉时把缓存的后端放掉。
    const idb = installIndexedDB();
    await putImage('a', IMG);
    idb.raiseVersionChange();

    let err: Error | null = null;
    try {
      await putImage('b', IMG);
    } catch (e) {
      err = e as Error;
    }
    ok('连接被关掉之后仍然存得进去', err === null, String(err));
    ok('而且读得回来', (await getDataUrl('b')) === IMG);
    idb.uninstall();
  }

  console.log('\n缩放几何');

  {
    ok('横图按长边缩', JSON.stringify(fitWithin(4000, 3000, 1568)) === JSON.stringify({ w: 1568, h: 1176 }), JSON.stringify(fitWithin(4000, 3000, 1568)));
    ok('竖图按长边缩', JSON.stringify(fitWithin(1000, 2000, 1568)) === JSON.stringify({ w: 784, h: 1568 }), JSON.stringify(fitWithin(1000, 2000, 1568)));
    ok('本来就够小的一律不动', JSON.stringify(fitWithin(800, 600, 1568)) === JSON.stringify({ w: 800, h: 600 }));
    // 放大只是凭空多出插值像素,既不会更清晰,又照样按像素收钱
    ok('不放大', JSON.stringify(fitWithin(100, 50, 1568)) === JSON.stringify({ w: 100, h: 50 }));
    ok('极端长条也至少留 1 像素', fitWithin(10000, 1, 1568).h === 1, JSON.stringify(fitWithin(10000, 1, 1568)));
    ok('尺寸为 0 不炸', JSON.stringify(fitWithin(0, 0, 1568)) === JSON.stringify({ w: 0, h: 0 }));
  }

  console.log('\ndata URL 编码');

  {
    const url = await blobToDataUrl(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }));
    ok('带上了正确的 mime', url.startsWith('data:image/png;base64,'), url);
    ok('内容是 base64 而不是空的', Buffer.from(url.split(',')[1], 'base64').equals(Buffer.from([1, 2, 3])));
  }

  {
    // 分块是必须的:`String.fromCharCode(...bytes)` 在几 MB 上会直接把调用栈撑爆。
    // 这条用例就是盯着那个的 —— 去掉分块它会以 RangeError 挂掉。
    const big = new Uint8Array(3 * 1024 * 1024);
    for (let i = 0; i < big.length; i += 997) big[i] = i % 251;
    let url = '';
    let err: Error | null = null;
    try {
      url = await blobToDataUrl(new Blob([big], { type: 'image/png' }));
    } catch (e) {
      err = e as Error;
    }
    ok('3MB 的图不会把调用栈撑爆', err === null, String(err));
    const back = Buffer.from(url.split(',')[1], 'base64');
    ok('而且内容一字不差', back.length === big.length && back[997] === big[997]);
  }

  {
    ok('生成的 id 不重复', newImageId() !== newImageId());
    ok('id 有前缀,便于在库里认出来', newImageId().startsWith('img-'));
  }

  console.log(`\n${pass} 通过, ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
}

void main();
