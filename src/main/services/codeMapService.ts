// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 认知地图服务（codeMapService）—— 模块一「上下文感知引擎」的主进程基座          ║
// ║                                                                              ║
// ║ 职责：为每个 Agent 工作区维护一份「轻量级认知地图」：                          ║
// ║   · 文件骨架层：每文件仅存符号签名 + import 清单（不存文件体）                 ║
// ║   · 符号索引层：符号名 → 定义位置（精确 + 前缀查询）                          ║
// ║   · 依赖图层：相对导入解析为文件级有向边（正向/反向按需查询）                  ║
// ║ 失效流水线：fs.watch 去抖批量增量重解析 + 渲染层工具写钩子同步失效；           ║
// ║ 变更占比超阈值（如 git 切分支）自动退化为全量重扫。                            ║
// ║ 快照：按工作区路径哈希落盘，二次启动仅按 mtime/size 校验、跳过未变文件。       ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
import { ipcMain } from 'electron'
import { join, resolve, relative, dirname, extname, sep } from 'path'
import { createHash } from 'crypto'
import {
  existsSync, mkdirSync, readdirSync, statSync, readFileSync, writeFileSync,
  watch, type FSWatcher,
} from 'fs'
import type {
  CodeMapFileSkeleton, CodeMapStatus, CodeMapSymbol, CodeMapSymbolHit, CodeMapNeighbors,
} from '../../shared/types'

// ── 容量护栏：保证超大项目下地图构建时间与内存可控 ──
const MAX_FILES = 6000            // 单工作区最多索引的文件数
const FILE_SIZE_CAP = 512 * 1024  // 超过此大小的文件只记指纹、不解析符号
const MAX_SYMBOLS_PER_FILE = 200
const MAX_IMPORTS_PER_FILE = 100
const SIGNATURE_CAP = 160         // 符号签名（声明行原文）截断长度
const BATCH_SIZE = 25             // 每解析 N 个文件让出一次事件循环，避免阻塞主进程
const WATCH_DEBOUNCE_MS = 600     // 监视事件去抖窗口
const FULL_RESCAN_RATIO = 0.3     // 单窗口变更文件占比超此值 → 放弃增量、全量重扫
const SNAPSHOT_DEBOUNCE_MS = 5000 // 增量落盘去抖：避免每次文件保存都同步序列化整张地图
const SNAPSHOT_VERSION = 2  // v2：收紧函数式 const 识别规则，需强制重解析旧快照

// 与 list-flat-files 的噪声目录跳过集合对齐，另加本应用自身的数据目录
// （工作区可能就是 llama-studio 仓库本身，避免把会话/模型数据卷进地图）
const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.hg', '.svn', 'dist', 'build', 'out', '.cache',
  '__pycache__', '.venv', 'venv', 'target', '.next', '.nuxt', 'coverage',
  'Agent session', 'models', 'backend', 'chats',
])

// 参与符号解析的代码扩展名；集合外的文件不进地图（图片/二进制/锁文件等）
const CODE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte',
  '.py', '.go', '.rs', '.java', '.cs', '.c', '.h', '.cpp', '.hpp', '.cc',
  '.rb', '.php', '.swift', '.kt', '.lua',
  '.css', '.scss', '.less', '.json', '.md', '.yml', '.yaml', '.toml',
])
// 只记录指纹、不做符号提取的「数据/样式」类扩展名
const NO_SYMBOL_EXTS = new Set(['.css', '.scss', '.less', '.json', '.yml', '.yaml', '.toml'])

interface WorkspaceMap {
  dir: string                              // resolve 后的工作区根
  files: Map<string, CodeMapFileSkeleton>  // relPath → 骨架
  symbolIndex: Map<string, CodeMapSymbolHit[]>  // 小写符号名 → 命中列表
  state: CodeMapStatus['state']
  filesIndexed: number
  totalFiles: number
  builtAt?: number
  fromSnapshot: boolean
  error?: string
  building: boolean
  watcher: FSWatcher | null
  pendingChanges: Set<string>              // 去抖窗口内累积的变更 relPath
  debounceTimer: NodeJS.Timeout | null
  snapshotTimer: NodeJS.Timeout | null     // 增量快照落盘去抖定时器
}

const maps = new Map<string, WorkspaceMap>()
let snapshotDir = ''

// ── 基础工具 ──

function toRel(root: string, abs: string): string {
  return relative(root, abs).split(sep).join('/')
}

function sha1(text: string): string {
  return createHash('sha1').update(text).digest('hex')
}

function isSafeInside(base: string, target: string): boolean {
  const rBase = resolve(base)
  const rTarget = resolve(target)
  return rTarget === rBase || rTarget.startsWith(rBase + sep)
}

function snapshotPathFor(dir: string): string {
  return join(snapshotDir, `${sha1(resolve(dir).toLowerCase())}.json`)
}

// 增量入口准入：与 collectFiles 的全量准入标准完全一致（逐段目录检查，而非只看第一层）。
// watcher 事件与 codemap-invalidate 写钩子都必须过此关，否则 dist/ 产物、嵌套
// node_modules、非代码文件会污染地图，进而进快照与检索索引。
function isEligible(rel: string): boolean {
  if (!rel) return false
  const parts = rel.split('/')
  for (let i = 0; i < parts.length - 1; i++) {
    if (SKIP_DIRS.has(parts[i]) || parts[i].startsWith('.')) return false
  }
  const name = parts[parts.length - 1]
  if (name.startsWith('.')) return false
  return CODE_EXTS.has(extname(name).toLowerCase())
}

// ── 符号 / import 提取（正则启发式，非完整解析器；覆盖主流声明形态即可）──

interface LangRule { symbol: RegExp; kind: CodeMapSymbol['kind']; nameGroup: number; exportGroup?: number }

const JS_RULES: LangRule[] = [
  { symbol: /^\s*(export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, kind: 'function', nameGroup: 2, exportGroup: 1 },
  { symbol: /^\s*(export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: 'class', nameGroup: 2, exportGroup: 1 },
  { symbol: /^\s*(export\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: 'interface', nameGroup: 2, exportGroup: 1 },
  { symbol: /^\s*(export\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^=]*)?=/, kind: 'type', nameGroup: 2, exportGroup: 1 },
  { symbol: /^\s*(export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: 'enum', nameGroup: 2, exportGroup: 1 },
  // 函数式 const：仅当右值确为箭头函数（参数表+=>）或 function 表达式时才计入，
  // 避免 `const x = (a.b() || 0) + 1` 这类普通括号表达式被误判为函数声明
  { symbol: /^\s*(export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*(?::[^=>{]{0,80})?=>|[A-Za-z_$][\w$]*\s*=>)/, kind: 'function', nameGroup: 2, exportGroup: 1 },
  // 仅收录「导出的」普通 const/let，未导出的局部常量噪声太大
  { symbol: /^\s*(export)\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/, kind: 'const', nameGroup: 2, exportGroup: 1 },
]

const PY_RULES: LangRule[] = [
  { symbol: /^(?:async\s+)?def\s+(\w+)/, kind: 'function', nameGroup: 1 },
  { symbol: /^class\s+(\w+)/, kind: 'class', nameGroup: 1 },
  // 一级缩进的方法（类成员），名称保持裸方法名
  { symbol: /^\s{4}(?:async\s+)?def\s+(\w+)/, kind: 'function', nameGroup: 1 },
]

const GENERIC_RULES: LangRule[] = [
  { symbol: /^\s*(pub\s+)?(?:async\s+)?fn\s+(\w+)/, kind: 'function', nameGroup: 2, exportGroup: 1 },                 // rust
  { symbol: /^func\s+(?:\([^)]*\)\s*)?(\w+)/, kind: 'function', nameGroup: 1 },                                       // go
  { symbol: /^type\s+(\w+)\s+(?:struct|interface)/, kind: 'class', nameGroup: 1 },                                    // go
  { symbol: /^\s*(pub\s+)?(?:struct|enum|trait)\s+(\w+)/, kind: 'class', nameGroup: 2, exportGroup: 1 },              // rust
  { symbol: /^\s*(?:public|internal|protected)?\s*(?:abstract\s+|sealed\s+|static\s+|final\s+)*(?:class|interface|enum|record)\s+(\w+)/, kind: 'class', nameGroup: 1 }, // java / c#
]

const JS_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte'])

function rulesFor(ext: string): LangRule[] {
  if (JS_EXTS.has(ext)) return JS_RULES
  if (ext === '.py') return PY_RULES
  return GENERIC_RULES
}

// import 说明符提取：JS 系（import/export-from/require）与 Python（import/from）
function extractImports(ext: string, lines: string[]): string[] {
  const specs: string[] = []
  const push = (s: string | undefined) => { if (s && specs.length < MAX_IMPORTS_PER_FILE && !specs.includes(s)) specs.push(s) }
  if (JS_EXTS.has(ext)) {
    for (const l of lines) {
      const im = /^\s*import\s+[^'"]*['"]([^'"]+)['"]/.exec(l) || /^\s*import\s*['"]([^'"]+)['"]/.exec(l)
      if (im) { push(im[1]); continue }
      const ex = /^\s*export\s+[^'"]*\bfrom\s*['"]([^'"]+)['"]/.exec(l)
      if (ex) { push(ex[1]); continue }
      const rq = /require\(\s*['"]([^'"]+)['"]\s*\)/.exec(l)
      if (rq) push(rq[1])
    }
  } else if (ext === '.py') {
    for (const l of lines) {
      const m = /^import\s+([\w.]+)/.exec(l) || /^from\s+([\w.]+)\s+import/.exec(l)
      if (m) push(m[1])
    }
  }
  return specs
}

function extractSymbols(ext: string, lines: string[]): CodeMapSymbol[] {
  const out: CodeMapSymbol[] = []
  if (NO_SYMBOL_EXTS.has(ext)) return out
  if (ext === '.md') {
    // Markdown：标题即「符号」，供文档结构级检索
    for (let i = 0; i < lines.length && out.length < MAX_SYMBOLS_PER_FILE; i++) {
      const m = /^(#{1,4})\s+(.+)/.exec(lines[i])
      if (m) out.push({ name: m[2].trim().slice(0, 80), kind: 'section', line: i + 1, exported: true })
    }
    return out
  }
  const rules = rulesFor(ext)
  const seen = new Set<string>()
  for (let i = 0; i < lines.length && out.length < MAX_SYMBOLS_PER_FILE; i++) {
    const line = lines[i]
    if (!line || line.length > 500) continue
    for (const r of rules) {
      const m = r.symbol.exec(line)
      if (!m) continue
      const name = m[r.nameGroup]
      if (!name) continue
      const key = `${name}:${r.kind}:${i}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({
        name,
        kind: r.kind,
        line: i + 1,
        exported: r.exportGroup != null ? !!m[r.exportGroup] : true,
        signature: line.trim().slice(0, SIGNATURE_CAP),
      })
      break // 单行只归入首个命中的规则
    }
  }
  return out
}

// ── 单文件解析 → 骨架记录 ──

function parseFile(root: string, relPath: string): CodeMapFileSkeleton | null {
  const abs = join(root, relPath)
  let st
  try { st = statSync(abs) } catch { return null }
  if (!st.isFile()) return null
  const ext = extname(relPath).toLowerCase()
  const base: CodeMapFileSkeleton = {
    relPath, lang: ext, size: st.size, mtimeMs: st.mtimeMs, hash: '', symbols: [], imports: [],
  }
  if (st.size > FILE_SIZE_CAP) {
    // 超大文件：仅记指纹（size+mtime 复合），不读内容
    base.hash = `oversize:${st.size}:${Math.floor(st.mtimeMs)}`
    return base
  }
  let content: string
  try { content = readFileSync(abs, 'utf-8') } catch { return null }
  base.hash = sha1(content)
  const lines = content.split('\n')
  base.symbols = extractSymbols(ext, lines)
  base.imports = extractImports(ext, lines)
  return base
}

// 相对 import 说明符 → 地图内 relPath（尝试补扩展名 / index 文件）
const RESOLVE_SUFFIXES = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '.py',
  '/index.ts', '/index.tsx', '/index.js', '/index.jsx']

function resolveImports(map: WorkspaceMap): void {
  for (const skel of map.files.values()) {
    skel.imports = skel.imports.map(spec => {
      if (!spec.startsWith('./') && !spec.startsWith('../')) return spec
      const baseDir = dirname(join(map.dir, skel.relPath))
      for (const suf of RESOLVE_SUFFIXES) {
        const cand = toRel(map.dir, resolve(baseDir, spec + suf))
        if (map.files.has(cand)) return cand
      }
      return spec
    })
  }
}

function rebuildSymbolIndex(map: WorkspaceMap): void {
  const idx = new Map<string, CodeMapSymbolHit[]>()
  for (const skel of map.files.values()) {
    for (const s of skel.symbols) {
      const key = s.name.toLowerCase()
      const arr = idx.get(key) ?? []
      arr.push({ name: s.name, kind: s.kind, relPath: skel.relPath, line: s.line, signature: s.signature })
      idx.set(key, arr)
    }
  }
  map.symbolIndex = idx
}

// ── 目录遍历：收集候选文件（带容量护栏）──

function collectFiles(root: string): { rels: string[]; capped: boolean } {
  const rels: string[] = []
  let capped = false
  const walk = (dir: string): void => {
    if (capped) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const e of entries) {
      if (capped) return
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue
        walk(full)
      } else if (e.isFile()) {
        if (e.name.startsWith('.')) continue // 隐藏文件（如测试产物 .xx.cjs）不进地图
        if (!CODE_EXTS.has(extname(e.name).toLowerCase())) continue
        if (rels.length >= MAX_FILES) { capped = true; return }
        rels.push(toRel(root, full))
      }
    }
  }
  walk(root)
  return { rels, capped }
}

// ── 快照持久化 ──

interface Snapshot { version: number; dir: string; builtAt: number; files: CodeMapFileSkeleton[] }

function saveSnapshot(map: WorkspaceMap): void {
  try {
    if (!existsSync(snapshotDir)) mkdirSync(snapshotDir, { recursive: true })
    const snap: Snapshot = { version: SNAPSHOT_VERSION, dir: map.dir, builtAt: map.builtAt ?? Date.now(), files: [...map.files.values()] }
    writeFileSync(snapshotPathFor(map.dir), JSON.stringify(snap))
  } catch { /* 快照失败不影响内存地图可用性 */ }
}

function loadSnapshot(dir: string): Map<string, CodeMapFileSkeleton> | null {
  try {
    const p = snapshotPathFor(dir)
    if (!existsSync(p)) return null
    const snap = JSON.parse(readFileSync(p, 'utf-8')) as Snapshot
    if (snap.version !== SNAPSHOT_VERSION || resolve(snap.dir) !== resolve(dir)) return null
    const m = new Map<string, CodeMapFileSkeleton>()
    for (const f of snap.files) { if (f && typeof f.relPath === 'string') m.set(f.relPath, f) }
    return m
  } catch { return null }
}

// ── 构建（全量 / 快照校验式增量）──

function getOrCreate(dir: string): WorkspaceMap {
  const key = resolve(dir)
  let m = maps.get(key)
  if (!m) {
    m = {
      dir: key, files: new Map(), symbolIndex: new Map(),
      state: 'idle', filesIndexed: 0, totalFiles: 0, fromSnapshot: false,
      building: false, watcher: null, pendingChanges: new Set(), debounceTimer: null,
      snapshotTimer: null,
    }
    maps.set(key, m)
  }
  return m
}

async function buildMap(dir: string): Promise<void> {
  const map = getOrCreate(dir)
  if (map.building) return
  map.building = true
  map.state = 'building'
  map.error = undefined
  try {
    const { rels } = collectFiles(map.dir)
    map.totalFiles = rels.length
    map.filesIndexed = 0
    const prev = loadSnapshot(map.dir)
    map.fromSnapshot = !!prev
    const next = new Map<string, CodeMapFileSkeleton>()
    let batch = 0
    for (const rel of rels) {
      // 快照校验：mtime + size 未变 → 直接复用旧骨架，跳过读盘与解析
      const old = prev?.get(rel) ?? map.files.get(rel)
      if (old) {
        try {
          const st = statSync(join(map.dir, rel))
          if (st.mtimeMs === old.mtimeMs && st.size === old.size) {
            next.set(rel, old)
            map.filesIndexed++
            continue
          }
        } catch { continue }
      }
      const skel = parseFile(map.dir, rel)
      if (skel) next.set(rel, skel)
      map.filesIndexed++
      if (++batch >= BATCH_SIZE) { batch = 0; await new Promise<void>(r => setImmediate(r)) }
    }
    map.files = next
    resolveImports(map)
    rebuildSymbolIndex(map)
    map.state = 'ready'
    map.builtAt = Date.now()
    saveSnapshot(map)
    startWatcher(map)
  } catch (e) {
    map.state = 'error'
    map.error = e instanceof Error ? e.message : String(e)
  } finally {
    map.building = false
    // 构建期间积压的变更不能丢：构建里逐文件的 mtime 校验可能已用旧内容入图，
    // 结束后立刻重放一遍积压队列，保证地图收敛到最新状态
    if (map.pendingChanges.size > 0) {
      if (map.debounceTimer) clearTimeout(map.debounceTimer)
      map.debounceTimer = setTimeout(() => flushChanges(map), WATCH_DEBOUNCE_MS)
    }
  }
}

// ── 失效流水线：fs.watch 去抖 + 增量重解析 ──

function startWatcher(map: WorkspaceMap): void {
  if (map.watcher) return
  try {
    const w = watch(
      map.dir,
      process.platform === 'win32' || process.platform === 'darwin' ? { recursive: true } : {},
      (_ev, filename) => {
        if (typeof filename !== 'string' || !filename) return
        const rel = filename.split(sep).join('/')
        // 噪声目录（任意层级）/ 隐藏文件 / 非代码文件的事件直接丢弃
        if (!isEligible(rel)) return
        map.pendingChanges.add(rel)
        if (map.debounceTimer) clearTimeout(map.debounceTimer)
        map.debounceTimer = setTimeout(() => flushChanges(map), WATCH_DEBOUNCE_MS)
      }
    )
    w.on('error', () => { /* 目录被删除等瞬时错误，忽略 */ })
    map.watcher = w
  } catch { /* 监视不可用时地图退化为「工具写钩子 + 手动 build」模式 */ }
}

function flushChanges(map: WorkspaceMap): void {
  map.debounceTimer = null
  if (map.pendingChanges.size === 0) return
  // 构建进行中：不清空积压（否则该批变更被永久丢弃、地图静默陈旧），
  // 延后重试；buildMap 的 finally 也会补一次调度，双保险
  if (map.building) {
    map.debounceTimer = setTimeout(() => flushChanges(map), WATCH_DEBOUNCE_MS)
    return
  }
  const changed = [...map.pendingChanges]
  map.pendingChanges.clear()
  // 批量场景（git 切分支等）：变更占比过高 → 全量重扫更划算
  if (map.files.size > 0 && changed.length / map.files.size > FULL_RESCAN_RATIO) {
    void buildMap(map.dir)
    return
  }
  applyIncremental(map, changed)
}

// 增量应用：逐文件重解析（新增/修改），已删除的移除记录；随后重建符号索引
function applyIncremental(map: WorkspaceMap, rels: string[]): void {
  let dirty = false
  for (const rel of rels) {
    if (!isEligible(rel)) continue // 与全量扫描同一准入标准，防止增量路径污染地图
    const abs = join(map.dir, rel)
    if (!existsSync(abs)) {
      if (map.files.delete(rel)) dirty = true
      continue
    }
    const old = map.files.get(rel)
    if (!old && map.files.size >= MAX_FILES) continue // 容量护栏对增量新增同样生效
    const skel = parseFile(map.dir, rel)
    if (!skel) continue
    // 哈希未变的触碰（仅 mtime 变化）不触发下游重建
    if (old && old.hash === skel.hash) { map.files.set(rel, skel); continue }
    map.files.set(rel, skel)
    dirty = true
  }
  if (dirty) {
    resolveImports(map)
    rebuildSymbolIndex(map)
    map.builtAt = Date.now()
    scheduleSnapshot(map) // 热路径不做同步全量落盘，去抖合并
  }
}

// 快照落盘去抖：多次增量合并为一次序列化；已排队则等它到期（自然合并后续变更）
function scheduleSnapshot(map: WorkspaceMap): void {
  if (map.snapshotTimer) return
  map.snapshotTimer = setTimeout(() => {
    map.snapshotTimer = null
    saveSnapshot(map)
  }, SNAPSHOT_DEBOUNCE_MS)
}

function statusOf(map: WorkspaceMap): CodeMapStatus {
  let symbolCount = 0
  for (const hits of map.symbolIndex.values()) symbolCount += hits.length
  return {
    workspaceDir: map.dir,
    state: map.state,
    filesIndexed: map.filesIndexed,
    totalFiles: map.totalFiles,
    symbolCount,
    builtAt: map.builtAt,
    fromSnapshot: map.fromSnapshot,
    error: map.error,
  }
}

// ── IPC 注册（由 ipc.ts 的 registerIpcHandlers 调用）──

export function registerCodeMapIpc(appRoot: string): void {
  snapshotDir = join(appRoot, 'Agent session', 'codemap')

  // 触发构建（幂等：building 中或已 ready 且监视在线则直接返回现状）
  ipcMain.handle('codemap-build', (_e, dir: string): CodeMapStatus | { error: string } => {
    if (!dir || !existsSync(dir)) return { error: '目录不存在' }
    const map = getOrCreate(dir)
    if (!map.building && map.state !== 'ready') void buildMap(dir)
    return statusOf(map)
  })

  ipcMain.handle('codemap-status', (_e, dir: string): CodeMapStatus => {
    return statusOf(getOrCreate(dir))
  })

  // 符号查询：精确命中优先，余量按前缀补足
  ipcMain.handle('codemap-symbol', (_e, dir: string, name: string, limit?: number): CodeMapSymbolHit[] => {
    const map = getOrCreate(dir)
    const cap = Math.max(1, Math.min(limit ?? 20, 100))
    const q = String(name || '').toLowerCase()
    if (!q) return []
    const out: CodeMapSymbolHit[] = [...(map.symbolIndex.get(q) ?? [])]
    if (out.length < cap) {
      for (const [key, hits] of map.symbolIndex) {
        if (out.length >= cap) break
        if (key !== q && key.startsWith(q)) out.push(...hits.slice(0, cap - out.length))
      }
    }
    return out.slice(0, cap)
  })

  ipcMain.handle('codemap-skeleton', (_e, dir: string, relPath: string): CodeMapFileSkeleton | null => {
    const map = getOrCreate(dir)
    return map.files.get(String(relPath || '').split(sep).join('/')) ?? null
  })

  // 依赖邻居：正向直接读 imports；反向全表扫描（≤MAX_FILES 规模下开销可忽略）
  ipcMain.handle('codemap-neighbors', (_e, dir: string, relPath: string): CodeMapNeighbors => {
    const map = getOrCreate(dir)
    const rel = String(relPath || '').split(sep).join('/')
    const self = map.files.get(rel)
    const dependsOn = (self?.imports ?? []).filter(i => map.files.has(i))
    const dependedBy: string[] = []
    for (const [p, skel] of map.files) {
      if (p !== rel && skel.imports.includes(rel)) dependedBy.push(p)
    }
    return { relPath: rel, dependsOn, dependedBy }
  })

  // 工具写钩子：Write/Edit/Delete 成功后由渲染层同步失效，不等 fs.watch 回调
  ipcMain.handle('codemap-invalidate', (_e, dir: string, absPaths: string[]): { success: boolean } => {
    const map = getOrCreate(dir)
    if (map.state !== 'ready' || !Array.isArray(absPaths)) return { success: false }
    const rels = absPaths
      .filter(p => typeof p === 'string' && isSafeInside(map.dir, p))
      .map(p => toRel(map.dir, resolve(p)))
    if (rels.length) applyIncremental(map, rels)
    return { success: true }
  })
}

// 应用退出前收尾：关闭全部监视器；未落盘的去抖快照立即冲刷
export function disposeCodeMaps(): void {
  for (const m of maps.values()) {
    if (m.debounceTimer) clearTimeout(m.debounceTimer)
    if (m.snapshotTimer) { clearTimeout(m.snapshotTimer); m.snapshotTimer = null; saveSnapshot(m) }
    if (m.watcher) { try { m.watcher.close() } catch { /* ignore */ } m.watcher = null }
  }
}

// ── 供检索服务（retrievalService）复用地图数据 ──

/** 已就绪工作区的骨架表（relPath → 骨架）；未就绪返回 null */
export function getMapFiles(dir: string): ReadonlyMap<string, CodeMapFileSkeleton> | null {
  const m = maps.get(resolve(dir))
  return m && m.state === 'ready' ? m.files : null
}

/** 地图构建状态（检索服务用于区分 building / 未触发） */
export function getMapState(dir: string): CodeMapStatus['state'] {
  return maps.get(resolve(dir))?.state ?? 'idle'
}
