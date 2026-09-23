import React, { useMemo } from 'react'
import CustomSelect from './CustomSelect'
import type { ReleaseInfo } from '../../../shared/types'

type Asset = ReleaseInfo['assets'][number]

interface Props {
  /** GitHub release 的资产列表（已按平台过滤） */
  assets: Asset[]
  /** 当前选中的 downloadUrl */
  value: string
  onChange: (downloadUrl: string) => void
  disabled?: boolean
  /** 追加在外层包裹元素上（默认已 flex: 1 / minWidth: 0，适配 .ev-asset-row） */
  style?: React.CSSProperties
}

/**
 * 引擎版本下拉：llama.cpp / TensorSharp / 各分支引擎共用。
 *
 * 复用 CustomSelect 而不是就地渲染绝对定位面板，是因为：卡片 hover 的 transform 会新建层叠上下文，
 * 就地渲染的下拉层即便写了 z-index 也会被囚禁在卡片内，被后序兄弟卡片盖住；
 * CustomSelect 走 createPortal + position: fixed，面板挂在 body 上，不受任何祖先的层叠上下文与
 * overflow 裁剪影响。滚动/缩放时它还会自动重新贴合按钮。
 */
export default function AssetVersionSelect({ assets, value, onChange, disabled, style }: Props) {
  const options = useMemo(
    () => assets.map(a => ({ value: a.downloadUrl, label: `${a.name} (${Math.round(a.size / 1024 / 1024)} MB)` })),
    [assets]
  )
  // 发布信息刷新后旧 URL 可能已不在列表中，此时回落为空值让 placeholder 生效（否则按钮会显示整个 URL）
  const validValue = assets.some(a => a.downloadUrl === value) ? value : ''

  return (
    <CustomSelect
      value={validValue}
      onChange={onChange}
      options={options}
      placeholder="选择版本"
      disabled={disabled}
      aria-label="选择引擎版本"
      style={{ flex: 1, minWidth: 0, ...style }}
      buttonStyle={{ textAlign: 'center' }}
    />
  )
}
