import { useState, useEffect, useRef, useMemo, type ReactNode } from 'react'

const CELL_MIN_WIDTH = 40
const GAP = 2
const ROW_HEIGHT = CELL_MIN_WIDTH + GAP
const BUFFER_ROWS = 2
const VIRTUAL_THRESHOLD = 80

interface VirtualGridProps<T> {
  items: T[]
  getKey: (item: T) => string
  renderItem: (item: T) => ReactNode
  className?: string
  onScroll?: () => void
}

export default function VirtualGrid<T>({
  items,
  getKey,
  renderItem,
  className = '',
  onScroll,
}: VirtualGridProps<T>) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(400)
  const [columnCount, setColumnCount] = useState(10)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const measure = () => {
      const style = getComputedStyle(el)
      const paddingX =
        parseFloat(style.paddingLeft || '0') + parseFloat(style.paddingRight || '0')
      const width = el.clientWidth - paddingX
      setColumnCount(Math.max(1, Math.floor((width + GAP) / (CELL_MIN_WIDTH + GAP))))
      setViewportHeight(el.clientHeight)
    }

    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const useVirtual = items.length >= VIRTUAL_THRESHOLD
  const totalRows = Math.ceil(items.length / columnCount)

  const { paddingTop, paddingBottom, visibleItems } = useMemo(() => {
    if (!useVirtual) {
      return {
        paddingTop: 0,
        paddingBottom: 0,
        visibleItems: items.map((item, index) => ({ item, index })),
      }
    }

    const startRow = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - BUFFER_ROWS)
    const endRow = Math.min(
      totalRows,
      Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + BUFFER_ROWS,
    )
    const startIndex = startRow * columnCount
    const endIndex = Math.min(items.length, endRow * columnCount)

    return {
      paddingTop: startRow * ROW_HEIGHT,
      paddingBottom: Math.max(0, (totalRows - endRow) * ROW_HEIGHT),
      visibleItems: items
        .slice(startIndex, endIndex)
        .map((item, offset) => ({ item, index: startIndex + offset })),
    }
  }, [items, useVirtual, scrollTop, viewportHeight, columnCount, totalRows])

  return (
    <div
      ref={containerRef}
      className={className}
      onScroll={(e) => {
        setScrollTop(e.currentTarget.scrollTop)
        onScroll?.()
      }}
    >
      <div
        className="virtual-grid-inner"
        style={{
          paddingTop,
          paddingBottom,
          gridTemplateColumns: `repeat(${columnCount}, minmax(${CELL_MIN_WIDTH}px, 1fr))`,
        }}
      >
        {visibleItems.map(({ item }) => (
          <div key={getKey(item)} className="virtual-grid-cell">
            {renderItem(item)}
          </div>
        ))}
      </div>
    </div>
  )
}
