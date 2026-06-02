import React from 'react'
import { useNotificationStore } from '../store/notificationStore'
import { X, CheckCircle, AlertCircle, Info } from 'lucide-react'

const iconMap = {
  error: AlertCircle,
  success: CheckCircle,
  info: Info
}

const colorMap = {
  error: 'var(--danger)',
  success: 'var(--success)',
  info: 'var(--accent)'
}

export default function ToastContainer() {
  const toasts = useNotificationStore(s => s.toasts)
  const removeToast = useNotificationStore(s => s.removeToast)

  if (toasts.length === 0) return null

  return (
    <div style={{
      position: 'fixed', bottom: 24, right: 24, zIndex: 99999,
      display: 'flex', flexDirection: 'column', gap: 8,
      pointerEvents: 'none'
    }}>
      {toasts.map(toast => {
        const Icon = iconMap[toast.type]
        return (
          <div key={toast.id} style={{
            pointerEvents: 'auto',
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '10px 16px',
            borderRadius: 8,
            background: colorMap[toast.type],
            color: '#fff',
            fontSize: 13,
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
            maxWidth: 360
          }}>
            <Icon size={16} style={{ flexShrink: 0 }} />
            <span style={{ flex: 1 }}>{toast.message}</span>
            <button onClick={() => removeToast(toast.id)} style={{ background: 'none', border: 'none', color: '#fff', cursor: 'pointer', padding: 0, opacity: 0.7, flexShrink: 0 }}>
              <X size={14} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
