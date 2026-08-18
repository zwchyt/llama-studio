import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import ToastContainer from './components/ToastContainer'
import { notify } from './store/notificationStore'
import './styles/global.css'
import './styles/fonts.css'
import './store/fontStore' // 启动时应用已保存的字体预设（模块副作用）
import './cursor-theme'

// 全局兜底：捕获未处理的 Promise rejection（防止 IPC 裸 await 导致界面卡死）
window.addEventListener('unhandledrejection', (e) => {
  console.error('[unhandledrejection]', e.reason)
  const msg = e.reason instanceof Error ? e.reason.message : String(e.reason)
  notify(`未捕获的错误：${msg}`, 'error')
  e.preventDefault()
})

// 启动卡顿探针：记录主线程同步长任务（>200ms 冻结源）与启动阶段耗时到 console
const _probe = {
  t0: performance.now(),
  log(msg: string): void {
    console.log(`[boot-probe] ${(performance.now() - _probe.t0).toFixed(0)}ms ${msg}`)
  }
}
try {
  longtaskPolyfill()
  const _obs = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      const lt = e as PerformanceEventTiming & { attribution?: { name: string }[] }
      const src = lt.attribution?.length ? lt.attribution.map(a => a.name).join(',') : ''
      console.log(`[boot-probe] LONG-TASK ${Math.round(e.duration)}ms @${(e.startTime / 1000).toFixed(2)}s src=${src || 'unknown'}`)
    }
  })
  _obs.observe({ type: 'longtask', buffered: true })
} catch { /* PerformanceObserver 不可用则跳过 */ }
function longtaskPolyfill(): void {
  // Long Tasks API 需要 --enable-long-task 或较新 Chromium；缺失时兜底用 rAF 间隔估算
  if (typeof PerformanceObserver !== 'undefined') return
  let last = performance.now()
  const tick = (): void => {
    const now = performance.now()
    const gap = now - last
    last = now
    if (gap > 200) console.log(`[boot-probe] RAF-GAP ${Math.round(gap)}ms`)
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
    <ToastContainer />
  </React.StrictMode>
)
