# agent-code/ 模块索引

原 `AgentCodeView.tsx`（7402 行、约 35.6 万字符的 God Component）已按功能边界拆分到本目录。
各模块在自身模块作用域声明组件，`React.memo` 身份稳定的前提不变。
每个模块的对外导出清单与「搬移说明」见其文件头注释。

主组件 `AgentCodeView.tsx` 只保留两件事：**装配各功能域 hook** 与**把域对象注入布局组件**。

---

## 视图层

| 目录 / 文件 | 职责 |
| --- | --- |
| `agent-view/AgentCodeViewLayout.tsx` | 界面骨架：顶栏 / 侧边栏 / 聊天区 / 预览区 / 弹层。纯受控视图，不持有状态 |
| `agent-message/` | 消息流：`ThinkBlock` 家族 / `StreamingContent` / `AgentMessageRow` / `UserMessageEntry` / `AgentTopBarCtx` / `TopbarBtn` / `renderSegmentsFor` / `ThinkTextContent`（思考预览与完整窗口） |
| `WindowedText.tsx` | 共享长内容行窗口：`useRowWindow`（滚动与可视范围计算）+ `WindowedRows`（只挂载视口附近行，供文本 / 栅格行复用）+ `WindowedText`（纯文本封装，含可选行号与贴底跟随）。思考完整文本 / 工具结果 / Diff / 代码块共用 |
| `agent-tools/` | 工具卡：`TOOL_META` / `ToolCallCard` / `ToolResultView` / `FileChangeSummary` / `LinedPre`（长结果与写入内容行窗口） |
| `agent-diff/` | Diff：`computeSplitDiff` / `getEditDiffStat` / `ToolEditDiff`（行数超 `DIFF_WINDOW_ROWS` 走行窗口） |
| `agent-panels/` | 面板：`AuditPanel` / `MemoryPanel` / `DebugPanel` |
| `agent-task/` | 待办视觉：`RollDigit` / `TaskCheckIcon` / `TaskPieIcon` |
| `agent-session/` | 会话视图：`AgentSessionSidebar`（工作区切换 通用/编码 + 聊天列表 / 项目会话树） |
| `agent-preview/` | 预览视图：`AgentPreviewSlot`（文件树 / 浏览器 / 终端 / 变更 / 预览） |
| `agent-input/` | 输入视图：`AgentInputArea`（输入框 / 附件 / 补全浮层 / 状态栏） |

## 纯函数与类型

| 目录 / 文件 | 职责 |
| --- | --- |
| `types/index.ts` | 跨模块共享类型（`PreviewTab` / `CodeSnippet` / `FlatFileEntry` / `AgentMsgRowActions` …） |
| `utils/ids` `paths` `format` `text` | ID、路径、格式化、文本处理 |
| `utils/mathHtml` `audio` `fileExt` `dom` | KaTeX 公式、音频编码、扩展名集合、DOM 辅助 |
| `utils/constants` | 共享常量（含 `GIT_DIFF_TAB` / `KEEP_RECENT_TURNS`） |
| `utils/thinkText` | 思考文本显示层：预览截断（`THINK_PREVIEW_LINES` / `THINK_PREVIEW_CHARS`）与行窗口（`buildTextRows` / `getTextRowWindow` / `TEXT_ROW_CHARS`） |
| `utils/textRows` | 长文本分行与可视行范围纯函数（`TEXT_ROW_CHARS` / `buildTextRows` / `getTextRowWindow`）：思考文本与工具结果共用；`utils/thinkText` 转发其导出 |
| `utils/condensePrompt` | 上下文压缩提示词与消息序列化（`SUMMARY_PROMPT` / `buildApiMessagesFull` / `wrapUntrustedFileContent` …） |

## 功能域 hook

| Hook | 职责 |
| --- | --- |
| `hooks/useAgentProjects` | 工作区（项目）/ 会话列表状态与增删改；**模式（通用 / 编码）归属工作区**，每模式独立的可见列表与活动指针 |
| `hooks/useAgentInput` | 输入域：正文 / `textareaRef` / 打包 chip / 附件 / 引用胶囊 / 代码片段 / 历史回溯 / 选区浮层 |
| `hooks/useAgentRunState` | 流式运行态（loading / streaming / 思考等级 / 队列）与跨域共享 ref |
| `hooks/useAgentMic` | 麦克风语音输入 |
| `hooks/useAgentUiState` | 界面状态域：面板 / 弹层 / 模型选择器 / 任务卡 / 审批 |
| `hooks/useAgentPanels` | 三块可拖拽面板（预览区 / 侧边栏 / 右侧面板）宽度与手柄图标句柄 |
| `hooks/useAgentPreviewTabs` | 预览标签页、内容读取、视图模式、编辑态、HTML UI 注释、`openFileAtLine` |
| `hooks/useAgentScroll` | 滚动跟随 + 目录 rail |
| `hooks/useAgentHistoryWindow` | 历史消息渐进挂载：默认挂载最近 100 条，逐次向前追加 100 条并补偿滚动位置（数据不裁剪；目录与搜索已改走数据层，不再受挂载范围限制） |
| `hooks/useAgentMessageHeights` | 消息高度测量与缓存：ResizeObserver 实测每条已挂载消息高度，按 `msg.id` 缓存 + 内容指纹失效；流式中那条标记 volatile 不入缓存 |
| `hooks/useAgentVirtualMessages` | 消息级屏外卸载（measured spacer）：只挂载视口附近 + 常驻（流式 / 编辑中）的连续区间，区间外用等高占位顶住；未测高的消息一律不顶掉（宁可多挂不可跳） |
| `hooks/useAgentGit` | Git 变更与分支 |
| `hooks/useAgentSessionEffects` | 会话生命周期：持久化 / 播种 / 工作区同步 / 任务刷新 / 里程碑 / 会话终局 / pi 预热 |
| `hooks/useAgentViewEffects` | 视图副作用：侧栏可见性 / 跳行高亮 / 输入区测高 |
| `hooks/useAgentSessionActions` | 会话动作：队列补写 / 片段引用 / 停止生成 / 切换目录 / 重命名交互 |
| `hooks/useAgentCondense` | 上下文摘要压缩：自动触发 + 手动触发 |
| `hooks/useAgentSlashActions` | 动作型 `/命令` 分发 |
| `hooks/useAgentLoop` | Agent 循环域：`runPiTurn`（单轮运行）+ `handleSend`（发送编排） |
| `hooks/useAgentMessageActions` | 消息级操作：复制 / 重新生成 / 重发 / 分支 / 编辑 / 撤销 / 消息行动作 ref |
| `hooks/useAgentModals` | 提示词 / 知识库弹层、欢迎页建议与注释发送 |
| `hooks/useAgentInputHints` | `@` 提及 + 斜杠命令两个补全浮层 |
| `hooks/useAgentInputKeyboard` | 输入框键盘处理与 `onChange` 补全检测 |
| `hooks/useAgentModelControl` | 模型卡片「启动 / 停止」编排 |

## 长内容窗口阈值

四处长内容走同一套行窗口（`useRowWindow` / `WindowedRows`），阈值与行高如下。
**行高是窗口化的前提**：固定行高才能由 `scrollTop` 直接算出首行索引，不必逐行测量；
代价是窗口态不折行（超长行横向滚动或省略号）。改任一数值都要同步
`styles/agent-code.css` 末尾「长内容行窗口：固定行高契约」一节，否则滚动会行错位。

| 位置 | 阈值 | 行高 | 超阈值时的取舍 |
| --- | --- | --- | --- |
| 思考完整文本（`ThinkTextContent`） | 预览超 `THINK_PREVIEW_LINES` / `THINK_PREVIEW_CHARS` | 23 | 默认只挂有界预览，「查看完整思考」才走行窗口 |
| 工具结果 / 写入内容（`LinedPre`） | `LINED_PRE_WINDOW_CHARS` = 20000 字符 | 17 | 行号类；阈值以下保留逐行 DOM 与原折行视觉 |
| 非行号工具结果（`ToolResultView`） | `LINED_PRE_WINDOW_CHARS` = 20000 字符 | 17 | 超长文本不再 `split('\n')`，行数改报字符数 |
| Diff（`ToolEditDiff`） | `DIFF_WINDOW_ROWS` = 400 行 | 17 | 窗口态改单行 nowrap（原 `pre-wrap` 行高不定） |
| 代码块（`CodeBlock`） | `CODE_WINDOW_LINES` = 300 行（完成态与流式态各判一次） | 20 | 完成态超阈值**省略语法高亮**：整块 `hljs` 结果是一个 HTML 字符串，无法按行窗口化，逐行高亮又会因跨行字符串 / 注释错色 |

另：`AgentMessageSearch` 的匹配来源已从 DOM 改为数据层（逐条扫 `messages[i].content`），
因此屏外未挂载的消息也能被搜到；高亮仍走 CSS Custom Highlight API，只对已挂载的匹配建 Range，
未挂载的匹配项跳转时通过 `onEnsureMessage` 先请求挂载。

## 装配约定

- **域对象透传**：主组件把每个 hook 的完整返回值作为单个 prop（`projects` / `inputDomain` /
  `preview` / `hints` / `run` / `ui` / `condense` / `messageActions` / `scroll` / `git` / `mic` /
  `loop` / `panels` / `modals` / `sessionActions`）传给布局组件，避免铺开上百个平铺 props。
  各域内部增删成员时，类型经 `ReturnType<typeof hook>` 自动跟随。
- **整域保留 + 解构**：主组件用 `let xxx!: ReturnType<typeof useXxx>` 配合
  `const { ... } = (xxx = useXxx())`，同时拿到「整域对象」与「局部名」，两者都不丢。
- **跨域共享 ref**：`backupsRef` / `handleUndoRef` / `regenRollbackRef` 由主组件持有并注入各域。
