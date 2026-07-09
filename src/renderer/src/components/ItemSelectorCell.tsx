import React from 'react'
import { MinecraftItem } from '../data/items'
import McSlot from './mc/McSlot'

interface ItemSelectorCellProps {
  item: MinecraftItem
  onSelect: (itemId: string) => void
  onHover: (item: MinecraftItem, anchor: HTMLElement) => void
  onLeave: () => void
}

const ItemSelectorCell: React.FC<ItemSelectorCellProps> = ({
  item,
  onSelect,
  onHover,
  onLeave,
}) => (
  <button
    className="item-selector-item"
    onClick={() => onSelect(item.id)}
    aria-label={item.name}
    onMouseEnter={(e) => onHover(item, e.currentTarget)}
    onMouseLeave={onLeave}
    onFocus={(e) => onHover(item, e.currentTarget)}
    onBlur={onLeave}
  >
    <McSlot item={item} size={36} lazyIcon />
  </button>
)

export default React.memo(ItemSelectorCell)
