import React from 'react'
import ItemIcon from '../ItemIcon'
import { MinecraftItem } from '../../data/items'

interface McSlotProps {
  item?: MinecraftItem | null
  count?: number
  size?: number
  selected?: boolean
  onClick?: () => void
  placeholder?: string
  className?: string
  lazyIcon?: boolean
  draggable?: boolean
  onDragStart?: (e: React.DragEvent) => void
  onDragEnd?: (e: React.DragEvent) => void
  onDragOver?: (e: React.DragEvent) => void
  onDrop?: (e: React.DragEvent) => void
  onContextMenu?: (e: React.MouseEvent) => void
}

const McSlot: React.FC<McSlotProps> = ({
  item,
  count,
  size = 36,
  selected,
  onClick,
  placeholder,
  className = '',
  lazyIcon,
  draggable,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  onContextMenu,
}) => {
  const inner = size - 8
  const Tag = onClick ? 'button' : 'div'

  return (
    <Tag
      type={onClick ? 'button' : undefined}
      className={`mc-slot ${selected ? 'mc-slot--selected' : ''} ${className}`}
      style={{ width: size, height: size }}
      onClick={onClick}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onContextMenu={onContextMenu}
    >
      {item ? (
        <McItemStack item={item} count={count} size={inner} lazyIcon={lazyIcon} />
      ) : placeholder ? (
        <span className="mc-slot-placeholder">{placeholder}</span>
      ) : null}
    </Tag>
  )
}

interface McItemStackProps {
  item: MinecraftItem
  count?: number
  size?: number
  durability?: number
  maxDurability?: number
  showDurability?: boolean
  lazyIcon?: boolean
}

export const McItemStack: React.FC<McItemStackProps> = ({
  item,
  count,
  size = 28,
  durability,
  maxDurability,
  showDurability,
  lazyIcon,
}) => {
  const showCount = count !== undefined && count > 1
  const showBar = showDurability && durability !== undefined && maxDurability !== undefined && maxDurability > 0

  return (
    <div className="mc-item-stack" style={{ width: size, height: size }}>
      <ItemIcon item={item} size={size} className="mc-item-stack-icon" lazy={lazyIcon} />
      {showCount && <span className="mc-item-count">{count}</span>}
      {showBar && (
        <McDurabilityBar current={durability} max={maxDurability} />
      )}
    </div>
  )
}

interface McDurabilityBarProps {
  current: number
  max: number
}

export const McDurabilityBar: React.FC<McDurabilityBarProps> = ({ current, max }) => {
  const ratio = Math.max(0, Math.min(1, current / max))
  const hue = Math.round(ratio * 120)
  return (
    <div className="mc-durability-bar">
      <div
        className="mc-durability-bar-fill"
        style={{ width: `${ratio * 100}%`, backgroundColor: `hsl(${hue}, 80%, 45%)` }}
      />
    </div>
  )
}

interface McHudBarProps {
  type: 'hunger' | 'armor'
  value: number
  max?: number
}

export const McHudBar: React.FC<McHudBarProps> = ({ type, value, max = 20 }) => {
  const iconCount = Math.ceil(max / 2)

  const getState = (index: number): 'full' | 'half' | 'empty' => {
    const remaining = value - index * 2
    if (remaining >= 2) return 'full'
    if (remaining >= 1) return 'half'
    return 'empty'
  }

  return (
    <div className={`mc-hud-bar mc-hud-bar--${type}`}>
      {Array.from({ length: iconCount }, (_, i) => {
        const state = getState(i)
        return (
          <div
            key={i}
            className={`mc-hud-icon mc-hud-icon--${type}-${state}`}
          />
        )
      })}
    </div>
  )
}

interface McTooltipProps {
  title: string
  lines?: string[]
  children: React.ReactNode
  placement?: 'above' | 'below'
}

export const McTooltip: React.FC<McTooltipProps> = ({ title, lines, children, placement = 'above' }) => {
  return (
    <div className={`mc-tooltip-wrap mc-tooltip-wrap--${placement}`}>
      {children}
      <div className="mc-tooltip" role="tooltip">
        <span className="mc-tooltip-title">{title}</span>
        {lines?.map((line, i) => (
          <span key={i} className="mc-tooltip-line">{line}</span>
        ))}
      </div>
    </div>
  )
}

export default McSlot
