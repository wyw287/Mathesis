/**
 * Worker 的客户端一侧:发请求、等结果、超时就把整个线程丢掉。
 *
 * 单独一个文件是为了让 `cas.ts` 保持干净 —— 那里是**策略**,要能在 node 里测;
 * 这里是**传输**,只有浏览器用得上。`cas.ts` 用动态 import 拉它,node 里永远走不到。
 */
import type { VerifyRequest, Verdict } from './cas';
import type { CasRequest, CasResponse } from './cas-worker';

/**
 * 等 worker 报到的时限。
 *
 * 它的顶层只挂了一个消息处理函数(nerdamer 藏在 `verifyStep` 的动态 import 后面),
 * 所以正常情况下是毫秒级。等这么久还没动静,基本可以断定是那个代码块没加载成功
 * (最常见的原因是部署到了子路径、worker 的相对路径不对)。
 */
const READY_TIMEOUT_MS = 3000;

let worker: Worker | null = null;
let seq = 0;

/**
 * `unknown` → 还没试过;`ready` → 能用;`unsupported` → 别再用它了。
 *
 * **这个状态必须记住。** 记不住的话,worker 坏掉之后**每一步都要白等一次超时**
 * —— 六步推导就是三十秒的干等。那不是安全降级,那是另一种卡法。
 */
let state: 'unknown' | 'ready' | 'unsupported' = 'unknown';
let booting: Promise<boolean> | null = null;

function boot(): Promise<boolean> {
  if (state !== 'unknown') return Promise.resolve(state === 'ready');
  if (booting) return booting;

  booting = new Promise<boolean>((resolve) => {
    let w: Worker;
    try {
      w = new Worker(new URL('./cas-worker.ts', import.meta.url), { type: 'module' });
    } catch (e) {
      console.warn('[mathesis] 核对 worker 起不来,退回主线程', e);
      state = 'unsupported';
      resolve(false);
      return;
    }

    const timer = setTimeout(() => {
      console.warn(
        `[mathesis] 核对 worker ${READY_TIMEOUT_MS}ms 内没有报到,之后退回主线程。` +
          '多半是它的代码块没加载成功(检查一下部署路径)。',
      );
      w.terminate();
      state = 'unsupported';
      resolve(false);
    }, READY_TIMEOUT_MS);

    const onReady = (e: MessageEvent<{ ready?: boolean }>) => {
      if (!e.data?.ready) return;
      w.removeEventListener('message', onReady);
      clearTimeout(timer);
      worker = w;
      state = 'ready';
      resolve(true);
    };
    w.addEventListener('message', onReady);
  });

  return booting;
}

/**
 * 跑一次核对。**超时或不可用返回 null** —— 调用方据此降级。
 *
 * 超时的处理是唯一值得说的地方:同步计算没法中断,所以只能
 * `terminate()` 把整个 worker 丢掉,下次调用会起一个新的。
 * 那意味着 worker 里已经加载好的 CAS 也没了(下次要重新加载,几百毫秒),
 * 但比起让主线程冻死,这是划算的。
 */
export async function runInWorker(req: VerifyRequest, timeoutMs: number): Promise<Verdict | null> {
  if (!(await boot())) return null;
  const w = worker;
  if (!w) return null;

  const id = ++seq;
  return new Promise<Verdict | null>((resolve) => {
    let settled = false;
    const finish = (v: Verdict | null) => {
      if (settled) return;
      settled = true;
      w.removeEventListener('message', onMessage);
      clearTimeout(timer);
      resolve(v);
    };

    const onMessage = (e: MessageEvent<CasResponse>) => {
      if (e.data?.id !== id) return;
      finish('verdict' in e.data ? e.data.verdict : null);
    };

    const timer = setTimeout(() => {
      // 这一条超时是**真的算太久**(不是 worker 坏了),所以下次还用它
      w.terminate();
      worker = null;
      state = 'unknown';
      booting = null;
      finish(null);
    }, timeoutMs);

    w.addEventListener('message', onMessage);
    w.postMessage({ id, req } satisfies CasRequest);
  });
}
