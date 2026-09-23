import React from 'react'
import { useStore } from '../store/useStore'
import { Play, Search, HardDrive, Settings } from 'lucide-react'
import '../styles/welcome.css'

export default function WelcomeView() {
  const setView = useStore(s => s.setView)

  return (
    <div className="welcome-view">
      <div className="welcome-content">
        <div className="welcome-hero">
          <div className="welcome-icon-wrap">
            <img src="./icon.png" alt="llama-studio Icon" className="welcome-icon" />
          </div>
          <span className="welcome-chip welcome-chip-1"><Play size={12} /> 一键运行</span>
          <span className="welcome-chip welcome-chip-2"><Search size={12} /> GGUF</span>
          <span className="welcome-chip welcome-chip-3"><HardDrive size={12} /> 本地推理</span>
        </div>
        <h1 className="welcome-title">llama-studio</h1>
        <p className="welcome-subtitle">All AI-Glory to the Llama.cpp</p>
        <p className="welcome-desc">管理并一键运行 llama.cpp 模型的图形化界面</p>
        <div className="welcome-actions">
          <button className="btn btn-primary welcome-btn" onClick={() => setView('cards')}>
            <Play size={16} />
            前往启动模型
          </button>
          <button className="btn btn-secondary welcome-btn" onClick={() => setView('hub')}>
            <Search size={16} />
            从模型中心下载
          </button>
          <button className="btn btn-secondary welcome-btn" onClick={() => setView('models')}>
            <HardDrive size={16} />
            查看本地模型
          </button>
          <button className="btn btn-secondary welcome-btn" onClick={() => setView('settings')}>
            <Settings size={16} />
            设置
          </button>
        </div>
      </div>
    </div>
  )
}
