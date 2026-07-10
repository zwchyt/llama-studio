import React from 'react'
import CustomSelect from './CustomSelect'
import type { ModelFileInfo } from '../store/useStore'

interface Props {
  value: string | number | boolean
  onChange: (value: string) => void
  disabled: boolean
  items: ModelFileInfo[]
  defaultLabel: string
  ariaLabel: string
  className?: string
}

export default function ModelFileSelect({ value, onChange, disabled, items, defaultLabel, ariaLabel, className }: Props) {
  const strVal = value === false || value === null || value === true ? '' : String(value)
  return (
    <CustomSelect
      className={className}
      value={strVal}
      onChange={onChange}
      options={[
        { value: '', label: defaultLabel },
        ...items.map(m => ({ value: m.path, label: m.name })),
        ...(strVal && !items.find(m => m.path === strVal)
          ? [{ value: strVal, label: strVal.split(/[/\\]/).pop() ?? '' }]
          : [])
      ]}
      disabled={disabled}
      aria-label={ariaLabel}
    />
  )
}
