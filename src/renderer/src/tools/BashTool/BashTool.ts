import type { ToolDefinition } from '../../utils/tools'
import { BASH_TOOL_NAME } from './constants'
import type { BashInput } from './types'
import { getWorkspaceRootForSession } from '../workspaceRoot'
import { startBashLive, stopBashLive } from './bashLiveStore'

export const definition: Omit<ToolDefinition['function'], 'type'> = {
  name: BASH_TOOL_NAME,
  description: '在 Windows cmd.exe 执行 shell 命令，返回 stdout/stderr。支持前台/后台模式与输出截断。仅用于真正需要 shell 的场景（运行程序、脚本、构建等）。注意：不支持 Unix 命令（pwd/ls/cat/grep/cp/mv/rm 等），改用 dir/cd/copy/move/del/rmdir/where/set；列目录或探索项目结构请用 ListDir 工具，不要用 Bash；避免输出重定向（> >>）。',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的 shell 命令（如 git log、node、python、npm run build）。列目录请用 ListDir 工具。' },
      description: { type: 'string', description: 'Clear, concise description of what this command does in active voice.' },
      timeout: { type: 'number', description: 'Optional timeout in milliseconds (max 300000). Default: 120000.' },
      is_background: { type: 'boolean', description: 'Run in background (long-running commands: dev servers, builds). Returns taskId immediately.' },
      max_output_chars: { type: 'number', description: 'Max output characters before truncation (default 100000).' },
      auto_background: { type: 'boolean', description: 'If command times out, move to background instead of killing.' }
    },
    required: ['command']
  }
}

function isBareEcho(command: string): boolean {
  const t = command.trimStart()
  if (!t.startsWith('echo')) return false
  const after = t.slice(4)
  if (after && !after.startsWith(' ') && !after.startsWith('\t')) return false
  let rest = after.trimStart()
  while (rest.startsWith('-')) {
    const m = rest.match(/^-[neE]+/)
    if (!m) break
    rest = rest.slice(m[0].length).trimStart()
  }
  if (!rest) return false
  if (rest.length >= 512) return false
  return !/[;&|><$`()\n]/.test(rest)
}

function isBarePrintf(command: string): boolean {
  const t = command.trimStart()
  if (!t.startsWith('printf')) return false
  const after = t.slice(6)
  if (after && !after.startsWith(' ') && !after.startsWith('\t')) return false
  const rest = after.trimStart()
  if (rest.startsWith('-v') || rest.startsWith('--')) return false
  if (!rest || rest.length >= 512) return false
  return !/[;&|><$`()\n]/.test(rest)
}

// ── 工作目录跟踪（cd 跨命令持久化）──
// 模型常期望「cd dir」后后续命令在 dir 中执行；我们为每次 bash
// 新开 cmd.exe，故需手动追踪目录并通过 setBashCwd 同步给主进程。
let trackedCwd = ''

function resolveCdTarget(raw: string, currentCwd: string): string | null {
  // 取最后一段 cd xxx（忽略 && 等连接符）
  const segments = raw.split(/[&|]{2}|[;]/)
  for (const seg of segments) {
    const trimmed = seg.trim()
    const m = trimmed.match(/^cd\s+(.+)/i)
    if (!m) continue
    const target = m[1]!.trim()
    if (target.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(target)) return target
    if (target === '..' || target === '../') {
      const parent = currentCwd.replace(/[\\/]+$/, '').split(/[\\/]/)
      parent.pop()
      return parent.length ? parent.join('\\') : currentCwd
    }
    if (target === '.' || target === './') continue
    // 相对路径：拼到当前 cwd
    return currentCwd.replace(/[\\/]+$/, '') + '\\' + target.replace(/[\\/]/g, '\\').replace(/^[\\/]+/, '')
  }
  return null
}

export async function execute(args: Record<string, unknown>): Promise<string> {
  const { command, description, timeout, is_background, max_output_chars, auto_background } = args as unknown as BashInput
  // 前台命令开启实时输出流式推送（后台命令立即返回 taskId，无需实时）。
  const streaming = !is_background
  const execId = streaming ? `bash-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` : undefined
  if (execId) startBashLive(execId)
  try {
    const res = await window.api.executeCommand({
      command,
      timeout: typeof timeout === 'number' ? Math.min(timeout, 300000) : 120000,
      isBackground: is_background ?? undefined,
      maxOutputChars: max_output_chars ?? undefined,
      autoBackground: auto_background ?? undefined,
      execId,
    })

    // ── cd 持久化（#1） ──
    if (res.code === 0) {
      if (!trackedCwd) trackedCwd = getWorkspaceRootForSession()
      const newCwd = resolveCdTarget(command, trackedCwd)
      if (newCwd) {
        trackedCwd = newCwd
        window.api.setBashCwd(newCwd).catch(() => {})
      }
    }

    // 后台任务启动成功
    if (res.taskId && !res.autoBackgrounded) {
      return [
        `[${description || command}]`,
        `Background task started: ${res.taskId}`,
        `Command is running in the background.`,
        `Use get_background_task_output with task_id="${res.taskId}" to retrieve the output later.`,
        `Use list_background_tasks to see all running/completed tasks.`
      ].join('\n')
    }

    // ── 超时/失败分类反馈（#2） ──
    // 超时自动转后台
    if (res.autoBackgrounded && res.taskId) {
      let output = `[${description || command}]`
      output += `\n⏱ 命令执行超时（已自动转入后台运行）\n`
      if (res.stdout) output += res.stdout
      if (res.stderr) {
        if (res.stdout) output += '\n'
        output += `stderr:\n${res.stderr}`
      }
      output += `\n\nTask ID: ${res.taskId}（仍在后台运行）`
      output += `\n可使用 get_background_task_output 获取完整输出。`
      return output
    }

    // 正常前台结果
    let output = ''
    if (description) output += `[${description}]\n`
    if (res.stdout) output += res.stdout
    if (res.stderr) {
      if (res.stdout) output += '\n'
      output += `stderr:\n${res.stderr}`
    }

    if (res.code !== 0) {
      // 结构化的错误分类
      if (res.code === 124 || res.code === -1) {
        output += `\n\n⏱ 命令执行超时（${(timeout || 120000) / 1000}s），已自动终止。如需更长等待可调大 timeout 参数。`
      } else {
        output += `\n\n❌ 命令失败，退出码: ${res.code}`
      }
      if (!output.trim()) output = `命令失败，退出码 ${res.code}（无输出）`
    }

    // 纯 echo 检测（仅成功时）
    if (res.code === 0 && (isBareEcho(command) || isBarePrintf(command))) {
      output += '\n\n(ℹ️ 提示：如需向工具链传递信息，直接返回即可，无需使用 echo/printf。)'
    }

    // ── 始终在截断时落盘并回传路径（#3） ──
    if (res.truncated && res.outputFile) {
      output += `\n\n（输出过长已截断，完整输出已保存至：${res.outputFile}，可用 Read 工具查看全部内容）`
    } else if (output.length > 20000) {
      try {
        const r = await window.api.writeTempFile(output, 'log')
        if (r.success && r.path) {
          output += `\n\n（输出过长，已保存至：${r.path}，可用 Read 工具查看全部内容）`
        }
      } catch { /* 写临时文件失败不影响主结果返回 */ }
    }

    return output || '(no output)'
  } catch (e: any) {
    return `💥 命令执行异常：${e?.message || String(e)}`
  } finally {
    if (execId) stopBashLive(execId)
  }
}

// 判断一条 Bash 命令是否「破坏性」——仅这类命令才需要人工确认弹窗。
// 设计原则：宁可少弹、不要滥弹。普通命令（列目录 dir/ls、运行脚本 python/node、
// 构建、查询 git status/log、cat/type、echo 等）一律视为非破坏性，直接执行。
// 仅当命令的主作用是删除/格式化/终止进程/改动系统状态时才判为破坏性。
// 注意：命令文本可能含注释与管道，这里做保守的关键词匹配（词边界、忽略大小写），
// 对无法判定为破坏性的命令不弹窗（由用户承担风险，符合「普通命令不弹窗」诉求）。
const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\b(?:del|erase)\b/i,                                 // 删除文件
  /\brm\b/i,                                            // unix 删除（git bash 等）
  /\b(?:rmdir|rd)\b/i,                                  // 删除目录
  /\bformat\b/i,                                        // 格式化磁盘
  /\bmkfs\b/i,                                          // 创建文件系统（清空分区）
  /\bdiskpart\b/i,                                      // 磁盘分区操作
  /\bshutdown\b/i,                                      // 关机/重启
  /\b(?:taskkill|tskill)\b/i,                           // 终止进程
  /\breg\s+delete\b/i,                                  // 删除注册表项
  /\bbcdedit\b/i,                                       // 修改启动配置
  /\bschtasks\s+\/delete\b/i,                           // 删除计划任务
  /\bnet\s+(?:stop|pause)\b/i,                          // 停止/暂停服务
  /\bsc\s+(?:stop|delete|config)\b/i,                   // 停止/删除/改服务
  /\btakeown\b/i,                                        // 夺取文件所有权
  /\bicacls\b/i,                                        // 修改 ACL（可能锁死权限）
  /\bwmic\b/i,                                          // WMI 改系统状态（常被用于删/停）
  /\bmv\b/i,                                            // unix 移动（可能覆盖/丢失）
  /\bmove\b/i,                                          // 移动文件（可能覆盖）
]

export function isDestructiveBashCommand(command: string): boolean {
  if (!command || typeof command !== 'string') return false
  const cmd = command.trim()
  if (!cmd) return false
  // 去掉行内注释（cmd 的 & rem / :: ，以及常见 # 注释），避免注释里的词误判
  const stripped = cmd
    .replace(/^(?:rem\s|::).*$/gim, ' ')               // cmd 注释
    .replace(/(?:^|\s)#.*$/gm, ' ')                    // shell 风格注释
  for (const re of DESTRUCTIVE_PATTERNS) {
    if (re.test(stripped)) return true
  }
  return false
}
