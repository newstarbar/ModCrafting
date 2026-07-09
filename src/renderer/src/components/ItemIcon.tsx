import React from 'react'
import { MinecraftItem } from '../data/items'

interface ItemIconProps {
  item: MinecraftItem
  size?: number
  className?: string
  lazy?: boolean
}

function pickBlockTexture(item: MinecraftItem): string | null {
  const faces = item.blockTextures
  if (!faces) return null
  for (const key of ['top', 'north', 'south', 'east', 'west', 'bottom'] as const) {
    const tex = faces[key]
    if (tex) return `/${tex}`
  }
  return null
}

function resolveIconSrc(item: MinecraftItem): string {
  if (item.previewIcon) return `/items/${item.previewIcon}`
  if (item.iconKind === 'flat' || !item.isBlock) return `/items/${item.icon}`
  const blockTex = pickBlockTexture(item)
  if (blockTex) return blockTex
  return `/items/${item.icon}`
}

const ItemIcon: React.FC<ItemIconProps> = ({ item, size = 32, className, lazy }) => {
  const shape = item.blockShape ?? 'cube'
  const shapeClass =
    shape === 'slab' || shape === 'stairs' ? `item-icon--${shape}` : 'item-icon--flat'

  return (
    <img
      src={resolveIconSrc(item)}
      alt={item.name}
      className={`item-icon ${shapeClass}${className ? ` ${className}` : ''}`}
      style={{ width: size, height: size }}
      draggable={false}
      loading={lazy ? 'lazy' : undefined}
      decoding={lazy ? 'async' : undefined}
      onError={(e) => {
        const img = e.target as HTMLImageElement
        const fallback = `/items/${item.icon}`
        if (img.src.endsWith(fallback) || img.dataset.fallback === '1') {
          img.style.display = 'none'
          return
        }
        img.dataset.fallback = '1'
        img.src = fallback
      }}
    />
  )
}

export default ItemIcon
