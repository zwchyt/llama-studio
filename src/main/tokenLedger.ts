import { appendFileSync, readFileSync, unlinkSync, existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'

/**
 * Token 记账簿（与聊天记录完全解耦的独立持久化）。
 *
 * 每次聊天流式结束（主进程收到 usage）追加一行 JSONL；删除聊天会话
 * 不会影响本记录。文件放 CHATS_DIR 下但用 .jsonl 后缀，
 * listChatSessions 只读 .json → 互不干扰。
 */

export interface TokenUsageEntry {
  ts: number          // 请求结束时间戳
  port: number        // llama-server 端口（当时正在运行的模型）
  templateId?: string // 发起请求的模板卡 id（可选，run-model 时登记）
  modelPath?: string | null  // 当时该端口加载的模型文件路径（run-model 时从启动参数提取）
  promptTokens: number       // 本次请求完整输入（含此前历史，llama.cpp 实测）
  promptDelta?: number       // 新增输入：与同端口上一次请求相比的增长量（避免工具循环重复计费历史）
  completionTokens: number
}

let ledgerPath = ''
// 同端口上一次请求的完整输入 token（用于计算新增输入增量）
const lastPromptByPort = new Map<number, number>()

export function initTokenLedger(chatsDir: string): void {
  ledgerPath = join(chatsDir, '_token-usage.jsonl')
  const dir = dirname(ledgerPath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  // 启动时从已有记录恢复 lastPromptByPort（避免重启后首个请求记成全量）
  try {
    if (!existsSync(ledgerPath)) return
    const lines = readFileSync(ledgerPath, 'utf-8').split('\n')
    for (const line of lines) {
      const t = line.trim()
      if (!t) continue
      try {
        const p = JSON.parse(t)
        if (typeof p?.port === 'number' && typeof p?.promptTokens === 'number') {
          lastPromptByPort.set(p.port, p.promptTokens)
        }
      } catch { /* 忽略损坏行 */ }
    }
  } catch { /* 启动恢复失败不阻断 */ }
}

export function getTokenLedgerPath(): string {
  return ledgerPath
}

export function appendTokenUsage(entry: TokenUsageEntry): void {
  if (!ledgerPath) return
  try {
    // 新增输入 = 本次完整输入 - 同端口上一次完整输入；
    // 首次请求或上下文已重置（差值为负，如切换会话/模型）时按完整输入记
    const prev = lastPromptByPort.get(entry.port)
    const delta = prev === undefined ? entry.promptTokens : entry.promptTokens - prev
    const finalEntry: TokenUsageEntry = {
      ...entry,
      promptDelta: delta > 0 ? delta : entry.promptTokens,
    }
    lastPromptByPort.set(entry.port, entry.promptTokens)
    appendFileSync(ledgerPath, `${JSON.stringify(finalEntry)}\n`, 'utf-8')
  } catch { /* 记账失败不阻断生成 */ }
}

export function readTokenUsage(): TokenUsageEntry[] {
  if (!ledgerPath || !existsSync(ledgerPath)) return []
  try {
    const text = readFileSync(ledgerPath, 'utf-8')
    const out: TokenUsageEntry[] = []
    for (const line of text.split('\n')) {
      const t = line.trim()
      if (!t) continue
      try {
        const parsed = JSON.parse(t)
        if (typeof parsed?.ts === 'number') out.push(parsed)
      } catch { /* 跳过损坏行 */ }
    }
    // 旧记录（无 promptDelta）按「端口 + 模型」分组、按时间序推导：
    // 增量 = 本次完整输入 - 同组上一次完整输入（差值非正则记全量，即上下文已重置）
    if (out.some(e => typeof e.promptDelta !== 'number')) {
      const groupKey = (e: TokenUsageEntry) => `${e.port}:${e.modelPath ?? ''}`
      out.sort((a, b) => a.ts - b.ts)
      const lastByGroup = new Map<string, number>()
      for (const e of out) {
        if (typeof e.promptDelta === 'number') continue
        const key = groupKey(e)
        const prev = lastByGroup.get(key)
        const delta = prev === undefined ? e.promptTokens : e.promptTokens - prev
        e.promptDelta = delta > 0 ? delta : e.promptTokens
        lastByGroup.set(key, e.promptTokens)
      }
    }
    return out.sort((a, b) => a.ts - b.ts)
  } catch {
    return []
  }
}

export function clearTokenUsage(): void {
  if (!ledgerPath) return
  try { if (!existsSync(ledgerPath)) return; unlinkSync(ledgerPath) } catch { }
}