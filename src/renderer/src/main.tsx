// 必须排在 react-dom 之前：ReactDOM 在模块求值阶段就读 __REACT_DEVTOOLS_GLOBAL_HOOK__，
// 晚一步就拦不住「Download the React DevTools」提示（见该文件内的说明）。
import './devtools-silence'
import ReactDOM from 'react-dom/client'
import App from './App'
import ToastContainer from './components/ToastContainer'
import { notify } from './store/notificationStore'
import './styles/global.css'
import './styles/fonts.css'
import './store/fontStore' // 启动时应用已保存的字体预设（模块副作用）
import './cursor-theme'

// 全局兜底：捕获未处理的 Promise rejection（防止 IPC 裸 await 导致界面卡死）
window.addEventListener('unhandledrejection', (e) => {
  console.error('[unhandledrejection]', e.reason)
  const msg = e.reason instanceof Error ? e.reason.message : String(e.reason)
  notify(`未捕获的错误：${msg}`, 'error')
  e.preventDefault()
})

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <>
    <App />
    <ToastContainer />
  </>
)
