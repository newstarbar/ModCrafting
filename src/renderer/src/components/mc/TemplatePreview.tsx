import React from 'react'
import { getItemById } from '../../data/items'
import { McHudBar, McItemStack } from './McSlot'

const TOOL_ICONS: Record<string, string> = {
  pickaxe: 'minecraft:diamond_pickaxe',
  axe: 'minecraft:diamond_axe',
  shovel: 'minecraft:diamond_shovel',
  hoe: 'minecraft:diamond_hoe',
  sword: 'minecraft:diamond_sword',
  spear: 'minecraft:trident',
  multi: 'minecraft:diamond_pickaxe',
}

const ARMOR_ICONS: Record<string, string> = {
  helmet: 'minecraft:diamond_helmet',
  chestplate: 'minecraft:diamond_chestplate',
  leggings: 'minecraft:diamond_leggings',
  boots: 'minecraft:diamond_boots',
  full_set: 'minecraft:diamond_chestplate',
}

const EFFECT_ICONS: Record<string, string> = {
  speed: 'minecraft:sugar',
  strength: 'minecraft:blaze_powder',
  regeneration: 'minecraft:ghast_tear',
  fire_resistance: 'minecraft:magma_cream',
  night_vision: 'minecraft:golden_carrot',
  none: 'minecraft:glass_bottle',
}

interface TemplatePreviewProps {
  templateId: string
  formData: Record<string, unknown>
}

const TemplatePreview: React.FC<TemplatePreviewProps> = ({ templateId, formData }) => {
  if (templateId === 'custom-tool' || templateId === 'custom-item') {
    const toolType = String(formData.toolType || formData.itemType || 'pickaxe')
    const material = String(formData.material || 'diamond')
    const durability = Number(formData.durability) || 1561
    const maxDurability = Number(formData.durability) || 1561
    const maxStack = Number(formData.maxStackSize) || 1
    const hasDurability = formData.hasDurability === 'yes' || templateId === 'custom-tool'
    const iconId = templateId === 'custom-tool'
      ? (TOOL_ICONS[toolType] || 'minecraft:diamond_pickaxe')
      : 'minecraft:paper'
    const item = getItemById(iconId)

    return (
      <div className="mc-template-preview">
        <div className="mc-template-preview-label">物品预览</div>
        <div className="mc-slot mc-template-preview-slot">
          {item && (
            <McItemStack
              item={item}
              count={maxStack > 1 ? maxStack : undefined}
              size={28}
              showDurability={hasDurability}
              durability={durability}
              maxDurability={maxDurability}
            />
          )}
        </div>
        <div className="mc-template-preview-meta">
          <span>材质: {material}</span>
          {hasDurability && <span>耐久: {durability}</span>}
        </div>
      </div>
    )
  }

  if (templateId === 'custom-food') {
    const hunger = Number(formData.hunger) || 6
    const effect = String(formData.effect || 'none')
    const effectItem = getItemById(EFFECT_ICONS[effect] || 'minecraft:apple')
    const foodItem = getItemById('minecraft:cooked_beef')

    return (
      <div className="mc-template-preview">
        <div className="mc-template-preview-label">食物预览</div>
        <div className="mc-slot mc-template-preview-slot">
          {foodItem && <McItemStack item={foodItem} size={28} />}
        </div>
        <div className="mc-template-preview-meta">
          <span>饱食度 +{hunger}</span>
        </div>
        <McHudBar type="hunger" value={hunger} max={20} />
        {effect !== 'none' && effectItem && (
          <div className="mc-template-preview-effects">
            <div className="mc-effect-slot">
              <McItemStack item={effectItem} size={18} />
            </div>
            <span className="mc-template-preview-effect-name">{effect}</span>
          </div>
        )}
      </div>
    )
  }

  if (templateId === 'custom-armor') {
    const armorType = String(formData.armorType || 'chestplate')
    const protection = Number(formData.protection) || 8
    const effect = String(formData.effect || 'none')
    const iconId = ARMOR_ICONS[armorType] || 'minecraft:diamond_chestplate'
    const item = getItemById(iconId)
    const effectItem = getItemById(EFFECT_ICONS[effect] || 'minecraft:glass_bottle')

    return (
      <div className="mc-template-preview">
        <div className="mc-template-preview-label">护甲预览</div>
        <div className="mc-slot mc-template-preview-slot">
          {item && (
            <McItemStack
              item={item}
              size={28}
              showDurability
              durability={protection * 50}
              maxDurability={protection * 50}
            />
          )}
        </div>
        <div className="mc-template-preview-meta">
          <span>防护: {protection}</span>
        </div>
        <McHudBar type="armor" value={protection} max={20} />
        {effect !== 'none' && effectItem && (
          <div className="mc-template-preview-effects">
            <div className="mc-effect-slot">
              <McItemStack item={effectItem} size={18} />
            </div>
            <span className="mc-template-preview-effect-name">{effect}</span>
          </div>
        )}
      </div>
    )
  }

  return null
}

export default TemplatePreview
