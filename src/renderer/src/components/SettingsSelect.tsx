import React, { useEffect, useRef, useState } from 'react'

export interface SettingsSelectOption {
  value: string
  label: string
  saved?: boolean
}

interface SettingsSelectProps {
  value: string
  options: SettingsSelectOption[]
  onChange: (value: string) => void
  disabled?: boolean
}

const SettingsSelect: React.FC<SettingsSelectProps> = ({
  value,
  options,
  onChange,
  disabled,
}) => {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const selected = options.find((opt) => opt.value === value)

  useEffect(() => {
    if (!open) return undefined
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="settings-select" ref={rootRef}>
      <button
        type="button"
        className="mc-input settings-select-trigger"
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="settings-select-trigger-text">
          {selected?.label ?? value}
          {selected?.saved && <span className="settings-select-saved-badge">✓</span>}
        </span>
        <span className="settings-select-chevron" aria-hidden>▾</span>
      </button>
      {open && (
        <div className="settings-select-popover" role="listbox">
          {options.map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="option"
              aria-selected={opt.value === value}
              className={`settings-select-item${opt.value === value ? ' settings-select-item--active' : ''}`}
              onClick={() => {
                onChange(opt.value)
                setOpen(false)
              }}
            >
              <span className="settings-select-item-label">{opt.label}</span>
              {opt.saved && <span className="settings-select-saved-badge" title="已保存 API Key">✓</span>}
              {opt.value === value && <span className="settings-select-check" aria-hidden>✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export default SettingsSelect
