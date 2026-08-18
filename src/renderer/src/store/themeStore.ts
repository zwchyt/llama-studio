import { create } from 'zustand'

// ── 应用主题：浅色（默认，旧样式原样生效）/ 黑暗（新建样式文件整体换肤）──
export type AppTheme = 'light' | 'dark'

// 通过在根节点挂 .theme-dark 类启用黑暗主题，全部深色规则集中在 theme-dark.css，
// 不修改任何旧样式文件
function applyTheme(t: AppTheme): void {
  document.documentElement.classList.toggle('theme-dark', t === 'dark')
}

// 用户切换主题时：先给根节点挂 .theme-switching 临时禁用一切过渡，落定新主题并
// 强制回流后，下一帧再移除，避免各元素以不同步的过渡时长渐变造成整屏闪烁。
function applyThemeInstant(t: AppTheme): void {
  const el = document.documentElement
  el.classList.add('theme-switching')
  applyTheme(t)
  void el.offsetHeight // 强制同步回流：让“无过渡 + 新主题”即时生效
  requestAnimationFrame(() => {
    requestAnimationFrame(() => el.classList.remove('theme-switching'))
  })

}

export interface ThemeOrigin { x: number; y: number }

// 从指定坐标（切换按钮中心）以圆形揭示的方式切换主题：新主题像水波一样
// 从按钮位置扩散铺满全屏。依赖 View Transitions API（Chromium 已原生支持）；
// 不支持或用户偏好减少动态时回退为即时无闪烁切换。
function applyThemeRadial(t: AppTheme, origin?: ThemeOrigin): void {
  const doc = document as Document & {
    startViewTransition?: (cb: () => void) => { ready: Promise<void> }
  }
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
  if (!origin || reduceMotion || typeof doc.startViewTransition !== 'function') {
    applyThemeInstant(t)
    return
  }
  const el = document.documentElement
  // 揭示动画期间禁用各元素自身过渡，避免与扩散动画叠加打架
  el.classList.add('theme-switching')
  const done = (): void => {
    el.classList.remove('theme-switching')
  
  }
  const transition = doc.startViewTransition(() => { applyTheme(t) })
  transition.ready
    .then(() => {
      const { x, y } = origin
      const endRadius = Math.hypot(
        Math.max(x, window.innerWidth - x),
        Math.max(y, window.innerHeight - y)
      )
      const anim = el.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${endRadius}px at ${x}px ${y}px)`] },
        { duration: 480, easing: 'cubic-bezier(.4, 0, .2, 1)', pseudoElement: '::view-transition-new(root)' }
      )
      anim.addEventListener('finish', done)
      anim.addEventListener('cancel', done)
    })
    .catch(done)
  // 兑底：极端情况下动画未触发也确保过渡恢复
  window.setTimeout(done, 900)
}

const initialTheme: AppTheme = (() => {
  try { return localStorage.getItem('appTheme') === 'dark' ? 'dark' : 'light' } catch { return 'light' }
})()
applyTheme(initialTheme)

interface ThemeState {
  theme: AppTheme
  setTheme: (t: AppTheme, origin?: ThemeOrigin) => void
}

export const useThemeStore = create<ThemeState>((set) => ({
  theme: initialTheme,
  setTheme: (t, origin) => {
    set({ theme: t })
    applyThemeRadial(t, origin)
    try { localStorage.setItem('appTheme', t) } catch { /* ignore */ }
    window.api?.setUiSetting('appTheme', t)
  },
}))
