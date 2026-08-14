import React from 'react'
import { MenuIcon, LayoutGridIcon } from '@animateicons/react/lucide'
import { useLayoutStore } from '../store/layoutStore'
import '../styles/topnav.css'

/**
 * 布局模式切换按钮：固定悬浮在标题栏右侧（窗口控制按钮左边），
 * 两种布局下始终可见，点击即在「侧边栏布局」与「顶部导航布局」之间切换。
 * 不侵入旧的 TitleBar / Sidebar 代码。
 */
export default function LayoutModeToggle() {
  const mode = useLayoutStore(s => s.mode)
  const setMode = useLayoutStore(s => s.setMode)
  const isTopnav = mode === 'topnav'

  return (
    <button
      className="layout-mode-toggle"
      onClick={() => setMode(isTopnav ? 'sidebar' : 'topnav')}
      title={isTopnav ? '切换为侧边栏布局' : '切换为顶部导航布局'}
      aria-label="切换界面布局"
    >
      {isTopnav ? <MenuIcon size={15} className="nav-animate-icon" /> : <LayoutGridIcon size={15} className="nav-animate-icon" />}
    </button>
  )
}
