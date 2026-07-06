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
  buttonClass = ''
}: CustomSelectProps) {
  const [open, setOpen] = useState(false)
  const [hovered, setHovered] = useState('')
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const close = useCallback(() => { setOpen(false); setPanelStyle(null) }, [])

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
    document.addEventListener('mousedown', handleClick)
    window.addEventListener('resize', handleResize)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      window.removeEventListener('resize', handleResize)
    }
  }, [open, close])

  const openDropdown = () => {
    if (disabled) return
    if (open) { close(); return }
    if (btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect()
      const spaceBelow = window.innerHeight - rect.bottom
      const openUp = spaceBelow < 240
      const maxW = Math.max(rect.width, 200)
      setPanelStyle({
        position: 'fixed',
        left: Math.min(rect.left, window.innerWidth - maxW),
        minWidth: rect.width,
        maxWidth: Math.min(maxW, window.innerWidth - 16),
        top: openUp ? undefined : rect.bottom + 2,
        bottom: openUp ? window.innerHeight - rect.top + 2 : undefined,
        zIndex: 10000
      })
      setOpen(true)
    }
  }

  const strVal = String(value)
  const selectedLabel = options.find(o => o.value === strVal)?.label || strVal || placeholder

  return (
    <div style={{ display: 'inline-block', ...style }} className={className}>
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
          style={{
            ...panelStyle,
            background: 'var(--surface)',
            border: '1.5px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            boxShadow: 'var(--shadow-md)',
            maxHeight: 240,
            overflowY: 'auto'
          }}
        >
          {options.map(opt => (
            <div
              key={opt.value}
              style={{
                padding: '6px 10px', fontSize: 12, cursor: 'pointer',
                background: opt.value === strVal ? 'var(--bg)' : hovered === opt.value ? 'var(--surface-hover)' : 'transparent',
                whiteSpace: 'nowrap'
              }}
              onClick={() => { onChange(opt.value); close() }}
              onMouseEnter={() => setHovered(opt.value)}
              onMouseLeave={() => setHovered('')}
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
