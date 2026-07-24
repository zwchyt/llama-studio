export function getTodoWritePrompt(): string {
  return `# TodoWrite 工具
创建/管理结构化待办清单（对用户实时可见），是唯一的任务管理工具（建、改状态、记结果、取消都用它）。
- 用于：≥3 步的复杂任务开始前规划、用户明确要求清单、接到一串任务时记录；开始任务标 in_progress，做完标 completed 并补新发现的子任务。单一琐碎任务无需用。
- **merge 模式（默认）** 按 id 增量更新：改状态传 \`{id, status}\`，记结果传 \`{id, notes}\`，新增可省 content。**replace 模式（merge=false）** 整体替换（初始化/大改）。
- 字段：id（稳定唯一，省略自动生成）、content（祈使句短标题，merge 已有项可省）、status（pending/in_progress/completed/cancelled）、priority（high/medium/low）、activeForm（进行中状态栏文案）、notes（结果备注，供 TaskGet 读取）。
- 用稳定 id 勿重生成；死胡同标 cancelled 而非删除；与 TaskGet/TaskList 共享同一清单。`
}
