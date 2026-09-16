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
| `agent-message/` | 消息流：`ThinkBlock` 家族 / `StreamingContent` / `AgentMessageRow` / `UserMessageEntry` / `AgentTopBarCtx` / `TopbarBtn` / `renderSegmentsFor` |
| `agent-tools/` | 工具卡：`TOOL_META` / `ToolCallCard` / `ToolResultView` / `FileChangeSummary` |
| `agent-diff/` | Diff：`computeSplitDiff` / `getEditDiffStat` / `ToolEditDiff` |
| `agent-panels/` | 面板：`AuditPanel` / `MemoryPanel` / `DebugPanel` |
| `agent-task/` | 待办视觉：`RollDigit` / `TaskCheckIcon` / `TaskPieIcon` |
| `agent-session/` | 会话视图：`AgentSessionSidebar`（项目 / 会话树） |
| `agent-preview/` | 预览视图：`AgentPreviewSlot`（文件树 / 浏览器 / 终端 / 变更 / 预览） |
| `agent-input/` | 输入视图：`AgentInputArea`（输入框 / 附件 / 补全浮层 / 状态栏） |

## 纯函数与类型

| 目录 / 文件 | 职责 |
| --- | --- |
| `types/index.ts` | 跨模块共享类型（`PreviewTab` / `CodeSnippet` / `FlatFileEntry` / `AgentMsgRowActions` …） |
| `utils/ids` `paths` `format` `text` | ID、路径、格式化、文本处理 |
| `utils/mathHtml` `audio` `fileExt` `dom` | KaTeX 公式、音频编码、扩展名集合、DOM 辅助 |
| `utils/constants` | 共享常量（含 `GIT_DIFF_TAB` / `KEEP_RECENT_TURNS`） |
| `utils/condensePrompt` | 上下文压缩提示词与消息序列化（`SUMMARY_PROMPT` / `buildApiMessagesFull` / `wrapUntrustedFileContent` …） |

## 功能域 hook

| Hook | 职责 |
| --- | --- |
| `hooks/useAgentProjects` | 项目 / 会话列表状态与增删改 |
| `hooks/useAgentInput` | 输入域：正文 / `textareaRef` / 打包 chip / 附件 / 引用胶囊 / 代码片段 / 历史回溯 / 选区浮层 |
| `hooks/useAgentRunState` | 流式运行态（loading / streaming / 思考等级 / 队列）与跨域共享 ref |
| `hooks/useAgentMic` | 麦克风语音输入 |
| `hooks/useAgentUiState` | 界面状态域：面板 / 弹层 / 模型选择器 / 任务卡 / 审批 |
| `hooks/useAgentPanels` | 三块可拖拽面板（预览区 / 侧边栏 / 右侧面板）宽度与手柄图标句柄 |
| `hooks/useAgentPreviewTabs` | 预览标签页、内容读取、视图模式、编辑态、HTML UI 注释、`openFileAtLine` |
| `hooks/useAgentScroll` | 滚动跟随 + 目录 rail |
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

## 装配约定

- **域对象透传**：主组件把每个 hook 的完整返回值作为单个 prop（`projects` / `inputDomain` /
  `preview` / `hints` / `run` / `ui` / `condense` / `messageActions` / `scroll` / `git` / `mic` /
  `loop` / `panels` / `modals` / `sessionActions`）传给布局组件，避免铺开上百个平铺 props。
  各域内部增删成员时，类型经 `ReturnType<typeof hook>` 自动跟随。
- **整域保留 + 解构**：主组件用 `let xxx!: ReturnType<typeof useXxx>` 配合
  `const { ... } = (xxx = useXxx())`，同时拿到「整域对象」与「局部名」，两者都不丢。
- **跨域共享 ref**：`backupsRef` / `handleUndoRef` / `regenRollbackRef` 由主组件持有并注入各域。
