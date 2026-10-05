// view_image 的工具结果卡片：把读进来的图片直接内联显示在工具卡里。
// 右侧预览面板也会同时展开（见 useAgentLoop 的 openPreviewRef），两边都展示——
// 卡里这份是「模型看了什么」的凭据，预览面板那份是给用户细看的完整视图。
//
// 结果文本是 JSON.stringify({ ok, path, mimeType, bytes, note })：
//   path 是已解析的工作区绝对路径 → 用 readFileBase64 读回 data URL 渲染 <img>
//   （不把 base64 存进会话 JSON，与 browser_screenshot 的 chatimg:// 引用同一个取舍）
//
// 卡片结构与其他工具一致，分两段（参数区由 ToolArgsView 渲染，这里只出结果）：
//   ① 图片 —— 图片本体，右上角给体积；点图放大走全屏遮罩层
//   ② 结果 —— 工具返回的全部字段摊成统一横向键值行（path / bytes 已在头部与①里，不重复）
import { useEffect, useMemo, useState } from 'react'
import ToolResultRows, { RawResultFallback, buildResultRows, parseResultObject } from './ToolResultRows'
import { formatBytes } from '../utils/format'

export default function ViewImageResult({ result }: { result?: string }) {
  const parsed = useMemo(() => parseResultObject(result), [result])
  const ok = parsed?.ok === true
  const path = parsed && typeof parsed.path === 'string' ? parsed.path : ''
  const bytes = parsed && typeof parsed.bytes === 'number' ? parsed.bytes : undefined
  // path 已在卡片头部（可点跳预览）、bytes 已作为图片题注，结果区不再重复成行
  const rows = useMemo(() => (parsed ? buildResultRows(parsed, ['path', 'bytes']) : []), [parsed])

  const [src, setSrc] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [zoomed, setZoomed] = useState(false)

  useEffect(() => {
    if (!ok || !path) return
    let alive = true
    setSrc(null)
    setErr(null)
    window.api.readFileBase64(path)
      .then((r) => {
        if (!alive) return
        if (r.success && r.dataUrl) setSrc(r.dataUrl)
        else setErr(r.error || '读取失败')
      })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : String(e)) })
    return () => { alive = false }
  }, [ok, path])

  // 结果不是预期 JSON（例如「图片读取未启用」这类异常文本）：不套图片段，原文放进结果框
  if (!parsed) return <RawResultFallback result={result} />
  return (
    <>
      {ok && path && (
        <div className="agent-tool-result">
          <div className="agent-tool-result-head">
            <span className="agent-tool-result-label">图片</span>
            <span className="agent-tool-result-actions">
              {bytes != null && <span className="agent-tool-shot-dims">{formatBytes(bytes)}</span>}
            </span>
          </div>
          {src ? (
            <img
              src={src}
              className="agent-tool-shot-img agent-tool-img-view"
              alt="查看的图片"
              title="点击放大"
              onClick={(e) => { e.stopPropagation(); setZoomed(true) }}
            />
          ) : (
            <div className="agent-tool-shot-loading">{err ? `图片读取失败：${err}` : '读取图片…'}</div>
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
        <div className="user-msg-lightbox" onClick={() => setZoomed(false)} title="点击任意处关闭">
          <img src={src} alt="查看的图片" />
        </div>
      )}
    </>
  )
}
