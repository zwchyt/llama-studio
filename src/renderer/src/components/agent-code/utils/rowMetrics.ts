// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：长内容行窗口的固定行高契约（TS 侧唯一出处）                              ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// 行窗口（WindowedRows / WindowedText）要求「行高固定 + 行不折行」，首行索引才能由
// scrollTop 直接算出，不必逐行测量（见 utils/textRows.ts）。每处启用行窗口的地方都要有
// 对应的固定行高类，下面的数值必须与 styles/agent-code.css「长内容行窗口：固定行高契约」
// 逐条对齐；改动任一处务必同步 CSS，否则窗口滚动时行错位。
//
// 集中在这里而不是各组件各写一份：此前 5 个文件各有一个常量，改一个数值要翻 5 处，
// 且没有任何一处能看出「总共有几种行高」。

/** 思考完整文本窗口：.agent-window（WindowedText 默认值） */
export const WINDOW_ROW_HEIGHT = 23
export const WINDOW_VIEW_HEIGHT = 276

/** 工具结果 / 写入内容窗口：.agent-tool-lined-window 与 .agent-tool-result-window */
export const TOOL_RESULT_ROW_HEIGHT = 17
export const TOOL_RESULT_VIEW_HEIGHT = 360

/** Diff 行窗口：.agent-tool-diff-window */
export const DIFF_ROW_HEIGHT = 17
export const DIFF_VIEW_HEIGHT = 420

/** 代码块行窗口：.chat-code-window（样式在 code-block.css） */
export const CODE_ROW_HEIGHT = 20
export const CODE_VIEW_HEIGHT = 420
