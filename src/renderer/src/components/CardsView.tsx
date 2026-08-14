import React, { useMemo } from 'react'
import { useStore } from '../store/useStore'
import { shallow } from 'zustand/shallow'
import ModelCard from './ModelCard'
import { PlusIcon, UploadIcon, SearchIcon } from '@animateicons/react/lucide'
import { notify } from '../store/notificationStore'
import { safeCall } from '../utils/safeCall'
import type { Template } from '../../../shared/types'
import '../styles/cards.css'
export default function CardsView() {
  const { cards, templatesReady, setShowCreateModal, addCard, templateSearch, setTemplateSearch } = useStore(
    s => ({ cards: s.cards, templatesReady: s.templatesReady, setShowCreateModal: s.setShowCreateModal, addCard: s.addCard, templateSearch: s.templateSearch, setTemplateSearch: s.setTemplateSearch }),
    shallow
  )
  async function handleImport() {
    const template = await safeCall(() => window.api.importTemplate(), '导入模板失败')
    if (template) {
      addCard(template as Template)
      notify('导入成功', 'success')
    }
  }
  const filtered = useMemo(() => {
    const q = templateSearch.trim().toLowerCase()
    if (!q) return cards
    return cards.filter(c => c.template.name.toLowerCase().startsWith(q))
  }, [cards, templateSearch])
  return (
    <div className="templates-view">
      <div className="page-header">
        <div>
          <h1 className="page-title">
            模型卡片
            {cards.length > 0 && (
              <span className="header-count-badge" title={`${filtered.length} / ${cards.length} 个模板`}>
                {filtered.length}
              </span>
            )}
          </h1>
        </div>
        <div className="page-actions">
          {cards.length > 0 && (
            <div className="template-search-bar">
              <SearchIcon size={14} className="nav-animate-icon" style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
              <input
                type="text"
                className="template-search-input"
                placeholder="搜索模板..."
                value={templateSearch}
                onChange={e => setTemplateSearch(e.target.value)}
              />
              {templateSearch && (
                <button
                  className="template-search-clear"
                  onClick={() => setTemplateSearch('')}
                >×</button>
              )}
            </div>
          )}
          <button className="btn header-input-btn" onClick={handleImport}>
            <UploadIcon size={15} className="nav-animate-icon" />
            导入
          </button>
          <button className="btn header-input-btn" onClick={() => setShowCreateModal(true)}>
            <PlusIcon size={15} className="nav-animate-icon" />
            新建模板
          </button>
        </div>
      </div>
      {!templatesReady ? (
        // 模板列表加载中：骨架占位（避免先闪"还没有模板"空态、卡片随后才蹦出的观感）
        <div className="cards-grid cards-grid--loading">
          {Array.from({ length: 6 }).map((_, i) => (
            <div className="card card-skeleton" key={i}>
              <div className="card-skeleton-icon" />
              <div className="card-skeleton-line" />
              <div className="card-skeleton-line short" />
            </div>
          ))}
        </div>
      ) : cards.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="4" />
              <path d="M12 8v8M8 12h8" />
            </svg>
          </div>
          <h3>还没有模板</h3>
          <p>从本地 GGUF 创建，或从文件导入，即可一键配置并启动 llama.cpp 模型。</p>
          <div className="empty-state-actions">
            <button className="btn btn-primary" onClick={() => setShowCreateModal(true)}>
              <PlusIcon size={15} className="nav-animate-icon" />
              新建模板
            </button>
            <button className="btn btn-secondary" onClick={handleImport}>
              <UploadIcon size={15} className="nav-animate-icon" />
              导入
            </button>
          </div>
        </div>
      ) : filtered.length === 0 ? (
        <div className="empty-state" style={{ padding: '40px 24px' }}>
          <h3 style={{ fontSize: 15 }}>无匹配结果</h3>
          <p>未找到匹配 "{templateSearch}" 的模板。</p>
          <button className="btn btn-ghost" onClick={() => setTemplateSearch('')}>清除搜索</button>
        </div>
      ) : (
        <div className="cards-grid">
          {filtered.map((card) => (
            <ModelCard key={card.template.id} card={card} />
          ))}
          <button className="add-card" onClick={() => setShowCreateModal(true)}>
            <PlusIcon size={28} className="nav-animate-icon" />
            <span>添加模板</span>
          </button>
        </div>
      )}
    </div>
  )
}
