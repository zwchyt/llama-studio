import React, { useState, useEffect } from 'react'

const PALETTE = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#3b82f6', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16']

function hashIndex(s: string, mod: number): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return h % mod
}

interface Props {
  author: string
  avatarUrl?: string
  size?: number
  // 懒加载头像：仅当 avatarUrl 为空时调用（如 ModelScope 需走后端 API），失败回退首字母
  fetchAvatar?: () => Promise<string | null | undefined>
}

export default function ModelLogo({ author, avatarUrl, size = 36, fetchAvatar }: Props) {
  const org = (author || '?').split('/')[0]
  const initials = org.slice(0, 2).toUpperCase()
  const color = PALETTE[hashIndex(org, PALETTE.length)]
  const [url, setUrl] = useState(avatarUrl || '')
  const [errored, setErrored] = useState(false)

  useEffect(() => {
    setUrl(avatarUrl || '')
    setErrored(false)
  }, [avatarUrl])

  useEffect(() => {
    if (avatarUrl || !fetchAvatar) return
    let cancelled = false
    fetchAvatar().then(res => { if (!cancelled && res) setUrl(res) }).catch(() => {})
    return () => { cancelled = true }
  }, [avatarUrl, fetchAvatar])

  if (url && !errored) {
    return (
      <img
        src={url}
        alt={org}
        loading="lazy"
        onError={() => setErrored(true)}
        style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 8 }}
      />
    )
  }
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: color,
        color: '#fff',
        fontWeight: 700,
        fontSize: size * 0.4,
        borderRadius: 8,
        userSelect: 'none'
      }}
    >
      {initials}
    </div>
  )
}
