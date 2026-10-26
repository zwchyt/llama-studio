// 必须排在 react-dom 之前：ReactDOM 在模块求值阶段就读 __REACT_DEVTOOLS_GLOBAL_HOOK__，
// 晚一步就拦不住「Download the React DevTools」提示（见该文件内的说明）。
import './devtools-silence'
// 基础样式必须排在 App 之前：App 的传递依赖（theme-dark / sidebar / titlebar 等）
// 会在模块求值阶段注入各自的样式，global.css 排在后面就会反过来盖住它们。
import './styles/global.css'
import ReactDOM from 'react-dom/client'
import App from './App'
import ToastContainer from './components/ToastContainer'
import { notify } from './store/notificationStore'
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
