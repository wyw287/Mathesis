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
