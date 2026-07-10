import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import ToastContainer from './components/ToastContainer'
import { notify } from './store/notificationStore'
import './styles/global.css'
import './cursor-theme'

// 全局兜底：捕获未处理的 Promise rejection（防止 IPC 裸 await 导致界面卡死）
window.addEventListener('unhandledrejection', (e) => {
  console.error('[unhandledrejection]', e.reason)
  const msg = e.reason instanceof Error ? e.reason.message : String(e.reason)
  notify(`未捕获的错误：${msg}`, 'error')
  e.preventDefault()
})

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
    <ToastContainer />
  </React.StrictMode>
)
