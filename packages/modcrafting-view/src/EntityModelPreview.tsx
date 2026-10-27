import React, { useEffect, useRef, useState } from 'react'
import { layoutEntityBoxes, poseEntityBoxes, transformEntityPoint, type EntityAppearance, type EntityBox } from '../../modcrafting-core/src/entity-appearance.ts'

type Vec3 = [number, number, number]
type Pose = 'rest' | 'walk' | 'death'
const faces: Array<{ indexes: number[]; tone: number }> = [
  { indexes: [4, 5, 6, 7], tone: 1.12 }, { indexes: [0, 3, 2, 1], tone: 0.72 },
  { indexes: [0, 1, 5, 4], tone: 0.9 }, { indexes: [3, 2, 6, 7], tone: 0.82 },
  { indexes: [0, 4, 7, 3], tone: 0.78 }, { indexes: [1, 2, 6, 5], tone: 0.95 }
]
function corners(box: EntityBox): Vec3[] {
  const [ox, oy, oz] = box.origin, [w, h, d] = box.size
  return [[ox, oy, oz], [ox + w, oy, oz], [ox + w, oy, oz + d], [ox, oy, oz + d], [ox, oy + h, oz], [ox + w, oy + h, oz], [ox + w, oy + h, oz + d], [ox, oy + h, oz + d]]
}
function shade(color: Vec3, tone: number): string {
  return `rgb(${color.map(value => Math.max(0, Math.min(255, Math.round(value * tone)))).join(',')})`
}

export function EntityModelPreview({ appearance, image }: { appearance: EntityAppearance; image?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [yaw, setYaw] = useState(-32), [pitch, setPitch] = useState(22)
  const [pose, setPose] = useState<Pose>('rest')
  const [frequency, setFrequency] = useState(0), [amplitude, setAmplitude] = useState(0.8)
  const [deathProgress, setDeathProgress] = useState(1)
  const [playing, setPlaying] = useState(false), [showJoints, setShowJoints] = useState(false)
  const [texture, setTexture] = useState<ImageData>()
  const [message, setMessage] = useState('')

  useEffect(() => {
    if (!image || appearance.mode !== 'custom') { setTexture(undefined); return }
    let cancelled = false
    const loaded = new Image()
    loaded.onload = () => {
      if (cancelled) return
      const canvas = document.createElement('canvas'); canvas.width = appearance.textureSize[0]; canvas.height = appearance.textureSize[1]
      const context = canvas.getContext('2d')!
      context.drawImage(loaded, 0, 0)
      try { setTexture(context.getImageData(0, 0, canvas.width, canvas.height)) } catch { setTexture(undefined) }
    }
    loaded.onerror = () => { if (!cancelled) setTexture(undefined) }
    loaded.src = image
    return () => { cancelled = true }
  }, [image, appearance.mode, appearance.textureSize[0], appearance.textureSize[1]])

  useEffect(() => {
    if (appearance.mode !== 'custom' || pose !== 'walk' || !playing) return
    let frame = 0, previous: number | undefined
    const tick = (time: number) => {
      if (previous !== undefined) {
        const elapsed = Math.min((time - previous) / 1000, 0.1)
        setFrequency(value => (value + elapsed * 4) % (Math.PI * 2))
      }
      previous = time
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [appearance.mode, pose, playing])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || appearance.mode !== 'custom') return
    const width = 300, height = 250
    canvas.width = width; canvas.height = height
    const context = canvas.getContext('2d')!
    context.clearRect(0, 0, width, height)
    try {
      const regions = new Map(layoutEntityBoxes(appearance.boxes, appearance.textureSize).regions.map(region => [region.boxId, region]))
      // Never mutate the authored boxes. Both corners and joint pivots use the same core hierarchy transform.
      const boxes = poseEntityBoxes(appearance.boxes, pose === 'walk' ? frequency : 0, pose === 'walk' ? amplitude : 0, pose === 'death' ? deathProgress : 0)
      const projected = boxes.map(box => corners(box).map(corner => transformEntityPoint(boxes, box.id, corner)))
      const pivots = new Map(boxes.map(box => [box.id, transformEntityPoint(boxes, box.id, box.pivot)]))
      const camera = (point: Vec3) => {
        const ry = yaw * Math.PI / 180, rx = pitch * Math.PI / 180
        const x = point[0] * Math.cos(ry) + point[2] * Math.sin(ry)
        const z = -point[0] * Math.sin(ry) + point[2] * Math.cos(ry)
        const y = point[1] * Math.cos(rx) - z * Math.sin(rx)
        return { x, y, depth: point[1] * Math.sin(rx) + z * Math.cos(rx) }
      }
      // Include rest geometry so folded poses do not suddenly zoom in; include joints even outside a box.
      const rest = appearance.boxes.flatMap(box => corners(box).map(corner => transformEntityPoint(appearance.boxes, box.id, corner)))
      const all = [...projected.flat(), ...rest, ...pivots.values()].map(camera)
      const minX = Math.min(...all.map(point => point.x)), maxX = Math.max(...all.map(point => point.x))
      const minY = Math.min(...all.map(point => point.y)), maxY = Math.max(...all.map(point => point.y))
      const scale = Math.min((width - 36) / Math.max(1, maxX - minX), (height - 36) / Math.max(1, maxY - minY))
      const offsetX = (width - (maxX - minX) * scale) / 2 - minX * scale, offsetY = (height - (maxY - minY) * scale) / 2 - minY * scale
      const screen = (point: Vec3) => { const value = camera(point); return { x: value.x * scale + offsetX, y: value.y * scale + offsetY, depth: value.depth } }
      const drawFaces: Array<{ points: Array<{ x: number; y: number }>; depth: number; color: string }> = []
      boxes.forEach((box, boxIndex) => {
        const region = regions.get(box.id)
        let color: Vec3 = [130, 150, 160]
        if (texture && region) {
          const at = (Math.min(texture.width - 1, region.x + Math.max(1, Math.floor(region.width / 2))) + Math.min(texture.height - 1, region.y + Math.max(1, Math.floor(region.height / 2))) * texture.width) * 4
          if (texture.data[at + 3] > 16) color = [texture.data[at], texture.data[at + 1], texture.data[at + 2]]
        }
        for (const face of faces) {
          const points = face.indexes.map(cornerIndex => screen(projected[boxIndex][cornerIndex]))
          drawFaces.push({ points, depth: points.reduce((sum, point) => sum + point.depth, 0) / points.length, color: shade(color, face.tone) })
        }
      })
      drawFaces.sort((a, b) => a.depth - b.depth).forEach(face => {
        context.beginPath(); face.points.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y)); context.closePath()
        context.fillStyle = face.color; context.fill(); context.strokeStyle = '#101010aa'; context.lineWidth = 1; context.stroke()
      })
      if (showJoints) {
        context.strokeStyle = '#ffda79'; context.lineWidth = 2
        context.setLineDash([4, 3])
        for (const box of boxes) {
          if (!box.parent) continue
          const from = screen(pivots.get(box.parent)!), to = screen(pivots.get(box.id)!)
          context.beginPath(); context.moveTo(from.x, from.y); context.lineTo(to.x, to.y); context.stroke()
        }
        context.setLineDash([])
        for (const box of boxes) {
          const at = screen(pivots.get(box.id)!)
          context.beginPath(); context.arc(at.x, at.y, 3.5, 0, Math.PI * 2)
          context.fillStyle = box.parent ? '#ffda79' : '#7be3e0'; context.fill()
          context.strokeStyle = '#111'; context.lineWidth = 1; context.stroke()
        }
      }
      setMessage('')
    } catch (cause) { setMessage(String(cause)) }
  }, [appearance, yaw, pitch, texture, pose, frequency, amplitude, deathProgress, showJoints])

  if (appearance.mode !== 'custom') return null
  return <div className="appearance-preview" aria-label="关节模型预览">
    <div className="row"><strong>3D 预览</strong><small>真实层级 · 近似配色</small></div>
    <canvas ref={canvasRef} aria-label="生物模型近似预览" />
    <div className="appearance-view-controls">
      <label>姿势<select aria-label="预览姿势" value={pose} onChange={event => { setPose(event.target.value as Pose); setPlaying(false) }}><option value="rest">静态 / 编辑姿势</option><option value="walk">走路</option><option value="death">死亡</option></select></label>
      {pose === 'walk' && <>
        <button aria-label="播放或暂停走路预览" aria-pressed={playing} onClick={() => setPlaying(value => !value)}>{playing ? '暂停走路' : '播放走路'}</button>
        <label>相位<input aria-label="走路相位" type="range" min={0} max={Math.PI * 2} step={0.01} value={frequency} onChange={event => { setPlaying(false); setFrequency(Number(event.target.value)) }} /></label>
        <label>幅度<input aria-label="走路幅度" type="range" min={0} max={1} step={0.01} value={amplitude} onChange={event => setAmplitude(Number(event.target.value))} /></label>
        <small>相位 {frequency.toFixed(2)} rad · 幅度 {Math.round(amplitude * 100)}%</small>
      </>}
      {pose === 'death' && <><label>进度<input aria-label="死亡进度" type="range" min={0} max={1} step={0.01} value={deathProgress} onChange={event => setDeathProgress(Number(event.target.value))} /></label><small>死亡偏移 {Math.round(deathProgress * 100)}%</small></>}
      <label>水平<input aria-label="预览水平角度" type="range" min={-180} max={180} value={yaw} onChange={event => setYaw(Number(event.target.value))} /></label>
      <label>俯仰<input aria-label="预览俯仰角度" type="range" min={-60} max={60} value={pitch} onChange={event => setPitch(Number(event.target.value))} /></label>
    </div>
    <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}><input style={{ width: 16 }} type="checkbox" aria-label="显示关节连接" checked={showJoints} onChange={event => setShowJoints(event.target.checked)} />显示关节连接</label>
    {showJoints && <p className="muted">圆点为变换后的轴心，虚线连接父子轴心；青色为根。连接线会透视显示，不是额外模型几何。</p>}
    {message && <p className="error" role="alert">{message}</p>}
    <p className="muted">预览不会修改静态参数；按实际父子旋转检查腰、肘、膝。配色为近似采样，不含游戏整体死亡倒地效果，最终以游戏内渲染为准。</p>
  </div>
}
