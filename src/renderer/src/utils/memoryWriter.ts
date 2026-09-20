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
// ║                                                                              ║
// ║ 落库方式由 agentConfig.memoryWriteMode 决定：                                  ║
// ║   'auto'    直接提交（火忘式，失败静默）                                        ║
// ║   'confirm' 先进待确认队列，用户在「记忆」面板裁决后再提交                        ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
import type { AgentMemoryCandidate, AgentMessage, TodoUpdate } from '../../../shared/types'
import { agentConfig } from './agentConfig'
import { useMemoryPendingStore } from '../store/memoryPendingStore'
import { notify } from '../store/notificationStore'

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
  // 写入前确认：候选进待确认队列，等用户在「记忆」面板裁决后再落库。
  // 刻意不用阻塞式弹窗 —— 六个触发点里有四个发生在不该被打断的时刻（发消息途中、
  // 后台压缩进行中、切换会话的瞬间、计划收束时），弹窗会把它们全变成「等用户回答」。
  // 队列则把「什么时候决定」还给用户，代价是必须给足可见性：角标 + 一条 toast。
  if (agentConfig.memoryWriteMode === 'confirm') {
    const n = useMemoryPendingStore.getState().enqueue(dir, candidates)
    // n === 0 表示全是队列里已有的重复候选，不再打扰。
    // 提示里带上队列总数：连续几条消息各沉淀一条时，后面的 toast 仍能反映积压规模。
    if (n > 0) {
      const total = useMemoryPendingStore.getState().items.length
      notify(`智能体沉淀了 ${n} 条记忆待确认（队列共 ${total} 条）`, 'info')
    }
    return
  }
  window.api?.memstoreUpsert?.(dir, candidates).catch(() => { })
}

// 把工具参数里的路径规整为工作区相对路径（作校验锚点）；工作区外 / 绝对盘符路径不做锚点
function toWorkspaceRel(dir: string, p: string): string | undefined {
  if (!p) return undefined
  const normDir = dir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const normP = p.replace(/\\/g, '/')
  if (normP.toLowerCase().startsWith(normDir + '/')) return normP.slice(normDir.length + 1)
  if (/^[a-zA-Z]:\//.test(normP) || normP.startsWith('/')) return undefined
  const rel = normP.replace(/^\.\//, '')
  // 拒绝含 .. 段的相对路径（越出工作区）；主进程 upsert/verifyAnchor 另有兜底校验
  if (!rel || rel.split('/').includes('..')) return undefined
  return rel
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

// 项目约定语气：描述的是**可复用规则**而不是一次性纠正 —— 落成 convention 类别，
// 注入时与「用户纠正与偏好」分在不同分组，便于模型按语义取用。
// 此前 convention 类别零写入方，面板上的「项目约定」永远为空。
const CONVENTION_PATTERN = /一律|统一|规范|约定|命名|缩进|格式|风格|必须用|都要|全部用|标准|不要用|只用|优先用|保持一致/

export function noteUserCorrection(dir: string, sid: string, text: string): void {
  const t = (text || '').trim()
  if (!t || t.length > 400 || !CORRECTION_PATTERN.test(t)) return
  const candidates: AgentMemoryCandidate[] = [{
    category: 'correction',
    content: `用户纠正 / 约束（原话）：「${t.slice(0, CANDIDATE_TEXT_CAP)}」`,
    source: 'user',
    origin: `user-correction:${sid}`,
    confidence: 0.9,
  }]
  // 同一句话若同时带约定语气，额外落一条 convention。存储侧的相似合并按「同类别」比较，
  // 两个类别各存一份不会互相吞掉，注入时也能各归各的分组。
  if (CONVENTION_PATTERN.test(t)) {
    candidates.push({
      category: 'convention',
      content: `项目约定（用户原话）：「${t.slice(0, CANDIDATE_TEXT_CAP)}」`,
      source: 'user',
      origin: `user-convention:${sid}`,
      confidence: 0.85,
    })
  }
  submit(dir, candidates)
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

/** 单次压缩批次最多沉淀的 error_fix 条数（一次批次里通常只有一两处真正的试错） */
const ERROR_FIX_CAP = 2

/** 顺序展开后的工具调用记录（错误→修正的配对需要在时间序上比较，不能边遍历边判定） */
interface ToolCallRec {
  name: string
  /** Bash 的命令行 */
  cmd?: string
  /** Write / Edit 的工作区相对路径 */
  file?: string
  /** 真失败：只有「跑完了且 failed」才算，中断 / 未完成不算试错信号 */
  failed: boolean
}

/** 命令族：取首个可执行程序名，用于判断两条命令是不是「同一件事」 */
function cmdFamily(cmd: string): string {
  return (cmd.trim().match(/^[^\s|&;]+/)?.[0] || '').toLowerCase()
}

/**
 * 错误→修正配对：批次里「先失败、随后同类成功」的组合，是最值得跨会话保留的经验。
 * 这是 error_fix 类别唯一的机械来源（此前该类别零写入方，面板上的「错误解法」永远为空）。
 * 只做同类配对 —— 命令按命令族、文件按路径 —— 避免把「A 文件写失败、B 文件写成功」
 * 误配成一次修正。
 */
function buildErrorFixes(seq: readonly ToolCallRec[], sid: string): AgentMemoryCandidate[] {
  const out: AgentMemoryCandidate[] = []
  for (let i = 0; i < seq.length && out.length < ERROR_FIX_CAP; i++) {
    const bad = seq[i]!
    if (!bad.failed) continue
    for (let j = i + 1; j < seq.length; j++) {
      const good = seq[j]!
      if (good.failed) continue
      if (bad.cmd && good.cmd && cmdFamily(bad.cmd) === cmdFamily(good.cmd)) {
        out.push({
          category: 'error_fix',
          content: `命令 \`${bad.cmd.slice(0, 120)}\` 执行失败，改用 \`${good.cmd.slice(0, 120)}\` 成功`,
          source: 'agent',
          origin: `condense:${sid}`,
          confidence: 0.55,
        })
        break
      }
      if (bad.file && good.file && bad.file === good.file) {
        out.push({
          category: 'error_fix',
          content: `对 ${bad.file} 的写入首次失败，重试后成功（具体报错见该会话轨迹）`,
          source: 'agent',
          origin: `condense:${sid}`,
          confidence: 0.5,
          anchorPath: bad.file,
        })
        break
      }
    }
  }
  return out
}

export function noteCondenseFacts(dir: string, sid: string, batch: AgentMessage[]): void {
  const candidates: AgentMemoryCandidate[] = []
  const seenCmds = new Set<string>()
  const editedFiles = new Set<string>()
  const seq: ToolCallRec[] = []
  for (const m of batch) {
    if (m.role !== 'assistant' || !m.toolCalls) continue
    for (const tc of m.toolCalls) {
      const args = parseArgs(tc.args)
      const cmd = tc.name === 'Bash' && typeof args.command === 'string' ? args.command.trim() : undefined
      const file = tc.name === 'Write' || tc.name === 'Edit'
        ? toWorkspaceRel(dir, typeof args.file_path === 'string' ? args.file_path : typeof args.path === 'string' ? args.path : '')
        : undefined
      // 失败记录也要进 seq（错误→修正配对需要它），但不参与下面两个正向沉淀
      seq.push({ name: tc.name, cmd, file, failed: tc.status === 'done' && !!tc.failed })
      if (tc.status !== 'done' || tc.failed) continue
      if (cmd) {
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
      } else if (file) {
        editedFiles.add(file)
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
  candidates.push(...buildErrorFixes(seq, sid))
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
