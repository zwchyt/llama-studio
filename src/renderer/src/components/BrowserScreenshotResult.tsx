// browser_screenshot 的工具结果卡片：截图以图片附件形态出现在聊天里。
// 工具结果文本只含 chatimg:// 引用与尺寸，PNG 由 read-chat-image 按需从磁盘读回，
// 因此会话 JSON 里不会长期存 base64。
import { useEffect, useMemo, useState } from 'react'
import { Camera, XCircle } from 'lucide-react'
import type { BrowserScreenshotResult as ScreenshotMeta } from '../../../shared/browserPreview'

function parseMeta(result?: string): ScreenshotMeta | null {
  if (!result) return null
  try {
    const o = JSON.parse(result) as unknown
    if (o && typeof o === 'object' && typeof (o as { ok?: unknown }).ok === 'boolean') return o as ScreenshotMeta
  } catch { /* 非 JSON 结果（例如异常文本）交给默认结果视图 */ }
  return null
}

export default function BrowserScreenshotResult({ result }: { result?: string }) {
  const meta = useMemo(() => parseMeta(result), [result])
  const [src, setSrc] = useState<string | null>(null)
  const [zoomed, setZoomed] = useState(false)
  const ref = meta?.ok ? meta.imageId : undefined

  useEffect(() => {
    if (!ref) return
    let alive = true
    window.api.readChatImage(ref).then((d) => { if (alive) setSrc(d) }).catch(() => { })
    return () => { alive = false }
  }, [ref])

  if (!meta) return null
  if (!meta.ok) {
    return (
      <div className="agent-tool-shot err">
        <XCircle size={12} />
        <span>{meta.error || '截图失败'}</span>
      </div>
    )
  }
  const dims = meta.width && meta.height ? `${meta.width}×${meta.height}` : ''
  return (
    <div className="agent-tool-shot">
      <div className="agent-tool-shot-head">
        <Camera size={11} />
        <span>{meta.fullPage ? '整页截图' : '当前可视区域'}</span>
        {dims && <span className="agent-tool-shot-dims">{dims}</span>}
      </div>
      {src ? (
        <>
          <img src={src} className="user-msg-image" alt="页面截图" onClick={(e) => { e.stopPropagation(); setZoomed(true) }} />
          {zoomed && (
            <div className="user-msg-lightbox" onClick={() => setZoomed(false)} title="点击任意处关闭">
              <img src={src} alt="页面截图" />
            </div>
          )}
        </>
      ) : (
        <div className="agent-tool-shot-loading">读取截图…</div>
      )}
    </div>
  )
}
