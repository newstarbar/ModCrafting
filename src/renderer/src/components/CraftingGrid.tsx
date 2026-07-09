import { useState, useCallback } from 'react'
import { getItemById } from '../data/items'
import ItemSelector from './ItemSelector'
import McSlot from './mc/McSlot'
import McCountPicker from './mc/McCountPicker'

export interface GridSlot {
  itemId: string
  count: number
}

export interface CraftingGridData {
  grid: GridSlot[][]
  outputItem: string
  outputCount: number
}

interface CraftingGridProps {
  grid: GridSlot[][]
  outputItem: string
  outputCount: number
  onDataChange: (data: CraftingGridData) => void
}

type SlotRef =
  | { kind: 'grid'; row: number; col: number }
  | { kind: 'output' }

const EMPTY_SLOT: GridSlot = { itemId: '', count: 0 }
const DRAG_MIME = 'application/x-modcrafting-slot'

function slotFromRef(
  ref: SlotRef,
  grid: GridSlot[][],
  outputItem: string,
  outputCount: number,
): GridSlot {
  if (ref.kind === 'output') {
    return outputItem
      ? { itemId: outputItem, count: outputCount > 0 ? outputCount : 1 }
      : EMPTY_SLOT
  }
  return grid[ref.row][ref.col]
}

function applySlot(
  ref: SlotRef,
  slot: GridSlot,
  grid: GridSlot[][],
  outputItem: string,
  outputCount: number,
): CraftingGridData {
  if (ref.kind === 'output') {
    return {
      grid,
      outputItem: slot.itemId,
      outputCount: slot.itemId ? Math.max(1, slot.count || 1) : 1,
    }
  }
  const newGrid = grid.map((row, rowIndex) =>
    row.map((cell, colIndex) =>
      rowIndex === ref.row && colIndex === ref.col ? { ...slot } : { ...cell },
    ),
  )
  return { grid: newGrid, outputItem, outputCount }
}

export default function CraftingGrid({
  grid,
  outputItem,
  outputCount,
  onDataChange,
}: CraftingGridProps) {
  const [selectedSlot, setSelectedSlot] = useState<{ row: number; col: number } | null>(null)
  const [showOutputSelector, setShowOutputSelector] = useState(false)

  const currentData = (): CraftingGridData => ({ grid, outputItem, outputCount })

  const commit = useCallback(
    (data: CraftingGridData) => {
      onDataChange(data)
    },
    [onDataChange],
  )

  const handleSlotClick = useCallback((row: number, col: number) => {
    setSelectedSlot({ row, col })
  }, [])

  const handleOutputClick = useCallback(() => {
    setShowOutputSelector(true)
  }, [])

  const handleItemSelect = useCallback(
    (itemId: string) => {
      if (!selectedSlot) return
      const newGrid = grid.map((r, i) =>
        r.map((slot, j) => {
          if (i === selectedSlot.row && j === selectedSlot.col) {
            return { itemId, count: slot.count > 0 ? slot.count : 1 }
          }
          return slot
        }),
      )
      commit({ grid: newGrid, outputItem, outputCount })
      setSelectedSlot(null)
    },
    [grid, outputItem, outputCount, selectedSlot, commit],
  )

  const handleOutputItemSelect = useCallback(
    (itemId: string) => {
      commit({ grid, outputItem: itemId, outputCount })
      setShowOutputSelector(false)
    },
    [grid, outputCount, commit],
  )

  const clearSlot = useCallback(
    (ref: SlotRef) => {
      commit(applySlot(ref, EMPTY_SLOT, grid, outputItem, outputCount))
    },
    [grid, outputItem, outputCount, commit],
  )

  const handleClearAll = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const emptyGrid = grid.map((row) => row.map(() => ({ ...EMPTY_SLOT })))
      commit({ grid: emptyGrid, outputItem: '', outputCount: 1 })
    },
    [grid, commit],
  )

  const handleDragStart = useCallback(
    (ref: SlotRef, e: React.DragEvent) => {
      const slot = slotFromRef(ref, grid, outputItem, outputCount)
      if (!slot.itemId) {
        e.preventDefault()
        return
      }
      const payload = JSON.stringify({ ref })
      e.dataTransfer.setData(DRAG_MIME, payload)
      e.dataTransfer.setData('text/plain', payload)
      e.dataTransfer.effectAllowed = 'move'
    },
    [grid, outputItem, outputCount],
  )

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
  }, [])

  const handleDrop = useCallback(
    (target: SlotRef, e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const raw = e.dataTransfer.getData(DRAG_MIME) || e.dataTransfer.getData('text/plain')
      if (!raw) return

      let sourceRef: SlotRef
      try {
        sourceRef = (JSON.parse(raw) as { ref: SlotRef }).ref
      } catch {
        return
      }

      if (
        sourceRef.kind === 'grid' &&
        target.kind === 'grid' &&
        sourceRef.row === target.row &&
        sourceRef.col === target.col
      ) {
        return
      }
      if (sourceRef.kind === 'output' && target.kind === 'output') {
        return
      }

      const sourceSlot = slotFromRef(sourceRef, grid, outputItem, outputCount)
      const targetSlot = slotFromRef(target, grid, outputItem, outputCount)

      let next = applySlot(target, sourceSlot, grid, outputItem, outputCount)
      next = applySlot(sourceRef, targetSlot, next.grid, next.outputItem, next.outputCount)

      commit(next)
    },
    [grid, outputItem, outputCount, commit],
  )

  const handleContextMenu = useCallback(
    (ref: SlotRef, e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      clearSlot(ref)
    },
    [clearSlot],
  )

  const outputItemData = outputItem ? getItemById(outputItem) : null

  const slotHandlers = (ref: SlotRef, hasItem: boolean) => ({
    draggable: hasItem,
    onDragStart: (e: React.DragEvent) => handleDragStart(ref, e),
    onDragOver: handleDragOver,
    onDrop: (e: React.DragEvent) => handleDrop(ref, e),
    onContextMenu: (e: React.MouseEvent) => handleContextMenu(ref, e),
  })

  return (
    <div className="crafting-grid-container mc-frame">
      <div className="crafting-grid-header">
        <span className="crafting-grid-title mc-y">合成配方</span>
        <button type="button" className="mc-btn crafting-grid-clear-btn" onClick={handleClearAll}>
          清空
        </button>
      </div>

      <p className="crafting-grid-help mc-dim">
        左键选择 · 拖拽换位 · 右键清格 · 清空重置全部
      </p>

      <div className="crafting-grid-wrapper mc-crafting-table">
        <div className="crafting-grid-input">
          {grid.map((row, rowIndex) => (
            <div key={`row-${rowIndex}`} className="crafting-grid-row">
              {row.map((slot, colIndex) => {
                const itemData = slot.itemId ? getItemById(slot.itemId) : null
                const ref: SlotRef = { kind: 'grid', row: rowIndex, col: colIndex }
                return (
                  <McSlot
                    key={`slot-${rowIndex}-${colIndex}`}
                    item={itemData}
                    count={slot.count > 1 ? slot.count : undefined}
                    size={40}
                    selected={
                      selectedSlot?.row === rowIndex && selectedSlot?.col === colIndex
                    }
                    onClick={() => handleSlotClick(rowIndex, colIndex)}
                    {...slotHandlers(ref, !!slot.itemId)}
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
            {...slotHandlers({ kind: 'output' }, !!outputItem)}
          />
          <McCountPicker
            value={outputCount}
            onChange={(count) => commit({ ...currentData(), outputCount: count })}
          />
        </div>
      </div>

      {selectedSlot && (
        <ItemSelector
          onSelect={handleItemSelect}
          onClose={() => setSelectedSlot(null)}
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
