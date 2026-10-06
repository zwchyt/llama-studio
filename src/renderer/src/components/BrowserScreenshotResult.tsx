// browser_screenshot 的工具结果卡片：截图以图片附件形态出现在聊天里。
// 工具结果文本只含 chatimg:// 引用与尺寸，PNG 由 read-chat-image 按需从磁盘读回，
// 因此会话 JSON 里不会长期存 base64。
//
// 卡片结构与其它工具一致，分两段（参数区由 ToolArgsView 渲染在上方）：
//   ① 截图 —— 图片本体，题注给尺寸；点图放大走全屏遮罩层
//   ② 结果 —— 工具返回的全部字段，摊成统一的「标签 | 值」参数框（不省略任何字段）
// 尺寸已在①的题注里，结果区不再重复成行。
import { useEffect, useMemo, useState } from 'react'
import ToolResultRows, { RawResultFallback, buildResultRows, parseResultObject } from './ToolResultRows'
import { useBubbleTip } from './useBubbleTip'

export default function BrowserScreenshotResult({ result }: { result?: string }) {
  const parsed = useMemo(() => parseResultObject(result), [result])
  const rows = useMemo(() => (parsed ? buildResultRows(parsed, ['width', 'height']) : []), [parsed])
  const ok = parsed?.ok === true
  const imageId = parsed && typeof parsed.imageId === 'string' ? parsed.imageId : undefined
  const dims = parsed && typeof parsed.width === 'number' && typeof parsed.height === 'number'
    ? `${parsed.width}×${parsed.height}`
    : ''

  const [src, setSrc] = useState<string | null>(null)
  const [zoomed, setZoomed] = useState(false)
  // 原生 title 换自定义气泡（与导航栏同款，见 useBubbleTip；return 里放一次 {tipNode}）
  const { tipHandlers: tip, tipNode } = useBubbleTip()

  useEffect(() => {
    if (!ok || !imageId) return
    let alive = true
    window.api.readChatImage(imageId).then((d) => { if (alive) setSrc(d) }).catch(() => { })
    return () => { alive = false }
  }, [ok, imageId])

  // 结果不是预期 JSON（例如异常文本）：不套截图段，直接把原文放进结果框
  if (!parsed) return <RawResultFallback result={result} />
  return (
    <>
      {tipNode}
      {ok && (
        <div className="agent-tool-result">
          <div className="agent-tool-result-head">
            <span className="agent-tool-result-label">截图</span>
            {dims && (
              <span className="agent-tool-result-actions">
                <span className="agent-tool-shot-dims">{dims}</span>
              </span>
            )}
          </div>
          {src ? (
            <img
              src={src}
              className="agent-tool-shot-img"
              alt="页面截图"
              {...tip('点击放大')}
              onClick={(e) => { e.stopPropagation(); setZoomed(true) }}
            />
          ) : (
            <div className="agent-tool-shot-loading">读取截图…</div>
          )}
        </div>
      )}
      <div className="agent-tool-result">
        <div className="agent-tool-result-head">
          <span className="agent-tool-result-label">结果</span>
        </div>
        <ToolResultRows rows={rows} />
      </div>
      {zoomed && src && (
        <div className="user-msg-lightbox" onClick={() => setZoomed(false)} {...tip('点击任意处关闭')}>
          <img src={src} alt="页面截图" />
        </div>
      )}
    </>
  )
}
