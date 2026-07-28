import React, { useState, useEffect } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import UpdateBanner, { useBackendUpdateVisible } from './UpdateBanner'
import AppUpdateBanner, { useAppUpdateVisible } from './AppUpdateBanner'

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
  const switcher = both ? (
    <span className="ub-switcher" title="切换更新通知">
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
