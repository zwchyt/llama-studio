import React, { useState, useEffect, useRef } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import UpdateBanner, { useBackendUpdateVisible } from './UpdateBanner'
import AppUpdateBanner, { useAppUpdateVisible } from './AppUpdateBanner'
import { playEvent } from '../utils/sound'

/**
 * 更新横幅统一调度：
 * 同时存在 llama.cpp 与 llama-studio 更新时合并为一条可切换的横幅，
 * 隐藏的一条保持挂载，下载等状态不丢失。
 */
export default function UpdateBannerGroup() {
  const backendVisible = useBackendUpdateVisible()
  const appVisible = useAppUpdateVisible()
  const [active, setActive] = useState<'backend' | 'app'>('backend')
  const both = backendVisible && appVisible

  // 当前展示的一条被关闭/跳过后，自动切到剩余的一条
  useEffect(() => {
    if (active === 'backend' && !backendVisible && appVisible) setActive('app')
    if (active === 'app' && !appVisible && backendVisible) setActive('backend')
  }, [active, backendVisible, appVisible])

  const toggle = () => setActive(a => (a === 'backend' ? 'app' : 'backend'))

  // 第一次发现有更新时响一次：横幅是静默出现的，不看界面就永远发现不了。
  // 只响一次，关掉再查出别的更新不重复打扰。
  const announcedRef = useRef(false)
  useEffect(() => {
    if (announcedRef.current || (!backendVisible && !appVisible)) return
    announcedRef.current = true
    playEvent('notification')
  }, [backendVisible, appVisible])
  const switcher = both ? (
    <span className="ub-switcher">
      <button className="dismiss" onClick={toggle}><ChevronLeft size={13} /></button>
      <span className="ub-switch-count">{active === 'backend' ? 1 : 2}/2</span>
      <button className="dismiss" onClick={toggle}><ChevronRight size={13} /></button>
    </span>
  ) : null

  return (
    <>
      <UpdateBanner hidden={both && active !== 'backend'} switcher={switcher} />
      <AppUpdateBanner hidden={both && active !== 'app'} switcher={switcher} />
    </>
  )
}
