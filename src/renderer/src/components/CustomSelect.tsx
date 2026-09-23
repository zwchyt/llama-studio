import React, { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'

interface Option {
  value: string
  label: string
}

interface CustomSelectProps {
  value: string | number
  onChange: (value: string) => void
  options: Option[]
  placeholder?: string
  disabled?: boolean
  'aria-label'?: string
  className?: string
  style?: React.CSSProperties
  buttonClass?: string
  panelClass?: string
  itemClass?: string
}

export default function CustomSelect({
  value,
  onChange,
  options,
  placeholder = '',
  disabled = false,
  'aria-label': ariaLabel,
  className = '',
  style,
  buttonClass = '',
  panelClass = '',
  itemClass = ''
}: CustomSelectProps) {
  const [open, setOpen] = useState(false)
  const [hovered, setHovered] = useState('')
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const close = useCallback(() => { setOpen(false); setPanelStyle(null) }, [])

  // 面板位置 = 按钮的实时位置（position: fixed + 打开瞬间算出的坐标）。
  // 抽成函数是为了让「打开」与「滚动时重新贴合」共用同一套算法，避免两处逻辑漂移。
  const computePanelStyle = useCallback((): React.CSSProperties | null => {
    const btn = btnRef.current
    if (!btn) return null
    const rect = btn.getBoundingClientRect()
    const spaceBelow = window.innerHeight - rect.bottom
    const openUp = spaceBelow < 240
    const maxW = Math.max(rect.width, 200)
    return {
      position: 'fixed',
      left: Math.min(rect.left, window.innerWidth - maxW),
      minWidth: rect.width,
      maxWidth: Math.min(maxW, window.innerWidth - 16),
      top: openUp ? undefined : rect.bottom + 2,
      bottom: openUp ? window.innerHeight - rect.top + 2 : undefined,
      zIndex: 10000
    }
  }, [])

  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (
        btnRef.current && !btnRef.current.contains(e.target as Node) &&
        panelRef.current && !panelRef.current.contains(e.target as Node)
      ) {
        close()
      }
    }
    function handleResize() { close() }
    // 面板是 fixed 定位、坐标取自打开瞬间，页面一滚它就会脱锚「凭空悬浮」在原处。
    // 这里监听任意祖先容器的滚动（scroll 事件不冒泡，所以用捕获阶段）把面板贴回按钮。
    // 面板自身的滚动（列表超过 maxHeight 时）必须排除，否则一滚列表就把它关掉了。
    // 用 rAF 合并同一帧内的多次滚动，避免长列表下每帧都触发一次重渲染。
    let raf = 0
    function handleScroll(e: Event) {
      if (panelRef.current && e.target instanceof Node && panelRef.current.contains(e.target)) return
      if (raf) return
      raf = window.requestAnimationFrame(() => {
        raf = 0
        const btn = btnRef.current
        if (!btn) return
        const rect = btn.getBoundingClientRect()
        // 按钮已被滚出视口：继续贴着它只会让面板飘到屏幕外，直接收起更干净
        if (rect.bottom < 0 || rect.top > window.innerHeight) { close(); return }
        setPanelStyle(computePanelStyle())
      })
    }
    document.addEventListener('mousedown', handleClick)
    window.addEventListener('resize', handleResize)
    document.addEventListener('scroll', handleScroll, true)
    return () => {
      if (raf) window.cancelAnimationFrame(raf)
      document.removeEventListener('mousedown', handleClick)
      window.removeEventListener('resize', handleResize)
      document.removeEventListener('scroll', handleScroll, true)
    }
  }, [open, close, computePanelStyle])

  const openDropdown = () => {
    if (disabled) return
    if (open) { close(); return }
    const style = computePanelStyle()
    if (style) { setPanelStyle(style); setOpen(true) }
  }

  const strVal = String(value)
  const selectedLabel = options.find(o => o.value === strVal)?.label || strVal || placeholder

  return (
    <div style={{ display: 'inline-block', maxWidth: '100%', ...style }} className={className}>
      <button
        ref={btnRef}
        className={`cmd-select${buttonClass ? ' ' + buttonClass : ''}`}
        style={{
          width: '100%', textAlign: 'left', cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.45 : 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
        }}
        onClick={openDropdown}
        disabled={disabled}
        aria-label={ariaLabel}
        type="button"
      >
        {selectedLabel}
      </button>
      {open && panelStyle && createPortal(
        <div
          ref={panelRef}
          className={panelClass || undefined}
          style={{
            ...panelStyle,
            background: 'var(--surface)',
            border: '1.5px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            boxShadow: 'var(--shadow-md)',
            maxHeight: 240,
            overflowY: 'auto',
            padding: 3
          }}
        >
          {options.map(opt => (
            <div
              key={opt.value}
              className={`${itemClass || ''}${opt.value === strVal ? ' active' : ''}`.trim()}
              style={{
                padding: '6px 10px', fontSize: 12, cursor: 'pointer',
                background: opt.value === strVal ? 'color-mix(in srgb, var(--accent) 10%, transparent)' : hovered === opt.value ? 'var(--surface-hover)' : 'transparent',
                borderRadius: 4,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%'
              }}
              onClick={() => { onChange(opt.value); close() }}
              onMouseEnter={() => setHovered(opt.value)}
              onMouseLeave={() => setHovered('')}
              title={opt.label}
            >
              {opt.label}
            </div>
          ))}
        </div>,
        document.body
      )}
    </div>
  )
}
