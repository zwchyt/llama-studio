// 鼠标光标主题（多套可在「设置 → 界面」中切换）
//
// 约定：每个主题放在 src/renderer/src/assets/<主题名>/ 下，光标图片按「状态角色」命名，
// 代码通过文件名关键词自动识别角色，无需手动维护映射。
//   default.png      普通箭头
//   pointer.png      手型/链接(可点击)
//   progress.png     应用启动/后台工作
//   wait.png         忙碌(转圈)
//   not-allowed.png  禁止
//   move.png         移动
//   help.png         帮助
// 新增一套主题 = 新建文件夹 + 按上面命名放图，下拉自动出现。

export type CursorRole = 'default' | 'pointer' | 'progress' | 'wait' | 'notAllowed' | 'move' | 'help'

interface CursorRef {
  url: string
}

interface CursorScheme {
  id: string
  label: string
  cursors: Partial<Record<CursorRole, CursorRef>>
}

// 各角色的默认(回退)系统光标关键字
const FALLBACK: Record<CursorRole, string> = {
  default: 'default',
  pointer: 'pointer',
  progress: 'progress',
  wait: 'wait',
  notAllowed: 'not-allowed',
  move: 'move',
  help: 'help'
}

// 各角色对应的 CSS 变量名（在 global.css 中使用）
const VAR_NAME: Record<CursorRole, string> = {
  default: '--cursor-default',
  pointer: '--cursor-pointer',
  progress: '--cursor-progress',
  wait: '--cursor-wait',
  notAllowed: '--cursor-not-allowed',
  move: '--cursor-move',
  help: '--cursor-help'
}

// 下拉顺序（未列出的主题排到最后）；文件夹名即主题 id，
// 展示名由 prettify 自动生成（如 black-myth → Black Myth），新增主题无需改代码。
// 'native' 为“系统默认（原生）”选项，放在首位。
const ORDER = ['native', 'glass', 'black-myth', 'kami', 'simple']

// 把文件夹名美化为展示名（kebab/snake → 首字母大写的空格分隔）
function prettify(name: string): string {
  return name
    .split(/[-_]/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

function roleFromName(fileName: string): CursorRole | null {
  const n = fileName.toLowerCase()
  if (/(default|normal|arrow|select)/.test(n)) return 'default'
  if (/(pointer|link|hand)/.test(n)) return 'pointer'
  if (/(progress|app.?start|background|working.?bg)/.test(n)) return 'progress'
  if (/(wait|busy)/.test(n)) return 'wait'
  if (/(not.?allowed|unavail)/.test(n)) return 'notAllowed'
  if (/move/.test(n)) return 'move'
  if (/help/.test(n)) return 'help'
  return null
}

// 根据文件名关键词自动扫描所有主题
const modules = import.meta.glob('./assets/**/*.png', { eager: true, import: 'default' }) as Record<string, string>

const byFolder: Record<string, { role: CursorRole; url: string }[]> = {}
for (const path of Object.keys(modules)) {
  const m = path.match(/\.\/assets\/(.+)\/([^/]+)\.png$/i)
  if (!m) continue
  const folder = m[1]
  const file = m[2]
  const role = roleFromName(file)
  if (!role) continue
  ;(byFolder[folder] ||= []).push({ role, url: modules[path] })
}

export const CURSOR_SCHEMES: CursorScheme[] = [
  // “系统默认（原生）”选项：cursors 为空，applyCursorScheme 会清除所有自定义光标变量，
  // 全局回退到操作系统原生光标。放在首位作为“重置”入口。
  { id: 'native', label: '系统默认（原生）', cursors: {} },
  ...Object.keys(byFolder)
    .map(folder => {
      const cursors: Partial<Record<CursorRole, CursorRef>> = {}
      // 同一角色有多张图时取第一张
      for (const { role, url } of byFolder[folder]) {
        if (!cursors[role]) cursors[role] = { url }
      }
      return { id: folder, label: prettify(folder), cursors }
    })
    .sort((a, b) => {
      const ia = ORDER.indexOf(a.id)
      const ib = ORDER.indexOf(b.id)
      return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib)
    })
]

export const CURSOR_STORAGE_KEY = 'hexllama_cursor_scheme'

export function getCursorSchemeId(): string {
  try {
    const v = localStorage.getItem(CURSOR_STORAGE_KEY)
    if (v && CURSOR_SCHEMES.some(s => s.id === v)) return v
  } catch { /* ignore */ }
  return 'glass'
}

// 根据图片真实尺寸计算热点（不同主题尺寸 32/48/64 都能对准）
function hotspotFor(role: CursorRole, w: number, h: number): [number, number] {
  switch (role) {
    case 'default': // 箭头尖端在左上
      return [Math.max(2, Math.round(w * 0.08)), Math.max(2, Math.round(h * 0.08))]
    case 'pointer': // 手型指尖偏左上
      return [Math.round(w * 0.2), Math.round(h * 0.16)]
    default: // 其余以中心为热点
      return [Math.round(w / 2), Math.round(h / 2)]
  }
}

export function applyCursorScheme(id: string): void {
  const scheme = CURSOR_SCHEMES.find(s => s.id === id) || CURSOR_SCHEMES[0]
  const root = document.documentElement
  ;(Object.keys(VAR_NAME) as CursorRole[]).forEach(role => {
    const ref = scheme.cursors[role]
    if (!ref) {
      root.style.removeProperty(VAR_NAME[role])
      return
    }
    // 先用估算热点占位，图片加载完成后按真实尺寸校准
    const [phx, phy] = hotspotFor(role, 32, 32)
    root.style.setProperty(VAR_NAME[role], `url("${ref.url}") ${phx} ${phy}, ${FALLBACK[role]}`)
    const img = new Image()
    img.onload = () => {
      const [hx, hy] = hotspotFor(role, img.naturalWidth || 32, img.naturalHeight || 32)
      root.style.setProperty(VAR_NAME[role], `url("${ref.url}") ${hx} ${hy}, ${FALLBACK[role]}`)
    }
    img.src = ref.url
  })
}

// 模块加载时套用已保存的方案（main.tsx 中 import 本文件即生效）
applyCursorScheme(getCursorSchemeId())

// 供 UI 预览使用：返回某主题某角色的 CSS cursor 值（带估算热点）。
// 精确热点由 applyCursorScheme 在全局生效时按真实尺寸校准；此处用于设置页预览足够。
export function schemeCursorValue(id: string, role: CursorRole): string | null {
  const scheme = CURSOR_SCHEMES.find(s => s.id === id)
  const ref = scheme?.cursors[role]
  if (!ref) return null
  const [hx, hy] = hotspotFor(role, 32, 32)
  return `url("${ref.url}") ${hx} ${hy}, ${FALLBACK[role]}`
}
