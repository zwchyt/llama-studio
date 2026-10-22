// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：文件树图片悬停缩略图的极简外部 store                                    ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// 缩略图此前存在 AgentFileTree 的 state 里，鼠标划过一张图片节点就会触发整棵树
// 递归重建 JSX（几百个节点 ≈ 10-30ms/次）。挪到组件外的 store 后，hover 只让
// 订阅者（一个浮层组件）重渲染，树本身一次都不重渲染。

// dataUrl：正常缩略图；note：图片超过缩略图上限时的说明文字（不能什么都不弹——
// 那会让人以为悬停预览坏了）
export type ImgThumb = { x: number; y: number; dataUrl?: string; note?: string } | null

let current: ImgThumb = null
const listeners = new Set<() => void>()

export function setImgThumb(next: ImgThumb): void {
  if (current === next) return
  current = next
  listeners.forEach(l => l())
}

export function subscribeImgThumb(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function getImgThumb(): ImgThumb {
  return current
}
