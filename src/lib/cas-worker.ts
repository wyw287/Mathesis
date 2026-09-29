/**
 * 核对用的 Web Worker。
 *
 * ## 为什么必须要它
 *
 * `nerdamer` 的 `expand` / `simplify` 都是**同步**的,而且**算得出奇的久**。
 * 实测(子进程硬超时探出来的):
 *
 *     (x+1)^100        1881ms
 *     (x+1)^500        > 12s
 *     (x+y+z)^40       > 12s
 *     (x+y+z+w)^30     > 12s
 *
 * 项数按组合数增长,所以这不是"慢",是没有上界。放在主线程上就是**冻住整个
 * 标签页** —— 用户只能强杀。而计算能力本身没法中断,唯一的办法是把它挪到
 * 另一个线程,超时后连线程一起丢掉。
 *
 * 这个 worker 只做一件事:收一个请求,跑核对,把结论发回去。策略本身在
 * `cas.ts` 里,所以那部分仍然可以在 node 里测。
 */
import { verifyStep, type VerifyRequest, type Verdict } from './cas';

export interface CasRequest {
  id: number;
  req: VerifyRequest;
}

export type CasResponse = { id: number; verdict: Verdict } | { id: number; error: string };

/**
 * 先报到,再干活。
 *
 * 客户端据此判断"worker 到底起没起来"。没有这一步的话,代码块加载失败时
 * 请求会石沉大海,而调用方只能靠**每一步都等满超时**才发现 —— 六步推导就是
 * 三十秒的干等,那不是安全降级,那是另一种卡法。
 *
 * 这里能立刻报到,是因为 nerdamer 藏在 `verifyStep` 的动态 import 后面,
 * 这个文件的顶层只有下面这几行。
 */
self.postMessage({ ready: true });

self.onmessage = (e: MessageEvent<CasRequest>) => {
  const { id, req } = e.data ?? {};
  if (typeof id !== 'number' || !req) return;
  void (async () => {
    try {
      const verdict = await verifyStep(req);
      (self as unknown as Worker).postMessage({ id, verdict } satisfies CasResponse);
    } catch (err) {
      (self as unknown as Worker).postMessage({
        id,
        error: (err as Error)?.message ?? String(err),
      } satisfies CasResponse);
    }
  })();
};
