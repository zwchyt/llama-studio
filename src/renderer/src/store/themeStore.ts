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
  // 顺手摘掉揭示类：否则若上一次圆形揭示被中断，@keyframes 会留在根节点上，
  // 让后续过渡意外带上裁剪动画。
  el.classList.remove('theme-reveal')
  el.classList.add('theme-switching')
  applyTheme(t)
  void el.offsetHeight // 强制同步回流：让“无过渡 + 新主题”即时生效
  requestAnimationFrame(() => {
    requestAnimationFrame(() => el.classList.remove('theme-switching'))
  })
}

export interface ThemeOrigin { x: number; y: number }

/* ── 圆形揭示的节奏：想调手感只改这两个常量 ──
   缓动是「看起来顿」的主因。把波前速度按时间采样（平均速度 = 1）对比：

     .45,.05,.25,1（上一版）  0.1 0.3 0.6 0.9 1.3 1.9 2.5 2.7 2.5 2.0 1.6 1.2 1.0 0.7 0.6 0.4 0.3 0.2 0.1 0.1 0.0
     .3,.2,.7,.8（现在）      0.7 0.8 0.9 1.0 1.0 1.1 1.1 1.1 1.1 1.2 1.2 1.2 1.1 1.1 1.1 1.1 1.0 1.0 0.9 0.8 0.7

   旧曲线头三分之一加速了 27 倍、末段 20% 的时间只走 3% 的距离：
   眼睛对「猛加速」和「末尾蠕动」都极敏感，两头都像卡了一下。
   新曲线速度峰/谷 = 1.16 / 0.68，相邻采样点的最大速度突变从 0.57 降到 0.11，
   波前基本匀速推进——真实水波本来就是匀速扩散的。
   嫌慢把 REVEAL_MS 降到 700，嫌快加到 1200，曲线一般不用动。 */
const REVEAL_MS = 900
const REVEAL_EASING = 'cubic-bezier(.3, .2, .7, .8)'

// 揭示动画的世代号：连点两次时，上一次过渡的收尾不能去摘这一次的守卫类。
// 没有它的话，切换时右边缘又会闪出滑动条。
let revealToken = 0

// 从指定坐标（切换按钮中心）以圆形揭示的方式切换主题：新主题像水波一样
// 从按钮位置扩散铺满全屏。依赖 View Transitions API（Chromium 已原生支持）；
// 不支持或用户偏好减少动态时回退为即时无闪烁切换。
//
// 两个守卫类的生命周期（时序很关键，改之前先看这里）：
//
// .theme-switching ——
//   ① 必须在 startViewTransition() 之前挂上——否则回调里切 .theme-dark 时，
//      各元素会带着自己的 transition 慢慢渐变，新快照会拍到“渐变起点”（旧配色），
//      水波揭开的就是一屏没换过来的旧界面。
//   ② 必须一直挂到动画结束（即覆盖层被移除）为止，不能提前摘。
//      除了 ① 的作用，这个类还兼任「过渡期间滚动条守卫」——见 theme-dark.css 里
//      html.theme-switching 的滚动条规则。它必须完整覆盖 top-layer 覆盖层的存活期，
//      提前摘掉就等于把守卫关掉了，切换时右边缘会重新闪出滑动条。
//
// .theme-reveal —— 激活 theme-dark.css 里的 @keyframes vt-circle-reveal。
//   同样必须在 startViewTransition() 之前挂上：CSS 动画要赶在伪元素诞生的
//   第一帧就生效，晚一帧就会先闪出「完整可见、还没被裁剪」的新主题。
function applyThemeRadial(t: AppTheme, origin?: ThemeOrigin): void {
  const doc = document as Document & {
    startViewTransition?: (cb: () => void) => { finished: Promise<void> }
  }
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
  if (!origin || reduceMotion || typeof doc.startViewTransition !== 'function') {
    applyThemeInstant(t)
    return
  }
  const el = document.documentElement
  const token = ++revealToken
  let released = false
  const startedAt = performance.now()

  // 摘掉两个守卫类。两道保险：
  //   ① token —— 连点两次时，旧过渡的收尾不能去摘新过渡的守卫；
  //   ② 时间下限 —— .theme-switching 同时兼任滚动条守卫，必须覆盖整个揭示动画。
  //      万一 @keyframes 没生效，transition.finished 会立刻 resolve；那时若提前
  //      摘掉守卫，右边缘又会闪出滑动条。所以再压一个「不早于 REVEAL_MS」的下限。
  const release = (): void => {
    if (released) return
    if (token !== revealToken) { released = true; return } // 已被更新的切换接管
    const left = REVEAL_MS - (performance.now() - startedAt)
    if (left > 0) { window.setTimeout(release, left + 30); return }
    released = true
    el.classList.remove('theme-switching', 'theme-reveal')
  }

  // 圆心 / 半径 / 节奏全部通过 CSS 变量交给 @keyframes，
  // JS 这边只负责算一次「到最远角的距离」当终止半径。
  // 用精确半径而不是 circle(150%)：按钮在右上角时 150% 会多出约 7% 的行程，
  // 那段多出来的半径落在屏幕外，等于让波浪提前走完、末尾白等一截。
  const { x, y } = origin
  const endRadius = Math.hypot(
    Math.max(x, window.innerWidth - x),
    Math.max(y, window.innerHeight - y)
  )
  el.style.setProperty('--vt-x', `${x}px`)
  el.style.setProperty('--vt-y', `${y}px`)
  el.style.setProperty('--vt-r', `${Math.ceil(endRadius)}px`)
  el.style.setProperty('--vt-reveal-ms', `${REVEAL_MS}ms`)
  el.style.setProperty('--vt-reveal-ease', REVEAL_EASING)

  el.classList.add('theme-switching')
  el.classList.add('theme-reveal')

  const transition = doc.startViewTransition(() => { applyTheme(t) })
  // 现在动画是挂在伪元素上的 CSS 动画，属于过渡自身的动画集，
  // transition.finished 会老老实实等到 900ms 后才 resolve。
  transition.finished.then(release, release)
  // 兜底：极端情况下 finished 不 resolve 也确保守卫会摘掉。
  window.setTimeout(release, REVEAL_MS + 1200)
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
