import React from 'react'
import { useStore } from '../store/useStore'
import { shallow } from 'zustand/shallow'
import { RefreshCw } from 'lucide-react'
interface Props {
  onCheckUpdates: () => void
}
export default function Titlebar({ onCheckUpdates }: Props) {
  const { checkingUpdate } = useStore(s => ({ checkingUpdate: s.checkingUpdate }), shallow)
  return (
    <header className="titlebar">
      {}
      <div className="titlebar-logo">
        <img
          src="./full-logo.png"
          alt="hexllama"
          className="titlebar-logo-img"
          draggable={false}
        />
      </div>
      {}
      <div className="titlebar-drag-region" />
      <div className="titlebar-actions">
        <button
          className={`btn btn-ghost btn-icon ${checkingUpdate ? 'spin-btn' : ''}`}
          onClick={onCheckUpdates}
          title="检查 llama.cpp 更新"
          disabled={checkingUpdate}
        >
          <RefreshCw size={15} className={checkingUpdate ? 'spin' : ''} />
        </button>
      </div>
    </header>
  )
}
