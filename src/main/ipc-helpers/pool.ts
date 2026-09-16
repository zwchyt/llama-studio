// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 有界并发池（动态共享队列）—— 主进程 I/O 密集任务的标准调度器                  ║
// ║                                                                              ║
// ║ 为什么需要它：主进程里大量任务是「读文件 → 解析/扫描」，单个任务耗时以           ║
// ║ I/O 等待为主。若按 `for (const x of xs) await work(x)` 串行执行，同一时刻       ║
// ║ 只有一个 I/O 在途，等待时间无法重叠；而 `Promise.all(xs.map(work))` 又会         ║
// ║ 一次性抛出成千上万个并发请求，把 libuv 线程池与文件句柄压垮。                  ║
// ║                                                                              ║
// ║ 做法：固定宽度 worker + 共享游标。每个 worker 循环「取下一个下标 → 处理」，     ║
// ║ 空闲者立即接手后续任务（动态共享队列，而非静态均分）。因此：                    ║
// ║   · 在途 I/O 恒为 ≤ concurrency，资源占用可预测；                              ║
// ║   · 长尾任务不会拖住某个固定分片 —— makespan 趋近「总负载 / 并发度」的理论下界。 ║
// ║                                                                              ║
// ║ 并发度默认取 4：异步 fs 实际由 libuv 线程池执行，其默认宽度即 4；超过该值后      ║
// ║ 吞吐进入平台期（实测饱和点正是这一边界），继续加大只会增加排队与内存压力。      ║
// ╚══════════════════════════════════════════════════════════════════════════════╝

/** 异步 fs 由 libuv 线程池执行，其默认宽度为 4 —— 再高的并发度只会排队 */
export const DEFAULT_POOL_CONCURRENCY = 4

/** 归一化并发度：非法值（NaN / ≤0 / 非整数）一律退回默认宽度 */
export function normalizeConcurrency(value: unknown, fallback = DEFAULT_POOL_CONCURRENCY): number {
  const n = Math.floor(Number(value))
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/**
 * 以有界并发执行 `worker(items[i], i)`，全部完成后 resolve。
 *
 * 任务之间互不依赖、顺序无关时使用；需要保持结果顺序请用 `mapPool`。
 * 任一 worker 抛错即整体 reject（与 `Promise.all` 一致，不做静默吞错）。
 */
export async function runPool<T>(
  items: readonly T[],
  worker: (item: T, index: number) => Promise<void> | void,
  concurrency: number = DEFAULT_POOL_CONCURRENCY,
): Promise<void> {
  const total = items.length
  if (total === 0) return
  const width = Math.min(normalizeConcurrency(concurrency), total)
  let cursor = 0
  const workers: Promise<void>[] = []
  for (let w = 0; w < width; w++) {
    workers.push((async () => {
      for (;;) {
        const i = cursor++          // 共享游标：动态共享队列，空闲 worker 立即取下一个
        if (i >= total) return
        await worker(items[i] as T, i)
      }
    })())
  }
  await Promise.all(workers)
}

/**
 * `runPool` 的保序版本：结果数组与输入同序（下标写回，不依赖完成顺序）。
 */
export async function mapPool<T, R>(
  items: readonly T[],
  mapper: (item: T, index: number) => Promise<R> | R,
  concurrency: number = DEFAULT_POOL_CONCURRENCY,
): Promise<R[]> {
  const out = new Array<R>(items.length)
  await runPool(items, async (item, i) => { out[i] = await mapper(item, i) }, concurrency)
  return out
}
