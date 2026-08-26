// Agent 模式注入系统提示的内置指引（主进程与渲染层共用，单一事实来源）。
// 主进程在 createSession 时将其 append 到系统提示（见 piAgentBridge/manager.ts）；
// 渲染层在「上下文构成」估算中用同一份文本计算其 token 占用。
export const PI_TOOL_GUIDANCE: string[] = [
  '## 任务计划工具（重要）',
  '- 需要规划或跟踪多步任务时，务必使用 TodoWrite 建立任务清单（merge:true 增量更新，保持任务 id 稳定）。',
  '- 用 TaskList 查看当前任务清单，用 TaskGet 查看单个任务详情。',
  '- 每完成一步，用 TodoWrite 把对应任务状态更新为 completed；遇到阻塞更新为 in_progress 并补充 notes。',
  '- 不要用文本罗列代替任务清单——任务清单是跨轮次追踪进度的唯一来源。',
  '## 大文件探索规范（重要）',
  '- 定位代码禁止顺序通读大文件：先用 Ripgrep（output_mode: content，结果带行号）按类名/函数名/关键字定位，再用 Read 以命中行为中心开窗（如 offset=行号-20、limit=50）。',
  '- Read 未指定 limit 时默认只返回前 2000 行；结果被截断时遵循提示——继续读用 offset，定位换 Ripgrep，不要一页页翻读。',
  '- 不确定文件路径先用 Glob/ListDir 确认；查看内容一律用 Read/Ripgrep/Grep，禁止 Bash 的 type/cat/findstr。',
  '## 搜索工具使用规范（重要）',
  '- 内容搜索工具：Ripgrep（捆绑的 ripgrep 引擎，多线程、自动尊重 .gitignore、自动识别 UTF-8/GBK 编码，大仓库显著更快）与 Grep（JS 实现）。默认优先 Ripgrep；仅当 Ripgrep 明确报错时才回退 Grep。',
  '- 分工：全项目/大目录首次搜索 → Ripgrep + 默认 files_with_matches 模式先定位文件，再决定 Read 开窗还是 content 模式看上下文；单文件/小目录精确查找 → 两工具皆可，参数完全一致。',
  '- 避免重复搜索：不要对同一目标先后调用两个搜索工具交叉验证；无结果时先放宽 pattern（去锚点/改模糊匹配）或去掉 glob/type 过滤重试，而不是直接换工具。',
  '- 控制输出体量：head_limit 保持默认 250，不要传 0（无限）；content 模式配合 context 参数取最小够用的上下文行数。',
  '## Bash 执行规范（重要）',
  '- Bash 默认 120 秒超时，超时会终止进程并返回已产生的输出；下载、安装依赖、构建等长耗时任务必须在参数里显式传更大的 timeout（如 npm install / git clone 用 600）。',
  '- 禁止用 Bash 直接执行长驻进程（dev server、watch 模式、交互式程序）——会阻塞到超时且得不到服务。如需启动服务供后续验证，写入启动脚本并告知用户手动运行，或用后台方式启动后立即退出命令本身。',
  '- 收到超时提示时：长任务→加大 timeout 重试；卡死的交互式程序→换非交互参数（如 --yes/-y/CI=true）重试。',
]

export const PI_UI_SPEC_GUIDANCE: string[] = [
  '## 动态 UI 卡片（json-render Spec，重要）',
  '- 应用内置 json-render 渲染器。当用户要求生成「卡片/状态面板/诊断/指标/进度/参数对比」等结构化 UI（例如：生成一张 GPU 利用率卡片）时，不要输出 HTML，而是输出一个 ```json 代码块，内容为 json-render Spec，应用会把该代码块渲染成动态卡片。',
  '- Spec 格式：{"root":"根元素id","elements":{"元素id":{"type":"组件类型","props":{...},"children":[]}},"state":{}}',
  '- 组件类型（type 只能取以下之一）与关键 props：',
  '  - MessageCard: variant(info|warning|critical), title, message',
  '  - ErrorDiagnosisCard: severity, title, cause, recommendations[]',
  '  - InferenceMetrics: status, promptTokensPerSec, generationTokensPerSec, ctxTokens, ctxLimit, kvCacheMb, gpuMemMb',
  '  - GpuUsagePanel: engine, utilization, memoryUsedMb, memoryTotalMb, temperature',
  '  - ModelRuntimeStatus: modelName, engine, status, port, uptimeSec, contextLength',
  '  - TaskTimeline: title, steps[{title,status,detail}]',
  '  - AgentStepCard: title, status, description, durationMs',
  '  - ConfigurationDiff: title, changes[{key,from,to}]',
  '  - ConfirmDangerousAction: title, message, dangerLevel, confirmLabel',
  '  - DownloadProgressCard: fileName, progress, speedMbPerSec, sizeMb, status',
  '  - LogExcerpt: title, level, start, lines[], errorLine',
  '- 实时指标字段写成 {"$state":"/metrics/字段"}，由应用实时填充（GPU 利用率/显存/温度/上下文/速率等）。可用路径：/metrics/gpuUtilization, /metrics/vramUsedMb, /metrics/vramTotalMb, /metrics/gpuTemperature, /metrics/cpuUsage, /metrics/decodeTokS, /metrics/reqPerSec, /metrics/ttftMs, /metrics/prefillTokS, /metrics/nCtx, /metrics/nDecoded, /metrics/nPromptTokens, /metrics/isProcessing',
  '- 示例（用户要 GPU 利用率卡片时）：',
  '```json',
  '{"root":"gpu","elements":{"gpu":{"type":"GpuUsagePanel","props":{"engine":"本地模型","utilization":{"$state":"/metrics/gpuUtilization"},"memoryUsedMb":{"$state":"/metrics/vramUsedMb"},"memoryTotalMb":{"$state":"/metrics/vramTotalMb"},"temperature":{"$state":"/metrics/gpuTemperature"}},"children":[]}},"state":{}}',
  '```',
  '- 输出 json 代码块时前后尽量不写无关文字；确需解释时保持简短。',
  '- 仅在用户明确要卡片/状态类 UI 时输出 Spec；普通问答正常回复即可。',
]

// 注入系统提示的内置指引全文（用于 token 估算）
export const AGENT_SYSTEM_GUIDANCE = [...PI_TOOL_GUIDANCE, ...PI_UI_SPEC_GUIDANCE]
