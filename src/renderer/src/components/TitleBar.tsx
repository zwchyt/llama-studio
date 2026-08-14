import React from 'react'
import { Minus, Square, X } from 'lucide-react'
import { StepBackIcon, StepForwardIcon } from '@animateicons/react/lucide'
import { useSidebarStore } from '../store/sidebarStore'

export default function TitleBar() {
  const { collapsed, hoverExpanded, toggleCollapse } = useSidebarStore()

  return (
    <div className="titlebar">
      {/* 侧边栏折叠按钮 */}
      <button className="titlebar-btn titlebar-btn-sidebar" onClick={toggleCollapse} aria-label="切换侧边栏">
        {collapsed && !hoverExpanded ? <StepForwardIcon size={17} className="nav-animate-icon" /> : <StepBackIcon size={17} className="nav-animate-icon" />}
      </button>
      {/* 可拖拽区域 */}
      <div className="titlebar-drag" />
      {/* 窗口控制按钮 */}
      <div className="titlebar-controls">
        <button className="titlebar-btn" onClick={() => window.api.windowMinimize()} aria-label="最小化">
          <Minus size={14} />
        </button>
        <button className="titlebar-btn" onClick={() => window.api.windowMaximize()} aria-label="最大化">
          <Square size={11} />
        </button>
        <button className="titlebar-btn titlebar-btn-close" onClick={() => window.api.windowClose()} aria-label="关闭">
          <X size={14} />
        </button>
      </div>
    </div>
  )
}
