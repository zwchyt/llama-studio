import React, { useEffect, useMemo, useState } from 'react'
import { Check } from 'lucide-react'

/**
 * 圆形站点图标 —— 网络搜索卡（28px 列表）与抓取网页卡（20px 来源行）共用。
 *
 * favicon 由主进程抓取并落盘缓存（见 main/ipc.ts 的 handleFetchFavicon），取不到时
 * 回退「域名首字母 + 域名哈希底色」的色块，保证任何情况下首列都是一个稳定、
 * 彼此可区分的圆形标记，而不是一片空位。
 */
const FAVICON_FALLBACK_COLORS = [
  '#2563eb', '#7c3aed', '#0891b2', '#0d9488',
  '#ca8a04', '#ea580c', '#db2777', '#4f46e5'
]

/** 取主域名标签当首字母（www.weather.com.cn → weather）——比取末段（cn）有辨识度得多。 */
export function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./i, '') } catch { return '' }
}

function letterOf(host: string): string {
  const first = host.split('.')[0] ?? ''
  return (first[0] ?? '?').toUpperCase()
}

/** djb2 哈希：同一域名永远落到同一个颜色，列表里不会因为重渲染而跳色。 */
function colorOf(host: string): string {
  let h = 5381
  for (let i = 0; i < host.length; i++) h = ((h << 5) + h + host.charCodeAt(i)) >>> 0
  return FAVICON_FALLBACK_COLORS[h % FAVICON_FALLBACK_COLORS.length]!
}

// 同域名在一次会话里只问主进程一次（一次搜索常有多条结果同域，来源行也会重复问）。
const faviconCache = new Map<string, Promise<{ dataUrl?: string; error?: string }>>()

function loadFavicon(host: string): Promise<{ dataUrl?: string; error?: string }> {
  let p = faviconCache.get(host)
  if (!p) {
    p = Promise.resolve(window.api.fetchFavicon?.(host))
      .then((r) => r ?? { error: '图标接口不可用' })
      .catch(() => ({ error: '图标获取失败' }))
    faviconCache.set(host, p)
  }
  return p
}

export const SiteIcon = React.memo(function SiteIcon({ url, size = 28, showCheck = true }: {
  url: string
  /** 直径（px）。28 = 搜索卡结果列表；20 = 抓取网页卡的来源行 */
  size?: number
  /** 右下角小勾角标。只有 28px 档位做了尺寸适配，更小的尺寸传 false
   *  （卡头本来就有「✓ 完成」徽标，小图标上再挂一个角标只会糊成一团） */
  showCheck?: boolean
}) {
  const host = useMemo(() => hostOf(url), [url])
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const [broken, setBroken] = useState(false)

  useEffect(() => {
    let alive = true
    setDataUrl(null)
    setBroken(false)
    if (!host) { setBroken(true); return }
    loadFavicon(host).then((r) => {
      if (!alive) return
      if (r.dataUrl) setDataUrl(r.dataUrl)
      else setBroken(true)
    })
    return () => { alive = false }
  }, [host])

  const showImg = !!dataUrl && !broken
  return (
    <span
      className={`agent-site-icon${showImg ? '' : ' is-letter'}`}
      style={{ width: size, height: size, ...(showImg ? {} : { background: colorOf(host) }) }}
      aria-hidden
    >
      {showImg
        ? <img className="agent-site-icon-img" src={dataUrl!} alt="" onError={() => setBroken(true)} />
        : <span className="agent-site-icon-letter" style={{ fontSize: Math.max(9, Math.round(size * 0.43)) }}>{letterOf(host)}</span>}
      {showCheck && <span className="agent-site-icon-check"><Check size={8} strokeWidth={3.5} /></span>}
    </span>
  )
})
