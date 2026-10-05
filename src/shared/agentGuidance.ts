// Agent 模式注入系统提示的内置指引（主进程与渲染层共用，单一事实来源）。
// 主进程在 createSession 时将其 append 到系统提示（见 piAgentBridge/manager.ts）；
// 渲染层在「上下文构成」估算中用同一份文本计算其 token 占用。

export const PI_TOOL_GUIDANCE: string[] = [
  '## 任务计划（TodoWrite）',
  '- 多步任务用 TodoWrite 建任务清单（merge:true 增量更新，id 稳定）。',
  '- 每完成一步更新 status；阻塞用 in_progress + notes。',
  '## 读取策略（先定位 → 再开窗 → 最后才整读）',
  '- 默认动作：先用 Ripgrep/Grep（output_mode: content、带行号、context 3~5 行）直接取答案。',
  '  「改一处 / 查一处」这类任务通常到此就够，不要为了"看上下文"再整读文件。',
  '- 已知行号再 Read 开窗：传 offset/limit 只读目标区间（如 offset=120 limit=60）。',
  '  不确定路径先 Glob；想先知道文件多大、有哪些文件，用 ListDir（带大小）。',
  '- 只有「整体理解 / 重构 / 审阅 / 通读全篇」才允许整读；禁止顺序翻页式通读大文件。',
  '- Read 不传 limit = 最多 2000 行，小文件会被整读；要只读片段必须显式传 offset/limit。',
  '- 禁止用 Bash 的 type/cat/findstr 读文件。',
  '## 避免重复读取（省上下文）',
  '- 同一文件同一区间本会话已读过就不要再读；命中读取缓存时工具会明确提示。',
  '- 刚 Edit/Write 过的文件不要整读确认：改动区间已在工具结果里给出。',
  '  确需更大范围时用 Read 的 offset/limit 只读目标区间，不要整文件重读。',
  '## Bash 规范',
  '- 默认 120s 超时；下载/构建显式传更大 timeout（npm install 600）。',
  '- 长驻进程（dev server/watch）禁止直接跑——写脚本让用户手动执行。',
  '## 图片：内联的别去读，磁盘的才用工具',
  '- 用户在本轮消息里**直接附加 / 粘贴 / 拖入**的图片已经内联在对话里，你直接就能看到——不要再调 view_image 去读它。',
  '- view_image 只用于读**工作区磁盘上**的图片文件，且被限制在工作区内；工作区外的路径会直接失败。',
]

// ===== 图表输出路由（始终在系统提示词中，模型根据用户消息自选路径）=====
// ⚠️ 语法示例**不在提示词里**：原五块（Mermaid DSL / Chart 围栏 / Mermaid JSON / SVG）
// 合计 8,971 字符 ≈ 4,970 token，占编码模式初始加载的 48%，而绝大多数编码任务用不到。
// 现已移到知识库文档（docs/chart-syntax-kb.md，导入应用的资料库即可）：模型需要画图时
// 先 knowledge_search 检索对应图表类型的示例，再照示例输出。
// 这里只保留三件事：路由（哪种意图用哪种围栏）、去哪找语法、检索不到时怎么办。
export const PI_CHART_ROUTING: string[] = [
  '## 图表输出（语法查知识库，不要凭记忆写）',
  '- 需要图表时：先用 knowledge_search 检索该图表类型的**示例**（关键词直接用类型名，如 flowchart / sequenceDiagram / gantt / 雷达图 / 折线图 / svg 图标），命中块的正文会自动附在目录末尾，拿到示例后**严格照它的语法输出**。',
  '- 路由：描述「结构 / 关系 / 流程」→ ```mermaid；描述「数值 / 数据」→ ```chart；描述「外观 / 形状」→ ```svg；要「结构化 spec」',
  '- ```chart / ```svg 的 spec 形状是本项目特有的，**必须以知识库里的示例为准**；若 knowledge_search 不可用（未配置知识库）或检索不到示例：不要猜 spec，改用 markdown 表格或普通代码块，并提示用户把图表语法文档导入资料库。',
  '- ```mermaid 是通用语法，检索不到示例时可用你已知的标准 mermaid 语法。',
  '- 图表直接在对话里输出，不要用 Write / Bash 创建图表文件。',
  '- ⚠️ 绝不输出图表库的组件代码（Recharts / Chart.js / ECharts 的 JSX 或 JS）——那段代码不会被执行，用户只会看到一段文本。',
]

export const AGENT_SYSTEM_GUIDANCE = [...PI_TOOL_GUIDANCE, ...PI_CHART_ROUTING]

// 纯聊天模式的系统提示词：整段**替换** pi 的默认提示词（不是追加）。
// 必须替换——pi 的默认提示词是给编码 agent 写的，里面有两句会直接误导模型：
//   「You are an expert coding assistant operating inside pi, a coding agent harness.
//     You help users by reading files, executing commands, editing code, and writing new files.」
//   「In addition to the tools above, you may have access to other custom tools depending on the project.」
// 即使 tools 传空数组、Available tools 显示成 (none)，这两句仍在，
// 模型读完就会以为自己能调工具（这就是纯聊天模式下模型仍然「知道」有工具的原因）。
export const PLAIN_CHAT_SYSTEM_PROMPT =
  'You are a helpful assistant. Answer the user directly and concisely.'
