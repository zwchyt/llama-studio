// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：agent-code 共享常量（时序阈值 / 折叠上限）                              ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// 搬移自 AgentCodeView.tsx，数值与注释未变。放在共享 utils 是因为它们被
// 「消息渲染」与「Agent 循环 / 输入区」两侧同时引用，不属于任何单一模块。

// 工具 executing 状态的最小展示时长：Write/Edit 等本地 IO 工具执行往往不足一帧，
// 「写入中」徽标一闪而过肉眼不可见；结束时不足该时长会延迟置 done，保证状态可见。
export const MIN_EXEC_DISPLAY_MS = 400

// 输入框折叠：内容高度超过上限（≈3 行）即视为超长——输入中保持紧凑内部滚动，
// 失焦后整个输入框收成「已折叠 N 行」胶囊，点击展开到 55vh 编辑
export const INPUT_FOLD_CAP = 63

// Git 变更面板以「特殊预览标签」形式复用预览区；此哨兵路径标识该标签。
export const GIT_DIFF_TAB = '__agent_git_changes__'

// 内存图片在预览区里的哨兵标签键前缀。没有磁盘路径的图片（剪贴板粘贴、从浏览器或
// 看图软件拖入——webUtils.getPathForFile 对这类内存 File 取不到路径）走不了
// 「按路径读原文件」那条路，但图片数据本来就在 dataUrl 里，直接用它在预览区建一个
// 装好图的标签即可。与 GIT_DIFF_TAB 同一套做法：这个键只当标签的 key 与显示名，
// 绝不参与磁盘读写。前缀带 :// 是为了与真实路径不可能撞车（Windows 路径不会长这样）。
export const MEM_IMG_PREFIX = 'memimg://'

// 内存文本（气泡里点「折叠/引用/代码」胶囊 → 在预览区打开那段内容）。
// 与内存图片同性质：只当标签 key，不参与磁盘读写。
export const MEM_TEXT_PREFIX = 'memtext://'

// pi 模式的撤销备份在预览标签里用哨兵路径占位（真实文件在 main 侧，标签只存
// `pi-undo:<id>` 标记）。与上面两个前缀同性质：只当标签 key，不参与磁盘读写。
export const PI_UNDO_PREFIX = 'pi-undo:'

/** 是否为「背后没有真实文件」的哨兵标签路径（Git 变更面板 / 内存图片 / pi 撤销备份）。 */
export function isSentinelTabPath(p: string | null | undefined): boolean {
  if (!p) return false
  return p === GIT_DIFF_TAB || p.startsWith(MEM_IMG_PREFIX) || p.startsWith(MEM_TEXT_PREFIX) || p.startsWith(PI_UNDO_PREFIX)
}

// 图片内联的体积上限（字节）。read-file-base64 会把整份文件读成 data URL，
// 不设限时几十 MB 的图在悬停扫过时就能造成内存峰值与主线程卡顿。
// 三档按「看到的精度」从低到高：悬停缩略图最小，Markdown 内联居中，单独预览最大。
export const IMAGE_LIMITS = {
  THUMB: 2 * 1024 * 1024,
  INLINE: 4 * 1024 * 1024,
  PREVIEW: 8 * 1024 * 1024,
} as const
