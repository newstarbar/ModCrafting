import React, { useEffect, useMemo, useRef, useState } from 'react'
import { PX_PER_UNIT, dependencyPath, frame, toGrid } from './layout.ts'

export interface GraphNode {
  id: string
  title: string
  x: number
  y: number
  /** FTB quest size multiplier (1 = normal). */
  size?: number
  /** Task count; zero means the quest can never be completed. */
  tasks: number
  /** Set when the quest sits in a broken dependency chain. */
  problem?: string
}

export interface GraphEdge {
  from: string
  to: string
  /** The target quest is not in this chapter, so the link cannot be followed. */
  missing: boolean
}

const BASE_RADIUS = 30
const MIN_SCALE = 0.25
const MAX_SCALE = 2.4

const radiusOf = (node: GraphNode): number => BASE_RADIUS * (node.size ?? 1)

/**
 * Pan/zoom canvas for a quest chapter.
 *
 * Positions are the pack author's, in FTB grid units. Dragging a node updates a
 * local preview and only reports the final snapped position, so one gesture
 * produces one operation instead of dozens.
 *
 * The SVG lives at 1x1 with `overflow: visible` inside the transformed world
 * container; that keeps every path in world coordinates without a second
 * coordinate system to keep in sync.
 */
export function NodeGraph({
  nodes,
  edges,
  selectedId,
  onSelect,
  onMove,
  onAdd,
  emptyHint
}: {
  nodes: GraphNode[]
  edges: GraphEdge[]
  selectedId?: string
  onSelect: (id: string) => void
  onMove: (id: string, x: number, y: number) => void
  onAdd?: (x: number, y: number) => void
  emptyHint?: string
}) {
  const viewport = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ ox: 40, oy: 40, scale: 1 })
  const viewRef = useRef(view)
  viewRef.current = view

  const [dragging, setDragging] = useState<{ id: string; x: number; y: number } | null>(null)
  const [panning, setPanning] = useState(false)

  useEffect(() => {
    const element = viewport.current
    if (!element) return
    const onWheel = (event: WheelEvent) => {
      // Registered non-passively: a page scroll on top of the canvas is never wanted.
      event.preventDefault()
      const rect = element.getBoundingClientRect()
      const px = event.clientX - rect.left, py = event.clientY - rect.top
      setView((current) => {
        const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, current.scale * (event.deltaY < 0 ? 1.1 : 0.9)))
        const worldX = (px - current.ox) / current.scale
        const worldY = (py - current.oy) / current.scale
        return { scale, ox: px - worldX * scale, oy: py - worldY * scale }
      })
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [])

  // Re-frame when the chapter's node set changes, not on every drag.
  const nodeSignature = nodes.map((node) => node.id).join(',')
  useEffect(() => {
    const element = viewport.current
    if (!element || nodes.length === 0) return
    const rect = element.getBoundingClientRect()
    if (rect.width < 40 || rect.height < 40) return
    setView(frame(nodes, { width: rect.width, height: rect.height }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeSignature])

  const paths = useMemo(() => {
    const byId = new Map(nodes.map((node) => [node.id, node]))
    return edges.flatMap((edge) => {
      const from = byId.get(edge.from)
      if (!from) return []
      const fromPoint = { x: from.x * PX_PER_UNIT, y: from.y * PX_PER_UNIT }
      const to = byId.get(edge.to)
      if (!to) {
        // A dangling dependency still has to be visible, or the author cannot tell
        // which quest is broken.
        return [{
          key: `${edge.from}->${edge.to}`,
          d: dependencyPath(fromPoint, { x: fromPoint.x + 64, y: fromPoint.y + 48 }, radiusOf(from)),
          missing: true
        }]
      }
      return [{
        key: `${edge.from}->${edge.to}`,
        d: dependencyPath(fromPoint, { x: to.x * PX_PER_UNIT, y: to.y * PX_PER_UNIT }, radiusOf(from), radiusOf(to)),
        missing: false
      }]
    })
  }, [edges, nodes])

  function startPan(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 && event.button !== 1) return
    const target = event.target as HTMLElement
    // Only the background pans; a node handles its own gesture.
    if (target.closest('.graph-node') || target.closest('.graph-controls')) return
    const origin = { clientX: event.clientX, clientY: event.clientY, ox: view.ox, oy: view.oy }
    setPanning(true)
    const move = (moveEvent: PointerEvent) => {
      setView({
        scale: viewRef.current.scale,
        ox: origin.ox + moveEvent.clientX - origin.clientX,
        oy: origin.oy + moveEvent.clientY - origin.clientY
      })
    }
    const up = () => {
      setPanning(false)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  function startDrag(event: React.PointerEvent<HTMLButtonElement>, node: GraphNode) {
    if (event.button !== 0) return
    event.stopPropagation()
    onSelect(node.id)
    const origin = { clientX: event.clientX, clientY: event.clientY, x: node.x, y: node.y }
    const scale = viewRef.current.scale
    setDragging({ id: node.id, x: node.x, y: node.y })

    const move = (moveEvent: PointerEvent) => {
      const dx = (moveEvent.clientX - origin.clientX) / scale
      const dy = (moveEvent.clientY - origin.clientY) / scale
      setDragging({ id: node.id, ...toGrid(origin.x * PX_PER_UNIT + dx, origin.y * PX_PER_UNIT + dy) })
    }
    const up = (upEvent: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      const dx = (upEvent.clientX - origin.clientX) / scale
      const dy = (upEvent.clientY - origin.clientY) / scale
      const snapped = toGrid(origin.x * PX_PER_UNIT + dx, origin.y * PX_PER_UNIT + dy)
      setDragging(null)
      if (snapped.x !== origin.x || snapped.y !== origin.y) onMove(node.id, snapped.x, snapped.y)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  function addAt(event: React.MouseEvent<HTMLDivElement>) {
    if (!onAdd) return
    const target = event.target as HTMLElement
    if (target.closest('.graph-node') || target.closest('.graph-controls')) return
    const rect = viewport.current?.getBoundingClientRect()
    if (!rect) return
    const scale = viewRef.current.scale
    const worldX = (event.clientX - rect.left - viewRef.current.ox) / scale
    const worldY = (event.clientY - rect.top - viewRef.current.oy) / scale
    const point = toGrid(worldX, worldY)
    onAdd(point.x, point.y)
  }

  return <div
    className="graph"
    ref={viewport}
    data-panning={panning || undefined}
    onPointerDown={startPan}
    onDoubleClick={addAt}
  >
    <div className="graph-world" style={{ transform: `translate(${view.ox}px, ${view.oy}px) scale(${view.scale})` }}>
      <svg className="graph-links" width={1} height={1} overflow="visible" aria-hidden>
        {paths.map((path) => <path key={path.key} d={path.d} className={path.missing ? 'graph-link missing' : 'graph-link'} />)}
      </svg>
      {nodes.map((node) => {
        const position = dragging?.id === node.id ? dragging : node
        const radius = radiusOf(node)
        // Counter-scale the label so a zoomed-out chapter stays readable: at 60%
        // an 11px label would render at 6.6px, which is not text any more.
        const labelScale = Math.min(2, Math.max(0.9, 1 / view.scale))
        return <button
          key={node.id}
          type="button"
          className={['graph-node', node.id === selectedId ? 'selected' : '', node.problem ? 'problem' : ''].filter(Boolean).join(' ')}
          style={{ left: position.x * PX_PER_UNIT - radius, top: position.y * PX_PER_UNIT - radius, width: radius * 2, height: radius * 2 }}
          title={node.problem ? `${node.title}\n${node.problem}` : node.title}
          onPointerDown={(event) => startDrag(event, node)}
          onClick={(event) => { event.stopPropagation(); onSelect(node.id) }}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          <span className="graph-node-title" style={{ transform: `scale(${labelScale})` }}>{node.title}</span>
          {node.tasks === 0 && <span className="graph-node-warn" aria-label="没有完成条件">!</span>}
        </button>
      })}
    </div>
    {nodes.length === 0 && <p className="graph-empty">{emptyHint ?? '这个章节还没有任务。双击画布添加第一个。'}</p>}
    <div className="graph-controls">
      <button type="button" onClick={() => setView((value) => ({ ...value, scale: Math.min(MAX_SCALE, value.scale * 1.2) }))} aria-label="放大">＋</button>
      <button type="button" onClick={() => setView((value) => ({ ...value, scale: Math.max(MIN_SCALE, value.scale / 1.2) }))} aria-label="缩小">－</button>
      <button type="button" onClick={() => {
        const element = viewport.current
        if (!element) return
        const rect = element.getBoundingClientRect()
        setView(frame(nodes, { width: rect.width, height: rect.height }))
      }}>适应</button>
      <span>{Math.round(view.scale * 100)}%</span>
    </div>
  </div>
}
