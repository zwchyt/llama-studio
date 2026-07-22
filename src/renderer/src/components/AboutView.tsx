import React, { useState } from 'react'
import { ExternalLink, Info, ShieldAlert, FileText, Heart, RotateCw } from 'lucide-react'
import { useStore } from '../store/useStore'
import { shallow } from 'zustand/shallow'
import { notify } from '../store/notificationStore'
import '../styles/about.css'

export default function AboutView() {
  const openLink = (url: string) => {
    window.api.openExternal(url)
  }

  const [checking, setChecking] = useState(false)
  const { appReleaseInfo, setAppReleaseInfo, setAppCheckingUpdate, setAppUpdateDismissed } = useStore(s => ({
    appReleaseInfo: s.appReleaseInfo,
    setAppReleaseInfo: s.setAppReleaseInfo,
    setAppCheckingUpdate: s.setAppCheckingUpdate,
    setAppUpdateDismissed: s.setAppUpdateDismissed,
  }), shallow)

  // 获取当前版本号（从 package.json version）
  const currentVersion = appReleaseInfo?.currentVersion || '...'

  const handleCheckUpdate = async () => {
    setChecking(true)
    try {
      const info = await window.api.checkAppUpdate()
      setAppReleaseInfo(info)
      setAppCheckingUpdate(false)
      if (info.available) {
        setAppUpdateDismissed(false)
        notify(`发现新版本 ${info.latestVersion}！`, 'success')
      } else {
        notify(`当前版本 ${info.currentVersion} 已是最新`, 'info')
      }
    } catch (e) {
      notify(`检查更新失败：${String(e)}`, 'error')
    } finally {
      setChecking(false)
    }
  }
  return (
    <div className="about-container">
      <div className="page-header">
        <div>
          <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <img src="./full-logo.png" alt="hexllama" style={{ height: 32, imageRendering: 'crisp-edges' }} draggable={false} />
          </h1>
          <p className="page-subtitle">一个快速、美观的本地 LLM 管理图形界面</p>
        </div>
      </div>

      <section className="about-section" style={{ marginBottom: 16 }}>
        <div className="about-card about-card-version">
          <div>
            <div className="about-version-label">
              llama-studio {currentVersion}
            </div>
            {appReleaseInfo?.available ? (
              <div className="about-version-status available">
                新版本 {appReleaseInfo.latestVersion} 可用
              </div>
            ) : appReleaseInfo?.currentVersion && (
              <div className="about-version-status latest">
                已是最新版本
              </div>
            )}
          </div>
          <button
            className="btn btn-ghost btn-sm"
            onClick={handleCheckUpdate}
            disabled={checking}
            style={{ whiteSpace: 'nowrap' }}
          >
            {checking ? (
              <><RotateCw size={14} className="spin" style={{ marginRight: 4 }} /> 检查中...</>
            ) : (
              <><RotateCw size={14} style={{ marginRight: 4 }} /> 检查更新</>
            )}
          </button>
        </div>
      </section>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
        <section className="about-section">
          <h2 className="about-section-title">
            <Heart size={16} style={{ color: 'var(--danger)' }} /> 鸣谢
          </h2>
          <div className="about-card">
            <p>
              本项目之所以存在，完全归功于 <strong>llama.cpp</strong>，由 <strong>Georgi Gerganov</strong> 创建。
              请考虑支持 llama.cpp 社区所做的出色工作。
            </p>
            <div className="about-card-actions gap-16">
              <button className="btn btn-ghost btn-sm" onClick={() => openLink('https://github.com/ggerganov')}>
                <ExternalLink size={14} /> @ggerganov
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => openLink('https://github.com/ggml-org')}>
                <ExternalLink size={14} /> ggml-org
              </button>
            </div>
          </div>
        </section>
        <section className="about-section">
          <h2 className="about-section-title">
            <Info size={16} /> 关于开发者
          </h2>
          <div className="about-card">
            <p>
              <strong>Hexllama</strong> 由 <strong>Anderson Nascimento</strong> 开发，他是一位热爱本地 AI 的巴西软件工程师。
            </p>
            <div className="about-card-actions">
              <button className="btn btn-ghost btn-sm" onClick={() => openLink('https://github.com/andersondanieln')}>
                <ExternalLink size={14} /> GitHub
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => openLink('https://github.com/andersondanieln/hexllama')}>
                <ExternalLink size={14} /> 代码仓库
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => openLink('https://www.linkedin.com/in/andersondn')}>
                <ExternalLink size={14} /> LinkedIn
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => openLink('https://andercoder.com/hexllama')}>
                <ExternalLink size={14} /> 网站
              </button>
            </div>
          </div>
        </section>
        <section className="about-section">
          <h2 className="about-section-title">
            <ExternalLink size={16} /> 本分支
          </h2>
          <div className="about-card">
            <p>
              <strong>llama-studio</strong> 是 hexllama 的中文定制分支，由 <strong>zwchyt</strong> 维护。
              在原版基础上增加了 GLM-OCR 图片识别、自定义提示词、外部/图片模型管理等本地化功能。
            </p>
            <div className="about-card-actions">
              <button className="btn btn-ghost btn-sm" onClick={() => openLink('https://github.com/zwchyt/llama-studio')}>
                <ExternalLink size={14} /> GitHub 仓库
              </button>
            </div>
          </div>
        </section>
        <div className="about-grid">
          <section className="about-section">
            <h2 className="about-section-title">
              <FileText size={16} /> 使用条款
            </h2>
            <div className="about-card tall">
              <p>
                本软件按<strong>"原样"</strong>提供，不提供任何明示或暗示的担保。
                在任何情况下，作者或版权持有人均不对任何索赔、损害或其他责任负责，
                无论是因软件或软件的使用或其他交易而产生的合同、侵权或其他方面的责任。
              </p>
            </div>
          </section>
          <section className="about-section">
            <h2 className="about-section-title">
              <ShieldAlert size={16} /> 隐私政策
            </h2>
            <div className="about-card tall">
              <p>
                <strong>Hexllama 不会收集或传输任何用户数据。</strong> 本应用程序中绝对没有遥测、跟踪或分析功能。
                <br /><br />
                但是，请注意，下载模型或执行第三方二进制文件（如 Hugging Face API 或 llama.cpp 可执行文件）可能会受其各自的隐私政策约束。
              </p>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
