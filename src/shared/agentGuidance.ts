// Agent 模式注入系统提示的内置指引（主进程与渲染层共用，单一事实来源）。
// 主进程在 createSession 时将其 append 到系统提示（见 piAgentBridge/manager.ts）；
// 渲染层在「上下文构成」估算中用同一份文本计算其 token 占用。

export const PI_TOOL_GUIDANCE: string[] = [
  '## 任务计划（TodoWrite）',
  '- 多步任务用 TodoWrite 建任务清单（merge:true 增量更新，id 稳定）。',
  '- 每完成一步更新 status；阻塞用 in_progress + notes。',
  '## 文件定位（Ripgrep 优先）',
  '- 先 Ripgrep 定位行号，再 Read 开窗；不确定路径先 Glob。',
  '- 禁止 Bash type/cat/findstr；禁止顺序通读大文件。',
  '## Bash 规范',
  '- 默认 120s 超时；下载/构建显式传更大 timeout（npm install 600）。',
  '- 长驻进程（dev server/watch）禁止直接跑——写脚本让用户手动执行。',
]

// UI 卡片指引（精简后 ~200 token，本地小模型可一次读完记住 3 个 component + 8 个 metric path）
export const PI_UI_SPEC_GUIDANCE: string[] = [
  '## UI 卡片（json-render Spec）',
  '- 用户要「卡片/面板/指标/状态」类结构化 UI 时，输出 ```json 代码块（Spec），应用会渲染。普通问答不输出 Spec。',
  '- 组件（type 仅限以下 2 个）：',
  '  - MessageCard: variant(info|warning|critical|error), title, message',
  '  - GpuUsagePanel: engine, utilization?, memoryUsedMb?, memoryTotalMb?, temperature?',
  '  - Chart: type(line|bar|pie), title?, data:[{...}], xKey, yKey',
  '- 实时指标用 {"$state":"/metrics/字段"}，路径：/metrics/gpuUtilization|vramUsedMb|vramTotalMb|gpuTemperature|decodeTokS|nCtx|nDecoded|isProcessing',
  '- Spec 格式：{"root":"id","elements":{"id":{"type":"组件","props":{},"children":[]}},"state":{}}，children 一般为 []。',
]

// 注入系统提示的内置指引全文（用于 token 估算）
export const AGENT_SYSTEM_GUIDANCE = [...PI_TOOL_GUIDANCE, ...PI_UI_SPEC_GUIDANCE]
