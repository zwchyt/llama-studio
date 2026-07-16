import type { ToolDefinition } from '../../utils/tools'
import { BASH_TOOL_NAME } from './constants'
import type { BashInput } from './types'

export const definition: Omit<ToolDefinition['function'], 'type'> = {
  name: BASH_TOOL_NAME,
  description: 'Execute a shell command on Windows cmd.exe. Returns stdout/stderr. Supports foreground/background modes and output truncation. Unix commands (pwd, ls, cat, grep, cp, mv, rm, which, chmod, export) are NOT available; use dir, cd, copy, move, del, rmdir, where, set instead. Read/Write/Edit/Grep/Glob tools are preferred for file operations; avoid shell redirection (> >>).',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to execute (e.g. dir, cd, git log, echo, node, python).' },
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

export async function execute(args: Record<string, unknown>): Promise<string> {
  const { command, description, timeout, is_background, max_output_chars, auto_background } = args as unknown as BashInput
  try {
    const res = await window.api.executeCommand({
      command,
      timeout: typeof timeout === 'number' ? Math.min(timeout, 300000) : 120000,
      isBackground: is_background ?? undefined,
      maxOutputChars: max_output_chars ?? undefined,
      autoBackground: auto_background ?? undefined
    })

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

    // 超时自动转后台
    if (res.autoBackgrounded && res.taskId) {
      let output = `[${description || command}]\n`
      output += `[Command moved to background (timed out)]\n`
      if (res.stdout) output += res.stdout
      if (res.stderr) {
        if (res.stdout) output += '\n'
        output += `stderr:\n${res.stderr}`
      }
      output += `\n\nTask ID: ${res.taskId} (still running in background)`
      output += `\nUse get_background_task_output with task_id="${res.taskId}" to retrieve the full output later.`
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
      output += `\n\nExit code: ${res.code}`
      if (!output.trim()) output = `Command failed with exit code ${res.code} (no output)`
    }

    // 纯 echo 检测
    if (res.code === 0 && (isBareEcho(command) || isBarePrintf(command))) {
      output += '\n\n(ℹ️ 提示：如需向工具链传递信息，直接返回即可，无需使用 echo/printf。)'
    }

    return output || '(no output)'
  } catch (e: any) {
    return `Error: ${e?.message || String(e)}`
  }
}
