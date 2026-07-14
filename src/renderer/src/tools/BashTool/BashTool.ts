import type { ToolDefinition } from '../../utils/tools'
import { BASH_TOOL_NAME } from './constants'
import type { BashInput } from './types'

export const definition: Omit<ToolDefinition['function'], 'type'> = {
  name: BASH_TOOL_NAME,
  description: 'Execute a shell command on Windows cmd.exe. Returns stdout/stderr. Unix commands (pwd, ls, cat, grep, cp, mv, rm, which, chmod, export) are NOT available; use dir, cd, copy, move, del, rmdir, where, set instead. Read/Write/Edit/Grep/Glob tools are preferred for file operations; avoid shell redirection (> >>).',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to execute (e.g. dir, cd, git log, echo, node, python).' },
      description: { type: 'string', description: 'Clear, concise description of what this command does in active voice.' },
      timeout: { type: 'number', description: 'Optional timeout in milliseconds (max 300000). Default: 120000.' }
    },
    required: ['command']
  }
}

export async function execute(args: Record<string, unknown>): Promise<string> {
  const { command, description, timeout } = args as unknown as BashInput
  try {
    const res = await window.api.executeCommand({
      command,
      timeout: typeof timeout === 'number' ? Math.min(timeout, 300000) : 120000
    })
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
    return output || '(no output)'
  } catch (e: any) {
    return `Error: ${e?.message || String(e)}`
  }
}
