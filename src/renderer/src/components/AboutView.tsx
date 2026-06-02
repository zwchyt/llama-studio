import React from 'react'
import { ExternalLink, Info, ShieldAlert, FileText, Heart } from 'lucide-react'
export default function AboutView() {
  const openLink = (url: string) => {
    window.api.openExternal(url)
  }
  return (
    <div className="about-container" style={{ padding: 24, maxWidth: 800, margin: '0 auto', color: 'var(--text)' }}>
      <div className="page-header" style={{ marginBottom: 32 }}>
        <div>
          <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <img src="./full-logo.png" alt="hexllama" style={{ height: 32, imageRendering: 'crisp-edges' }} draggable={false} />
          </h1>
          <p className="page-subtitle">一个快速、美观的本地 LLM 管理图形界面</p>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
        { }
        <section className="about-section">
          <h2 style={{ fontSize: 16, display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <Heart size={16} style={{ color: 'var(--danger)' }} /> 鸣谢
          </h2>
          <div className="about-card" style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 20 }}>
            <p style={{ marginBottom: 16, lineHeight: 1.6 }}>
              本项目之所以存在，完全归功于 <strong>llama.cpp</strong>，由 <strong>Georgi Gerganov</strong> 创建。
              请考虑支持 llama.cpp 社区所做的出色工作。
            </p>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              <button className="btn btn-ghost btn-sm" onClick={() => openLink('https://github.com/ggerganov')}>
                <ExternalLink size={14} /> @ggerganov
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => openLink('https://github.com/ggml-org')}>
                <ExternalLink size={14} /> ggml-org
              </button>
            </div>
          </div>
        </section>
        { }
        <section className="about-section">
          <h2 style={{ fontSize: 16, display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <Info size={16} /> 关于开发者
          </h2>
          <div className="about-card" style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 20 }}>
            <p style={{ marginBottom: 16, lineHeight: 1.6 }}>
              <strong>Hexllama</strong> 由 <strong>Anderson Nascimento</strong> 开发，他是一位热爱本地 AI 的巴西软件工程师。
            </p>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
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
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
          { }
          <section className="about-section">
            <h2 style={{ fontSize: 16, display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <FileText size={16} /> 使用条款
            </h2>
            <div className="about-card" style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 20, height: '100%', fontSize: 13, color: 'var(--text-secondary)' }}>
              <p style={{ lineHeight: 1.6 }}>
                本软件按<strong>"原样"</strong>提供，不提供任何明示或暗示的担保。
                在任何情况下，作者或版权持有人均不对任何索赔、损害或其他责任负责，
                无论是因软件或软件的使用或其他交易而产生的合同、侵权或其他方面的责任。
              </p>
            </div>
          </section>
          { }
          <section className="about-section">
            <h2 style={{ fontSize: 16, display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <ShieldAlert size={16} /> 隐私政策
            </h2>
            <div className="about-card" style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 20, height: '100%', fontSize: 13, color: 'var(--text-secondary)' }}>
              <p style={{ lineHeight: 1.6 }}>
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
