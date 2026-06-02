import React from 'react'
import { useStore } from '../store/useStore'
import { Play, Search, HardDrive, Settings } from 'lucide-react'

export default function WelcomeView() {
  const setView = useStore(s => s.setView)

  return (
    <div className="welcome-view">
      <div className="welcome-content">
        <img src="./icon.png" alt="Hexllama Icon" className="welcome-icon" />
        <h1 className="welcome-title">Hexllama</h1>
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
