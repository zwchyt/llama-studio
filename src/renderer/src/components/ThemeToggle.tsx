import React from 'react'
import { SunIcon, MoonIcon } from '@animateicons/react/lucide'
import { useThemeStore } from '../store/themeStore'
import '../styles/theme-dark.css'

/**
 * 应用主题切换按钮：固定悬浮在标题栏右侧（布局切换按钮左边），
 * 在浅色 / 黑暗主题之间一键切换，选择持久记忆，启动时自动恢复。
 * 黑暗主题全部规则在新建的 theme-dark.css 中，不侵入旧样式文件。
 */
export default function ThemeToggle() {
  const theme = useThemeStore(s => s.theme)
  const setTheme = useThemeStore(s => s.setTheme)
  const isDark = theme === 'dark'

  return (
    <button
      className="app-theme-toggle"
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect()
        setTheme(isDark ? 'light' : 'dark', {
          x: Math.round(r.left + r.width / 2),
          y: Math.round(r.top + r.height / 2),
        })
      }}
      title={isDark ? '切换为浅色主题' : '切换为黑暗主题'}
      aria-label="切换应用主题"
    >
      {isDark ? <SunIcon size={15} className="nav-animate-icon" /> : <MoonIcon size={15} className="nav-animate-icon" />}
    </button>
  )
}
