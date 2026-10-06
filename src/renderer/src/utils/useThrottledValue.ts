import { useEffect, useRef, useState } from 'react'

/**
 * 把「随流式输出高频变化的值」按固定时间窗节流：窗口内多次变化只取最后一次。
 * 流式期间父组件每帧都因内容增长重渲染，下游的 O(n²) diff / O(n) 语法高亮不该按帧率跑。
 *
 * deps 由调用方给定（长度需固定）—— 传字段数组而不是让钩子自己比较 value，是为了避免
 * 对大字符串做相等比较。enabled=false 表示立即同步：收敛时必须传 false，否则会定格在中间帧。
 *
 * 最新值放 ref 而非让定时器闭包捕获：闭包捕获的是「调度那一刻」的值，定时器到点写回旧值
 * 而 deps 未再变 → 不会重新调度 → 值永久定格在窗口内第一帧。
 */
export function useThrottledValue<T>(
  value: T,
  deps: readonly unknown[],
  enabled: boolean,
  ms: number,
): T {
  const [throttled, setThrottled] = useState<T>(value)
  const latest = useRef(value)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // 声明在定时器 effect 之前：同一次提交里保证「先写入最新值，再决定是否调度」
  useEffect(() => {
    latest.current = value
  })

  useEffect(() => {
    if (!enabled) {
      // 收敛：清掉在途节流，立即与最新值同步
      if (timer.current) { clearTimeout(timer.current); timer.current = undefined }
      setThrottled(latest.current)
      return
    }
    if (timer.current) return // 已有在途窗口：等它到点统一取最新值
    timer.current = setTimeout(() => {
      timer.current = undefined
      setThrottled(latest.current)
    }, ms)
    // deps 由调用方给定，长度稳定；在此展开是为了让「值变化」驱动 effect 重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ms, ...deps])

  // 卸载时清掉在途定时器，避免对已卸载组件 setState
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  return throttled
}
