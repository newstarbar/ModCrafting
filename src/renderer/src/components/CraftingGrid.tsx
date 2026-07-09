import { useState, useCallback } from 'react'
import { getItemById } from '../data/items'
import ItemSelector from './ItemSelector'
import McSlot from './mc/McSlot'

export interface GridSlot {
  itemId: string
  count: number
}

interface CraftingGridProps {
  grid: GridSlot[][]
  outputItem: string
  outputCount: number
  onGridChange: (grid: GridSlot[][]) => void
  onOutputItemChange: (itemId: string) => void
  onOutputCountChange: (count: number) => void
}

export default function CraftingGrid({
  grid,
  outputItem,
  outputCount,
  onGridChange,
  onOutputItemChange,
  onOutputCountChange
}: CraftingGridProps) {
  const [selectedSlot, setSelectedSlot] = useState<{ row: number; col: number } | null>(null)
  const [showOutputSelector, setShowOutputSelector] = useState(false)

  const handleSlotClick = useCallback((row: number, col: number) => {
    setSelectedSlot({ row, col })
  }, [])

  const handleOutputClick = useCallback(() => {
    setShowOutputSelector(true)
  }, [])

  const handleItemSelect = useCallback((itemId: string) => {
    if (selectedSlot) {
      const newGrid = grid.map((r, i) =>
        r.map((slot, j) => {
          if (i === selectedSlot.row && j === selectedSlot.col) {
            return { itemId, count: slot.count || 1 }
          }
          return slot
        })
      )
      onGridChange(newGrid)
      setSelectedSlot(null)
    }
  }, [grid, selectedSlot, onGridChange])

  const handleOutputItemSelect = useCallback((itemId: string) => {
    onOutputItemChange(itemId)
    setShowOutputSelector(false)
  }, [onOutputItemChange])

  const handleClearSlot = useCallback(() => {
    if (selectedSlot) {
      const newGrid = grid.map((r, i) =>
        r.map((slot, j) => {
          if (i === selectedSlot.row && j === selectedSlot.col) {
            return { itemId: '', count: 0 }
          }
          return slot
        })
      )
      onGridChange(newGrid)
      setSelectedSlot(null)
    }
  }, [grid, selectedSlot, onGridChange])

  const handleClearAll = useCallback(() => {
    const newGrid = grid.map((r) =>
      r.map(() => ({ itemId: '', count: 0 }))
    )
    onGridChange(newGrid)
  }, [grid, onGridChange])

  const outputItemData = getItemById(outputItem)

  return (
    <div className="crafting-grid-container mc-frame">
      <div className="crafting-grid-header">
        <span className="crafting-grid-title mc-y">合成配方</span>
        <button className="mc-btn crafting-grid-clear-btn" onClick={handleClearAll}>
          清空
        </button>
      </div>

      <div className="crafting-grid-wrapper mc-crafting-table">
        <div className="crafting-grid-input">
          {grid.map((row, rowIndex) => (
            <div key={rowIndex} className="crafting-grid-row">
              {row.map((slot, colIndex) => {
                const itemData = slot.itemId ? getItemById(slot.itemId) : null
                return (
                  <McSlot
                    key={`${rowIndex}-${colIndex}`}
                    item={itemData}
                    count={slot.count > 1 ? slot.count : undefined}
                    size={40}
                    selected={selectedSlot?.row === rowIndex && selectedSlot?.col === colIndex}
                    onClick={() => handleSlotClick(rowIndex, colIndex)}
                  />
                )
              })}
            </div>
          ))}
        </div>

        <div className="mc-crafting-arrow" aria-hidden />

        <div className="crafting-grid-output">
          <McSlot
            item={outputItemData}
            count={outputCount > 1 ? outputCount : undefined}
            size={40}
            onClick={handleOutputClick}
            placeholder={!outputItem ? '选择' : undefined}
          />
          <input
            type="number"
            className="mc-input crafting-grid-output-count"
            min={1}
            max={64}
            value={outputCount}
            onChange={(e) => onOutputCountChange(Math.min(64, Math.max(1, parseInt(e.target.value) || 1)))}
          />
        </div>
      </div>

      {selectedSlot && (
        <ItemSelector
          onSelect={handleItemSelect}
          onClose={() => setSelectedSlot(null)}
          onClear={handleClearSlot}
        />
      )}

      {showOutputSelector && (
        <ItemSelector
          onSelect={handleOutputItemSelect}
          onClose={() => setShowOutputSelector(false)}
        />
      )}
    </div>
  )
}
