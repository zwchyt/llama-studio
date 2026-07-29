import { Check } from 'lucide-react'
import { useFontStore, FONT_THEMES } from '../store/fontStore'
import '../styles/fonts.css'

/**
 * 字体预设选择器（设置页 → 界面）
 * 每张卡片用对应预设的字体栈渲染预览文字，所见即所得；
 * 点击即切换全应用字体，选择持久化到本地。
 */
export default function FontSelector(): React.JSX.Element {
  const font = useFontStore(s => s.font)
  const setFont = useFontStore(s => s.setFont)

  return (
    <div className="font-selector">
      {FONT_THEMES.map(t => (
        <button
          key={t.id}
          className={`font-selector-card ${font === t.id ? 'active' : ''}`}
          style={{ fontFamily: t.previewStack }}
          onClick={() => setFont(t.id)}
          title={t.desc}
        >
          <span className="font-selector-sample">Aa 字体</span>
          <span className="font-selector-name">
            {t.label}
            {font === t.id && <span className="font-selector-check"><Check size={12} /></span>}
          </span>
          <span className="font-selector-desc">{t.desc}</span>
        </button>
      ))}
    </div>
  )
}
