import React, { useEffect, useRef, useState } from 'react'

/**
 * Draggable two-column split.
 *
 * The existing editors each hard-code `grid-template-columns: 240px 1fr`, which is
 * why nesting a third column for an inspector produced an unmanageable grid. This
 * is the single control that owns a divider; nest two of them for three columns.
 */
export function SplitPane({
  left,
  right,
  initialWidth = 240,
  min = 160,
  max = 520,
  storageKey
}: {
  left: React.ReactNode
  right: React.ReactNode
  initialWidth?: number
  min?: number
  max?: number
  storageKey?: string
}) {
  const [width, setWidth] = useState(() => {
    if (!storageKey) return initialWidth
    const stored = Number(localStorage.getItem(`modcrafting-split:${storageKey}`))
    return Number.isFinite(stored) && stored >= min && stored <= max ? stored : initialWidth
  })
  const dragging = useRef<{ startX: number; startWidth: number } | null>(null)

  useEffect(() => {
    if (storageKey) localStorage.setItem(`modcrafting-split:${storageKey}`, String(width))
  }, [storageKey, width])

  return <div className="split-pane" style={{ gridTemplateColumns: `${width}px 6px minmax(0, 1fr)` }}>
    <div className="split-pane-side">{left}</div>
    <div
      className="split-pane-divider"
      role="separator"
      aria-orientation="vertical"
      aria-label="调整分栏宽度"
      tabIndex={0}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId)
        dragging.current = { startX: event.clientX, startWidth: width }
      }}
      onPointerMove={(event) => {
        const state = dragging.current
        if (!state) return
        setWidth(Math.min(max, Math.max(min, state.startWidth + event.clientX - state.startX)))
      }}
      onPointerUp={(event) => {
        if (!dragging.current) return
        dragging.current = null
        try { event.currentTarget.releasePointerCapture(event.pointerId) } catch { /* already released */ }
      }}
      onPointerCancel={() => { dragging.current = null }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft') { event.preventDefault(); setWidth((value) => Math.max(min, value - 16)) }
        if (event.key === 'ArrowRight') { event.preventDefault(); setWidth((value) => Math.min(max, value + 16)) }
      }}
    />
    <div className="split-pane-main">{right}</div>
  </div>
}
