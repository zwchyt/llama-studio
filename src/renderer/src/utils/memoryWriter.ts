// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 长期记忆写入器（memoryWriter）—— 模块二「记忆系统」阶段 2.3 的渲染层触发端      ║
// ║                                                                              ║
// ║ 四个沉淀触发点（全部机械提取、不经 LLM 转写，火忘式提交给主进程 memoryStore）：  ║
// ║   ① 事件即时写：用户纠正原话 / 审批拒绝 → correction 条目（source=user）        ║
// ║   ② 里程碑写：Todo 计划全部 completed → decision 条目                          ║
// ║   ③ 压缩伴生写：被压缩批次中的已验证命令 / 改动热点 → command / file_role 条目  ║
// ║   ④ 会话终局写：切换会话 / 项目时对旧会话做机械提炼 → decision 条目             ║
// ║ 另提供矛盾探针：Bash 实测失败时对相似的「已验证命令」条目记矛盾标记。            ║
// ║ 所有写入去重合并由存储侧负责（相似条目 hits+1，不重复新增），此处只管产出候选。  ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
import type { AgentMemoryCandidate, AgentMessage, TodoUpdate } from '../../../shared/types'
import { agentConfig } from './agentConfig'

// 单条候选正文上限（与存储侧 CONTENT_CAP 对齐方向，此处先裁一刀）
const CANDIDATE_TEXT_CAP = 300
// 压缩伴生写单次最多沉淀的命令条目数
const CONDENSE_COMMAND_CAP = 3
// 会话终局写的最低消息数门槛（太短的会话没有沉淀价值）
const SESSION_END_MIN_MSGS = 4

// ── 基础工具 ──

// 火忘式提交：任何失败都不得影响 agent 主循环
function submit(dir: string, candidates: AgentMemoryCandidate[]): void {
  if (!agentConfig.longTermMemoryEnabled || !dir || candidates.length === 0) return
  window.api?.memstoreUpsert?.(dir, candidates).catch(() => { })
}

// 把工具参数里的路径规整为工作区相对路径（作校验锚点）；工作区外 / 绝对盘符路径不做锚点
function toWorkspaceRel(dir: string, p: string): string | undefined {
  if (!p) return undefined
  const normDir = dir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const normP = p.replace(/\\/g, '/')
  if (normP.toLowerCase().startsWith(normDir + '/')) return normP.slice(normDir.length + 1)
  if (/^[a-zA-Z]:\//.test(normP) || normP.startsWith('/')) return undefined
  return normP.replace(/^\.\//, '')
}

function parseArgs(argsJson: string): Record<string, unknown> {
  try { return JSON.parse(argsJson || '{}') } catch { return {} }
}

// ── 触发点 ①a：审批拒绝即时写 ──
// 一次拒绝 = 一条偏好信号：沉淀「用户拒绝过哪类操作」，供下个会话提前预警措辞。
// 红线：仅用于措辞与方案预警，注入文案不构成跳过审批的依据。
export function noteApprovalRejected(dir: string, sid: string, toolName: string, argsJson: string): void {
  const args = parseArgs(argsJson)
  const path = typeof args.file_path === 'string' ? args.file_path : typeof args.path === 'string' ? args.path : ''
  const cmd = typeof args.command === 'string' ? args.command : ''
  const target = cmd ? `命令「${cmd.slice(0, 120)}」` : path ? `文件 ${path.slice(0, 120)}` : '（无参数摘要）'
  submit(dir, [{
    category: 'correction',
    content: `用户拒绝过 ${toolName} 操作（${target}）。同类操作应先说明意图与影响，再征求同意`,
    source: 'user',
    origin: `approval-rejected:${sid}`,
    confidence: 0.8,
    ...(path ? { anchorPath: toWorkspaceRel(dir, path) } : {}),
  }])
}

// ── 触发点 ①b：用户纠正即时写 ──
// 轻量启发式：短消息 + 纠正/约束语气词。原话逐字保留（禁止转述），锚点无从谈起故不设。
const CORRECTION_PATTERN = /不对|不是这样|错了|搞错|别再|不要再|不许|撤销|改回|回退|记住|以后都|下次|应该用|应该改|改成|不准|禁止/

export function noteUserCorrection(dir: string, sid: string, text: string): void {
  const t = (text || '').trim()
  if (!t || t.length > 400 || !CORRECTION_PATTERN.test(t)) return
  submit(dir, [{
    category: 'correction',
    content: `用户纠正 / 约束（原话）：「${t.slice(0, CANDIDATE_TEXT_CAP)}」`,
    source: 'user',
    origin: `user-correction:${sid}`,
    confidence: 0.9,
  }])
}

// ── 触发点 ②：里程碑写（Todo 计划全部 completed）──
export function noteMilestone(dir: string, sid: string, planTitle: string, todos: TodoUpdate[]): void {
  const done = todos.filter(t => t.status === 'completed')
  if (done.length === 0) return
  const items = done.map(t => t.content).filter(Boolean).slice(0, 6).join('；')
  submit(dir, [{
    category: 'decision',
    content: `已完成计划${planTitle ? `「${planTitle.slice(0, 60)}」` : ''}：${items}`.slice(0, CANDIDATE_TEXT_CAP),
    source: 'agent',
    origin: `todo-milestone:${sid}`,
    confidence: 0.55,
  }])
}

// ── 触发点 ③：压缩伴生写 ──
// 被压缩批次里匹配长期类别的结构化事实：已验证命令（成功 Bash 的构建/运行/测试类）
// 与改动热点文件（Write/Edit 成功目标）。摘要正文交给 LLM，这些事实走机械通道。
const VERIFIED_CMD_PATTERN = /^(npm|npx|pnpm|yarn|node|python3?|pip3?|cargo|go|make|tsc|vite|electron|dotnet|mvn|gradle|cmake|pytest|jest)\b/i

export function noteCondenseFacts(dir: string, sid: string, batch: AgentMessage[]): void {
  const candidates: AgentMemoryCandidate[] = []
  const seenCmds = new Set<string>()
  const editedFiles = new Set<string>()
  for (const m of batch) {
    if (m.role !== 'assistant' || !m.toolCalls) continue
    for (const tc of m.toolCalls) {
      if (tc.status !== 'done' || tc.failed) continue
      const args = parseArgs(tc.args)
      if (tc.name === 'Bash' && typeof args.command === 'string') {
        const cmd = args.command.trim()
        if (VERIFIED_CMD_PATTERN.test(cmd) && !seenCmds.has(cmd) && seenCmds.size < CONDENSE_COMMAND_CAP) {
          seenCmds.add(cmd)
          candidates.push({
            category: 'command',
            content: `已验证可用命令：\`${cmd.slice(0, 200)}\``,
            source: 'agent',
            origin: `condense:${sid}`,
            confidence: 0.5,
          })
        }
      } else if (tc.name === 'Write' || tc.name === 'Edit') {
        const p = typeof args.file_path === 'string' ? args.file_path : typeof args.path === 'string' ? args.path : ''
        const rel = toWorkspaceRel(dir, p)
        if (rel) editedFiles.add(rel)
      }
    }
  }
  if (editedFiles.size >= 2) {
    const list = Array.from(editedFiles).slice(0, 5)
    candidates.push({
      category: 'file_role',
      content: `近期改动热点文件：${list.join('、')}`.slice(0, CANDIDATE_TEXT_CAP),
      source: 'agent',
      origin: `condense:${sid}`,
      confidence: 0.4,
      anchorPath: list[0],
    })
  }
  submit(dir, candidates)
}

// ── 触发点 ④：会话终局写（切换会话 / 项目时对旧会话机械提炼）──
// 仅在会话有实质产出（≥1 次写/改/删成功）且长度达门槛时沉淀，避免噪声条目。
export function noteSessionEnd(dir: string, sid: string, title: string, messages: AgentMessage[]): void {
  if (messages.length < SESSION_END_MIN_MSGS) return
  const touched = new Set<string>()
  for (const m of messages) {
    if (m.role !== 'assistant' || !m.toolCalls) continue
    for (const tc of m.toolCalls) {
      if (tc.status !== 'done' || tc.failed) continue
      if (tc.name !== 'Write' && tc.name !== 'Edit' && tc.name !== 'Delete') continue
      const args = parseArgs(tc.args)
      const p = typeof args.file_path === 'string' ? args.file_path : typeof args.path === 'string' ? args.path : ''
      const rel = toWorkspaceRel(dir, p)
      if (rel) touched.add(rel)
    }
  }
  if (touched.size === 0) return
  // 结论取最后一条非空助手正文的首段（机械截取，不经转写）
  let conclusion = ''
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role === 'assistant' && m.content.trim()) {
      conclusion = m.content.trim().split('\n').find(l => l.trim()) || ''
      break
    }
  }
  const files = Array.from(touched).slice(0, 5).join('、')
  submit(dir, [{
    category: 'decision',
    content: `会话「${title.slice(0, 40)}」改动了 ${files}${conclusion ? `；结论：${conclusion.slice(0, 140)}` : ''}`.slice(0, CANDIDATE_TEXT_CAP),
    source: 'agent',
    origin: `session-end:${sid}`,
    confidence: 0.45,
    anchorPath: Array.from(touched)[0],
  }])
}

// ── 矛盾探针：实测打脸 ──
// 依记忆推荐的「已验证命令」在实测中失败 → 对相似条目记矛盾标记（降置信度，累计两次归档）。
export function probeContradiction(dir: string, probeText: string): void {
  if (!agentConfig.longTermMemoryEnabled || !dir) return
  const t = (probeText || '').trim()
  if (!t) return
  window.api?.memstoreContradict?.(dir, t.slice(0, 300)).catch(() => { })
}
