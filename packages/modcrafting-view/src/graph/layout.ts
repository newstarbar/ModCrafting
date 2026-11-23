/**
 * Graph geometry.
 *
 * FTB stores a quest's position in grid units, so the canvas only converts to
 * pixels at render time. Layout here is deliberately minimal: the pack author's
 * hand-placed positions always win, and these helpers only answer "where should a
 * new quest go" and "how should a link be drawn".
 */

export interface Point { x: number; y: number }

/** Pixels per FTB grid unit. One quest is about one unit wide. */
export const PX_PER_UNIT = 64

export function toPixels(point: Point): Point {
  return { x: point.x * PX_PER_UNIT, y: point.y * PX_PER_UNIT }
}

/** Grid position from a canvas point, snapped to half units like FTB does. */
export function toGrid(pixelX: number, pixelY: number): Point {
  return { x: Math.round((pixelX / PX_PER_UNIT) * 2) / 2, y: Math.round((pixelY / PX_PER_UNIT) * 2) / 2 }
}

/**
 * Nearest free grid slot (spiral order), so a new quest never lands exactly on an
 * existing one and becomes unselectable.
 */
export function freeSlot(occupied: readonly Point[], step = 1.5, rings = 40): Point {
  const taken = (point: Point) => occupied.some((other) =>
    Math.abs(other.x - point.x) < step * 0.9 && Math.abs(other.y - point.y) < step * 0.9)
  if (!taken({ x: 0, y: 0 })) return { x: 0, y: 0 }
  for (let ring = 1; ring <= rings; ring += 1) {
    for (let y = -ring; y <= ring; y += 1) {
      for (let x = -ring; x <= ring; x += 1) {
        if (Math.max(Math.abs(x), Math.abs(y)) !== ring) continue
        const point = { x: x * step, y: y * step }
        if (!taken(point)) return point
      }
    }
  }
  return { x: 0, y: 0 }
}

export function bounds(points: readonly Point[], padding = 2) {
  if (points.length === 0) return { minX: -4, minY: -3, maxX: 4, maxY: 3 }
  const xs = points.map((point) => point.x), ys = points.map((point) => point.y)
  return {
    minX: Math.min(...xs) - padding,
    minY: Math.min(...ys) - padding,
    maxX: Math.max(...xs) + padding,
    maxY: Math.max(...ys) + padding
  }
}

/**
 * Cubic bezier trimmed to the node outline.
 *
 * A straight centre-to-centre line runs under the node, which makes arrowheads and
 * selected nodes read wrong; trimming to `radius` keeps the visible link between
 * the shapes.
 */
export function dependencyPath(from: Point, to: Point, radiusFrom: number, radiusTo = radiusFrom): string {
  const dx = to.x - from.x, dy = to.y - from.y
  const distance = Math.hypot(dx, dy)
  if (distance < 1) return ''
  const ux = dx / distance, uy = dy / distance
  const start = { x: from.x + ux * radiusFrom, y: from.y + uy * radiusFrom }
  const end = { x: to.x - ux * radiusTo, y: to.y - uy * radiusTo }
  const curve = Math.min(PX_PER_UNIT * 0.9, distance / 2)
  return `M ${start.x.toFixed(1)} ${start.y.toFixed(1)} C ${(start.x + ux * curve).toFixed(1)} ${(start.y + uy * curve).toFixed(1)}, ${(end.x - ux * curve).toFixed(1)} ${(end.y - uy * curve).toFixed(1)}, ${end.x.toFixed(1)} ${end.y.toFixed(1)}`
}

/** Bounding box that frames every node, used by "适应窗口". */
export function frame(nodes: readonly Point[], viewport: { width: number; height: number }, paddingPx = 80) {
  const box = bounds(nodes)
  const contentWidth = (box.maxX - box.minX) * PX_PER_UNIT + paddingPx * 2
  const contentHeight = (box.maxY - box.minY) * PX_PER_UNIT + paddingPx * 2
  const scale = Math.min(1.4, Math.max(0.25, Math.min(viewport.width / contentWidth, viewport.height / contentHeight)))
  const centreX = ((box.minX + box.maxX) / 2) * PX_PER_UNIT
  const centreY = ((box.minY + box.maxY) / 2) * PX_PER_UNIT
  return {
    scale,
    ox: viewport.width / 2 - centreX * scale,
    oy: viewport.height / 2 - centreY * scale
  }
}
