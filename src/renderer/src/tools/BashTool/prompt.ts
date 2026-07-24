import { BASH_TOOL_NAME } from './constants'

export function getBashPrompt(): string {
  return `# ${BASH_TOOL_NAME} 工具
执行 shell 命令（当前为 **Windows cmd.exe**，非 PowerShell/bash）。仅用于真正需要 shell 的场景（运行程序/脚本/构建/git）。

## 环境替代（Unix 命令不可用）
\`ls\`→\`dir\`（但列目录优先用 ListDir/AnalyzeDir）；\`pwd\`→\`cd\`；\`which\`→\`where\`；\`export\`→\`set\`；\`cat/head/tail\`→Read；\`grep\`→Grep；\`cp/mv/rm\`→Delete/\`copy\`/\`move\`；\`chmod\` 无。路径用 \`/\`，含空格加双引号。

## 硬规则
- **禁止重定向** \`>\`/\`>>\`（易卡死，存输出用 Write）。
- 长任务拆成多次调用，别拼超长复合命令；有依赖用 \`&&\`（≤3 个），别用换行分隔，慎用 \`if\`/\`for\` 中的括号。
- 命令出错先看 \`echo %errorlevel%\` 再调整；同一命令连续失败就换方案。

## 后台与超时
- 默认超时 120s（最大 300s）；\`auto_background: true\` 让超时命令转后台而非被杀。
- \`is_background: true\` 放后台（dev server/长构建），返回 task_id；用 \`get_background_task_output\`/\`list_background_tasks\` 查看；后台下 \`timeout: 0\` 不超时。
- 输出超约 100K 字符自动截断，完整存临时文件。

## 审批
- 普通命令（dir/python/node/构建/git status 等）直接执行，不弹窗，放心用。
- 仅破坏性命令（del/rmdir/format/taskkill/shutdown/reg delete/net stop 等）需用户审批；别为绕审批把破坏性操作伪装成普通命令。
- git：优先新建 commit 而非 amend，禁止 \`--no-verify\`。非必要不输出，别用 echo 传信息给工具链。`
}
