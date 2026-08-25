// 自定义 /命令 系统：解析、展开与命令注册表
// 设计目标：让用户在输入框以 `/name args` 触发，展开为提示词模板后发送给 Agent。
// 与 Pi SDK 的 Slash Commands / Prompt Templates 对应（SDK 该能力当前未启用，见 PI_INTEGRATION_ANALYSIS.md §11.1）。

import type { SlashCommand } from '../../../shared/types'

// ── 内建「动作型」命令（renderer 侧直接处理，不发给模型）──
// 这些命令对应现有 UI 面板/状态查询，由 AgentCodeView 的 runSlashAction 分发。
// 标记为 builtin 且 kind:'action'，在命令管理器中显示为「内建」且不可编辑/删除。
// 提示词型命令（kind:'prompt'）无内建默认值，全部由用户在「命令管理」中自定义。
export const BUILTIN_ACTION_COMMANDS: SlashCommand[] = [
  { name: 'help', description: '显示所有可用命令', kind: 'action', template: '', builtin: true },
  { name: 'status', description: '查看当前会话状态（模型、消息数、token）', kind: 'action', template: '', builtin: true },
  { name: 'context', description: '查看上下文窗口使用情况', kind: 'action', template: '', builtin: true },
  { name: 'clear', description: '清空当前会话', kind: 'action', template: '', builtin: true },
  { name: 'model', description: '查看/切换当前模型', kind: 'action', template: '', builtin: true },
  { name: 'thinking', description: '设置思考程度 (low/medium/high)', kind: 'action', template: '', builtin: true },
  { name: 'tasks', description: '查看当前待办清单', kind: 'action', template: '', builtin: true },
  { name: 'stats', description: '显示 token/请求统计', kind: 'action', template: '', builtin: true },
  { name: 'compact', description: '手动触发历史压缩', kind: 'action', template: '', builtin: true },
  { name: 'files', description: '列出工作区文件', kind: 'action', template: '', builtin: true },
  { name: 'git', description: '查看 Git 变更状态', kind: 'action', template: '', builtin: true },
  { name: 'audit', description: '查看操作审计日志', kind: 'action', template: '', builtin: true },
  { name: 'debug', description: '查看调试信息', kind: 'action', template: '', builtin: true },
  { name: 'memory', description: '查看/管理长期记忆', kind: 'action', template: '', builtin: true },
  { name: 'kb', description: '查看知识库列表', kind: 'action', template: '', builtin: true },
  { name: 'branch', description: '创建当前会话分支', kind: 'action', template: '', builtin: true },
  { name: 'export', description: '导出当前会话', kind: 'action', template: '', builtin: true },
  { name: 'undo', description: '撤销上一次文件修改', kind: 'action', template: '', builtin: true },
]

const NAME_RE = /^[a-zA-Z0-9_\-]+$/

/** 校验命令名合法性（用于新建/编辑表单） */
export function isValidCommandName(name: string): boolean {
  return NAME_RE.test(name.trim())
}

/**
 * 解析输入是否为 /命令。返回 null 表示不是命令。
 * 仅当输入以 `/` 起始、其后为合法命令名、且命令名后紧跟空格或行尾时识别为命令。
 */
export function parseSlashCommand(
  input: string,
): { name: string; args: string; raw: string } | null {
  const trimmed = input.replace(/\s+$/, '')
  const m = /^\/([a-zA-Z0-9_\-]+)(?:\s+(.*))?$/.exec(trimmed)
  if (!m) return null
  const name = m[1]!.toLowerCase()
  const args = (m[2] ?? '').trim()
  return { name, args, raw: trimmed }
}

/** 把模板按 $ARGUMENTS 占位符展开；无占位符时把参数追加到模板末尾。 */
export function expandCommandTemplate(template: string, args: string): string {
  if (template.includes('$ARGUMENTS')) {
    return template.replace(/\$ARGUMENTS/g, args)
  }
  const base = template.replace(/\s+$/, '')
  return args ? `${base}\n\n${args}` : base
}

/**
 * 合并所有命令：动作型内建（密封，最高优先级）→ 提示词内建 → 用户自定义（可覆盖提示词内建）。
 * 动作型内建命令不可被同名自定义覆盖。
 */
export function mergeCommands(custom: SlashCommand[] = []): SlashCommand[] {
  const map = new Map<string, SlashCommand>()
  for (const c of custom) map.set(c.name.toLowerCase(), { ...c, name: c.name.toLowerCase() })
  // 动作型内建最后写入，确保密封不可被覆盖
  for (const c of BUILTIN_ACTION_COMMANDS) map.set(c.name, c)
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** 在合并后的命令列表中按名称查找 */
export function findCommand(name: string, custom: SlashCommand[]): SlashCommand | undefined {
  const all = mergeCommands(custom)
  return all.find(c => c.name === name.toLowerCase())
}

/**
 * 若输入是一个已识别的 /命令，则返回展开后的最终提示词；否则原样返回。
 */
export function resolveInput(input: string, custom: SlashCommand[]): string {
  const parsed = parseSlashCommand(input)
  if (!parsed) return input
  const cmd = findCommand(parsed.name, custom)
  if (!cmd) return input
  return expandCommandTemplate(cmd.template, parsed.args)
}

/** 根据已输入前缀过滤命令（用于自动补全浮层） */
export function filterCommands(prefix: string, custom: SlashCommand[]): SlashCommand[] {
  const all = mergeCommands(custom)
  const p = prefix.toLowerCase()
  if (!p) return all
  return all.filter(c => c.name.startsWith(p) || c.description.toLowerCase().includes(p))
}
