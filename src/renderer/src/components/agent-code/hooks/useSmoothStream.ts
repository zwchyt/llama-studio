import { useEffect, useRef, useState } from 'react'

interface SmoothStreamOptions {
  /** 是否处于流式态：true 匀速揭示；false 直通（立即显示全部并停掉揭示循环） */
  active: boolean
  /** 缓冲积压上限（字符）：超过则本帧全量追平，防止高吞吐时视觉滞后无限放大 */
  maxLagChars?: number
}

/**
 * 流式正文平滑揭示（打字机层）：到达与显示解耦。
 *
 * 背景：模型吐字（SSE token → IPC）天然不均匀——有时一帧挤进 4-5 个 token，
 * 有时 200ms 挤不出 1 个。直通渲染时「到达节奏 = 显示节奏」，到达抖动 1:1 映射
 * 成画面抖动，观感「一顿一顿」。
 *
 * 本层把到达与显示拆开：
 *   · 到达侧：新内容只写 targetRef（零渲染成本），突发再猛也不触发重渲染；
 *   · 显示侧：单一 rAF 循环每帧从缓冲取字上屏，取字速率贴住实测吐字速率
 *     （500ms 窗口平均 + 两次窗口 EMA）；积压明显时 ×2 加速追赶，积压超过
 *     maxLagChars 时本帧追平 —— 画面始终按帧匀速生长，尾字延迟有界。
 * 流式结束（active=false）立即直通冲刷，终态与持久化内容严格一致。
 *
 * 揭示只推进字符偏移（posRef），上屏时 slice(0, pos)：markstream 对「前缀增长」
 * 输入做节点级复用，单次更新成本与全文长度弱相关，与打字机节奏天然契合。
 */
export function useSmoothStream(target: string, { active, maxLagChars = 400 }: SmoothStreamOptions): string {
  const [shown, setShown] = useState(target)
  // 已揭示字符数（target 的字符偏移）：上屏 = slice(0, pos)，不持有第二份全文
  const posRef = useRef(target.length)
  // 吐字速率采样（字符/秒）：500ms 窗口累计到达量，窗口结算时做 EMA 平滑；0 = 尚无估计
  const rateRef = useRef(0)
  const winCharsRef = useRef(0)
  const winStartRef = useRef(0)
  const lastLenRef = useRef(target.length)
  // 到达侧只写 ref：任何帧内的新内容都不直接触发渲染
  const targetRef = useRef(target)
  targetRef.current = target

  // 直通态（流式结束/未激活）：渲染期同步追平（对齐 useFrameThrottledValue 的做法，
  // 不用 effect —— effect 晚一个 commit，流式结束瞬间会多闪一帧旧内容）
  if (!active && shown !== target) setShown(target)
  if (!active && posRef.current !== target.length) posRef.current = target.length

  useEffect(() => {
    if (!active) return
    // 循环启动：从当前已显示处继续（中途重挂载时 posRef 初值=全文长度，直接贴平）
    lastLenRef.current = targetRef.current.length
    let raf = 0
    let last = performance.now()
    const tick = (t: number): void => {
      const dt = Math.min(0.25, (t - last) / 1000) // 帧间隔（秒）；后台标签页回来时限幅
      last = t
      const len = targetRef.current.length

      // 内容收缩（新一轮复用同一组件实例的防御分支）：偏移直接贴平
      if (len < posRef.current) {
        posRef.current = len
        lastLenRef.current = len
        setShown(targetRef.current)
        raf = requestAnimationFrame(tick)
        return
      }

      // ── 速率采样：窗口累计到达量，≥500ms 结算一次窗口平均（抗逐帧突发抖动）──
      const grown = len - lastLenRef.current
      lastLenRef.current = len
      if (winStartRef.current === 0) winStartRef.current = t
      winCharsRef.current += Math.max(0, grown)
      if (t - winStartRef.current >= 500) {
        const inst = winCharsRef.current / ((t - winStartRef.current) / 1000)
        rateRef.current = rateRef.current === 0 ? inst : rateRef.current * 0.6 + inst * 0.4
        winCharsRef.current = 0
        winStartRef.current = t
      }

      // ── 本帧揭示量：贴住吐字速率；积压 > 0.5s 产量 → ×2 追赶；积压超限 → 追平 ──
      const lag = len - posRef.current
      if (lag > 0) {
        const base = Math.max(120, rateRef.current)       // 兜底速率 120 字符/秒（首 token 前）
        const speed = lag > base * 0.5 ? base * 2 : base
        const step = lag > maxLagChars ? lag : Math.max(1, Math.round(speed * dt))
        posRef.current = Math.min(len, posRef.current + step)
        setShown(targetRef.current.slice(0, posRef.current))
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [active, maxLagChars])

  return shown
}