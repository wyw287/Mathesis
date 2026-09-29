/**
 * Worker 的客户端一侧:发请求、等结果、超时就把整个线程丢掉。
 *
 * 单独一个文件是为了让 `cas.ts` 保持干净 —— 那里是**策略**,要能在 node 里测;
 * 这里是**传输**,只有浏览器用得上。`cas.ts` 用动态 import 拉它,node 里永远走不到。
 */
import type { VerifyRequest, Verdict } from './cas';
import type { CasRequest, CasResponse } from './cas-worker';

let worker: Worker | null = null;
let seq = 0;
/** 一旦确定环境里没有 Worker(比如 node),就不再重试。 */
let supported: boolean | null = null;

function ensureWorker(): Worker | null {
  if (supported === false) return null;
  if (typeof Worker === 'undefined') {
    supported = false;
    return null;
  }
  if (!worker) {
    try {
      worker = new Worker(new URL('./cas-worker.ts', import.meta.url), { type: 'module' });
      supported = true;
    } catch {
      supported = false;
      return null;
    }
  }
  return worker;
}

/**
 * 跑一次核对。**超时返回 null** —— 调用方据此降级。
 *
 * 超时的处理是唯一值得说的地方:同步计算没法中断,所以只能
 * `terminate()` 把整个 worker 丢掉,下次调用会起一个新的。
 * 那意味着 worker 里已经加载好的 CAS 也没了(下次要重新加载,几百毫秒),
 * 但比起让主线程冻死,这是划算的。
 */
export function runInWorker(req: VerifyRequest, timeoutMs: number): Promise<Verdict | null> {
  const w = ensureWorker();
  if (!w) return Promise.resolve(null);
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
      w.terminate();
      worker = null;
      finish(null);
    }, timeoutMs);

    w.addEventListener('message', onMessage);
    w.postMessage({ id, req } satisfies CasRequest);
  });
}
