import { useState, useMemo, useEffect, useRef, useCallback } from 'react'
import { minecraftItems, searchItems, type MinecraftItem } from '../data/items'
import VirtualGrid from './VirtualGrid'
import ItemSelectorCell from './ItemSelectorCell'
import { McTooltipLayer, type TooltipAnchor } from './mc/McTooltipLayer'

interface ItemSelectorProps {
  onSelect: (itemId: string) => void
  onClose: () => void
}

function anchorFromElement(el: HTMLElement, title: string): TooltipAnchor {
  const rect = el.getBoundingClientRect()
  return {
    title,
    left: rect.left + rect.width / 2,
    top: rect.bottom + 4,
  }
}

export default function ItemSelector({ onSelect, onClose }: ItemSelectorProps) {
  const [search, setSearch] = useState('')
  const [hoveredName, setHoveredName] = useState('')
  const [tooltip, setTooltip] = useState<TooltipAnchor | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const hoverAnchorRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const filteredItems = useMemo(() => {
    if (!search.trim()) {
      return minecraftItems
    }
    return searchItems(search)
  }, [search])

  const refreshTooltip = useCallback(() => {
    const el = hoverAnchorRef.current
    if (!el) return
    setTooltip(anchorFromElement(el, el.getAttribute('aria-label') || ''))
  }, [])

  const handleHover = useCallback(
    (item: MinecraftItem, anchor: HTMLElement) => {
      hoverAnchorRef.current = anchor
      setHoveredName(item.name)
      setTooltip(anchorFromElement(anchor, item.name))
    },
    [],
  )

  const handleLeave = useCallback(() => {
    hoverAnchorRef.current = null
    setHoveredName('')
    setTooltip(null)
  }, [])

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose()
    }
  }

  return (
    <div className="item-selector-overlay" onClick={handleOverlayClick}>
      <div className="item-selector-panel mc-frame">
        <div className="item-selector-header">
          <span className="item-selector-title mc-y mc-font-latin">选择物品</span>
          <button className="item-selector-close mc-btn" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="item-selector-search">
          <input
            ref={inputRef}
            type="text"
            className="item-selector-search-input mc-input mc-font-latin"
            placeholder="搜索物品..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <VirtualGrid
          className="item-selector-grid"
          items={filteredItems}
          getKey={(item) => item.id}
          onScroll={refreshTooltip}
          renderItem={(item) => (
            <ItemSelectorCell
              item={item}
              onSelect={onSelect}
              onHover={handleHover}
              onLeave={handleLeave}
            />
          )}
        />

        <McTooltipLayer anchor={tooltip} placement="below" />

        <div className="item-selector-hover-name mc-font-latin" aria-live="polite">
          {hoveredName || '\u00a0'}
        </div>
      </div>
    </div>
  )
}
