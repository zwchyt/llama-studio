// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 安全校验纯函数层（零 electron 依赖，可被单元测试直接导入）                     ║
// ║ 从 ipc.ts / memoryStore.ts 抽出；修改时必须保持行为等价，                     ║
// ║ 回归锁定：tests/audit/security.path.test.ts、security.url.test.ts            ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
import { join, resolve, relative, isAbsolute } from 'path'
import { homedir } from 'os'
import { promises as dnsPromises } from 'dns'

// ── 读侧边界：禁止读取的敏感/系统根目录（绝对路径，匹配前缀即拒绝）──
export const FORBID_READ_ROOTS: string[] = [
  'C:\\Windows', 'C:\\Program Files', 'C:\\ProgramData',
  '/etc', '/proc', '/sys', '/boot', '/usr/lib', '/Library'
]

// 用户主目录下的凭证/敏感目录：agent 可读工作区外文件是产品语义，
// 但 SSH/AWS/浏览器凭据等不该进模型上下文（防提示注入外传）
export function sensitiveReadRoots(): string[] {
  try {
    const home = homedir()
    return ['.ssh', '.aws', '.azure', '.config/gcloud', '.gnupg', '.docker',
      'AppData/Local/Google/Chrome/User Data', 'AppData/Local/Microsoft/Edge/User Data',
      'AppData/Roaming/Mozilla/Firefox/Profiles'].map(seg => join(home, seg))
  } catch { return [] }
}

export function confineRead(target: string): boolean {
  const norm = resolve(target).toLowerCase()
  // UNC 网络路径：与写/搜类 handler 同策略拒绝（防 NTLM 凭据外发）
  if (norm.startsWith('\\\\') || norm.startsWith('//')) return true
  return [...FORBID_READ_ROOTS, ...sensitiveReadRoots()].some(r => norm.startsWith(r.toLowerCase()))
}

// ── 内网/保留地址判定：IPv4 点分十进制 + IPv6 常见形态（::1、链路本地 fe80::/10、
// ULA fc00::/7、IPv4 映射 ::ffff:0:0/96）。覆盖 0/8、10/8、127/8、169.254/16（含云元数据）、
// 172.16/12 全段、192.168/16、100.64/10（CGNAT）
export function isPrivateIp(ip: string): boolean {
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const a = Number(v4[1])
    const b = Number(v4[2])
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    return false
  }
  const low = ip.toLowerCase().split('%')[0]
  if (low === '::' || low === '::1') return true
  if (low.startsWith('::ffff:')) return isPrivateIp(low.slice(7))
  if (low.startsWith('fe80:') || low.startsWith('fc') || low.startsWith('fd')) return true
  return false
}

export function validateUrl(url: string): void {
  if (/\\/.test(url)) throw new Error('URL 中包含反斜杠')
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('不支持的协议')
  if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '0.0.0.0' ||
      parsed.hostname.startsWith('192.168.') || parsed.hostname.startsWith('10.') ||
      parsed.hostname.startsWith('172.16.')) throw new Error('不允许访问内网地址')
}

// validateUrl 的异步加强版：在既有字符串级检查之上，对域名解析出的全部 A/AAAA 记录
// 逐一判定内网地址，封死「校验时公网、连接时内网」的 DNS 重绑定窗口；解析失败一律拒绝。
export async function validateUrlAsync(url: string): Promise<void> {
  validateUrl(url)
  let host: string
  try { host = new URL(url).hostname.replace(/^\[|\]$/g, '') } catch { throw new Error('无效 URL') }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) {
    if (isPrivateIp(host)) throw new Error('不允许访问内网地址')
    return
  }
  const records = await dnsPromises.lookup(host, { all: true }).catch(() => null)
  if (!records || records.length === 0) throw new Error('域名解析失败')
  for (const r of records) {
    if (isPrivateIp(r.address)) throw new Error('不允许访问内网地址')
  }
}

// ── 锚点路径收敛（memoryStore 用）：anchorPath 由模型生成（可被提示注入诱导），
// 拒绝越出工作区的路径（../、绝对路径、盘符切换）
export function anchorAbsWithin(dir: string, anchorPath: string): string | null {
  const abs = resolve(dir, anchorPath)
  const rel = relative(dir, abs)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
  return abs
}

// 写入侧收敛：越界 anchorPath 直接丢弃（不落库），盘内路径规范化为 / 分隔
export function sanitizeAnchorPath(dir: string, anchorPath?: string): string | undefined {
  if (!anchorPath) return undefined
  const abs = anchorAbsWithin(dir, anchorPath)
  if (!abs) return undefined
  return relative(dir, abs).replace(/\\/g, '/')
}
