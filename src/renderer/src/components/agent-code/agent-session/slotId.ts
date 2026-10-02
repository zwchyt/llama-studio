// 应用左侧导航栏底部那个槽的 DOM id。
//
// ⚠️ 刻意独立成文件，不要合并回 AgentSessionSidebar.tsx。
// Sidebar.tsx（入口模块，App 直接静态引入）只需要这个字符串常量，但它原来是从
// AgentSessionSidebar.tsx 里 `import { AGENT_SESSION_SLOT_ID }` 取的 —— 那会把
// AgentSessionSidebar → agent-message → markdown/markstream → markstream-react +
// highlight.js + katex + mermaid 整条依赖链拉进入口 chunk。
// （同类陷阱在 monaco 与 xterm 上各出现过一次，都是「一个常量/小函数把整棵子树带进首屏」。）
// 抽出来之后，AgentSessionSidebar 只由 AgentCodeViewLayout（已是 lazy）引用。

/** AgentCodeViewLayout 把会话侧栏 portal 到这个槽；Sidebar.tsx 负责渲染这个空槽。 */
export const AGENT_SESSION_SLOT_ID = 'sidebar-agent-slot'
