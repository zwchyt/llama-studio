import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { Sparkles, Plus, Trash2, RotateCcw } from 'lucide-react'
import { useImageStore, PRESET_GROUP_ORDER, type PromptPresetSlot } from '../store/imageStore'

/**
 * 提示词标签选择器：正/负向提示词的「标签」弹窗。
 * - 弹窗居中显示，一次只展示一个分类的标签
 * - 顶部为分类选项卡（常用 / 环境 / 风格 / …），点击切换分类
 * - 每个标签 = 英文 tag + 中文说明（如 masterpiece大师作品），点击把 tag 追加到输入框
 * - 底部可将当前输入「存为标签」、恢复默认（localStorage 持久化）
 */
interface Props {
  slot: PromptPresetSlot
  current: string
  onApply: (prompt: string) => void
}

/** 与输入框已有内容拼接：去尾逗号后 + ", " + 新标签 */
function mergePrompt(existing: string, add: string): string {
  const base = existing.trim().replace(/,\s*$/, '')
  return base ? `${base}, ${add.trim()}` : add.trim()
}

/** 从输入框中移除指定标签（忽略大小写与多余空格），未找到则原样返回 */
function removePromptTag(existing: string, tag: string): string {
  const t = tag.trim()
  const parts = existing.split(',').map(s => s.trim())
  const rest = parts.filter(s => s && s.toLowerCase() !== t.toLowerCase())
  return rest.join(', ')
}

export default function PromptPresetPicker({ slot, current, onApply }: Props) {
  const presets = useImageStore(s => s.promptPresets[slot])
  const addPreset = useImageStore(s => s.addPromptPreset)
  const removePreset = useImageStore(s => s.removePromptPreset)
  const resetPresets = useImageStore(s => s.resetPromptPresets)

  const [open, setOpen] = useState(false)
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties | null>(null)
  const [activeGroup, setActiveGroup] = useState('')
  // 记录本次打开期间每个 tag 被点击加载的次数（key = tag 文本）
  const [clickCounts, setClickCounts] = useState<Record<string, number>>({})
  const btnRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  // 打开时重置点击计数
  useEffect(() => {
    if (open) setClickCounts({})
  }, [open])

  // 按 group 分组（保持合理顺序，未知/自定义靠后）
  const groupOrder = PRESET_GROUP_ORDER
  const groupPresets = useMemo(() => {
    const map: Record<string, typeof presets> = {}
    presets.forEach(p => { (map[p.group || '其他'] ??= []).push(p) })
    const ordered: Record<string, typeof presets> = {}
    groupOrder.forEach(g => { if (map[g]) ordered[g] = map[g] })
    Object.keys(map).sort().forEach(g => { if (!(g in ordered)) ordered[g] = map[g] })
    return ordered
  }, [presets])

  const groupNames = useMemo(() => Object.keys(groupPresets), [groupPresets])
  const activeItems = activeGroup && groupPresets[activeGroup] ? groupPresets[activeGroup] : []

  const close = useCallback(() => { setOpen(false); setPanelStyle(null) }, [])

  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (btnRef.current && !btnRef.current.contains(e.target as Node) &&
          panelRef.current && !panelRef.current.contains(e.target as Node)) close()
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open, close])

  const toggle = () => {
    if (open) { close(); return }
    if (btnRef.current) {
      // 打开时默认选中第一个分类
      if (!activeGroup && groupNames.length > 0) setActiveGroup(groupNames[0])
      setPanelStyle({
        position: 'fixed',
        left: '50%',
        top: '50%',
        transform: 'translate(-50%, -50%)',
        minWidth: 560,
        maxWidth: Math.min(720, window.innerWidth - 24),
        maxHeight: 'min(80vh, 640px)',
        zIndex: 10000
      })
      setOpen(true)
    }
  }

  const handleSaveCurrent = () => {
    const tag = current.trim()
    if (!tag) return
    addPreset(slot, tag, tag)
  }

  const handleClickTag = (tag: string) => {
    onApply(mergePrompt(current, tag))
    setClickCounts(prev => ({ ...prev, [tag]: (prev[tag] || 0) + 1 }))
  }

  // 右击：从输入框移除该标签并取消选中痕迹
  const handleContextMenu = (e: React.MouseEvent, tag: string) => {
    e.preventDefault()
    onApply(removePromptTag(current, tag))
    setClickCounts(prev => ({ ...prev, [tag]: 0 }))
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="imagegen-preset-btn"
        onClick={toggle}
        title="提示词预设"
        aria-label="提示词预设"
      >
        <Sparkles size={12} /> 预设
      </button>

      {open && panelStyle && createPortal(
        <div
          ref={panelRef}
          className="imagegen-preset-panel"
          style={panelStyle}
        >
          <div className="imagegen-preset-panel-title">
            {slot === 'pos' ? '正向提示词预设' : '负向提示词预设'}
          </div>

          {presets.length === 0 && (
            <div className="imagegen-preset-empty">还没有预设，可先保存当前输入。</div>
          )}

          {groupNames.length > 0 && (
            <div className="imagegen-preset-tabs">
              {groupNames.map(g => (
                <button
                  key={g}
                  type="button"
                  className={`imagegen-preset-tab${g === activeGroup ? ' active' : ''}`}
                  onClick={() => setActiveGroup(g)}
                >
                  {g}
                </button>
              ))}
            </div>
          )}

          {activeGroup && (
            <div className="imagegen-preset-items">
              {activeItems.map(p => {
                const cnt = clickCounts[p.tag] || 0
                return (
                  <div
                    key={p.id}
                    className={`imagegen-preset-item${cnt > 0 ? ' picked' : ''}`}
                    onClick={() => handleClickTag(p.tag)}
                    onContextMenu={(e) => handleContextMenu(e, p.tag)}
                  >
                    <span className="imagegen-preset-item-label">
                      <span className="imagegen-preset-tag">{p.tag}</span>
                      {p.cn && <span className="imagegen-preset-cn">{p.cn}</span>}
                    </span>
                    {cnt > 1 && (
                      <span className="imagegen-preset-count" title={`已添加 ${cnt} 次`}>
                        ×{cnt}
                      </span>
                    )}
                    <button
                      type="button"
                      className="imagegen-preset-item-del"
                      onClick={(e) => { e.stopPropagation(); removePreset(slot, p.id) }}
                      title="删除该预设"
                      aria-label="删除该预设"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                )
              })}
            </div>
          )}

          <div className="imagegen-preset-actions">
            <button type="button" className="imagegen-preset-action" onClick={handleSaveCurrent}>
              <Plus size={12} /> 保存当前为预设
            </button>
            <button
              type="button"
              className="imagegen-preset-reset"
              onClick={() => resetPresets(slot)}
            >
              <RotateCcw size={12} />
            </button>
          </div>
        </div>,
        document.body
      )}
    </>
  )
}