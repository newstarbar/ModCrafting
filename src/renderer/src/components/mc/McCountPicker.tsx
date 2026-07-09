import React from 'react'

const PRESETS = [1, 2, 4, 8, 16, 32, 64] as const

interface McCountPickerProps {
  value: number
  onChange: (count: number) => void
  max?: number
}

export const McCountPicker: React.FC<McCountPickerProps> = ({
  value,
  onChange,
  max = 64,
}) => {
  const clamp = (n: number) => Math.min(max, Math.max(1, n))

  return (
    <div className="mc-count-picker">
      <div className="mc-count-picker-presets">
        {PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            className={`mc-count-preset mc-font${value === preset ? ' mc-count-preset--active' : ''}`}
            onClick={() => onChange(preset)}
          >
            {preset}x
          </button>
        ))}
      </div>
      <div className="mc-count-picker-custom">
        <input
          type="number"
          className="mc-input mc-count-input mc-font"
          min={1}
          max={max}
          value={value}
          onChange={(e) => onChange(clamp(parseInt(e.target.value, 10) || 1))}
          aria-label="自定义数量"
        />
        <span className="mc-count-suffix mc-font">x</span>
      </div>
    </div>
  )
}

export default McCountPicker
