import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { ContentObject } from '../../modcrafting-core/src/content-model.ts'
import { EntityModelPreview } from './EntityModelPreview.tsx'
import {
  articulatedHumanoidBoxes,
  baseSkinParts,
  baseTextureSize,
  customTextureSize,
  defaultEntityBox,
  entityAppearanceSchema,
  layoutEntityBoxes,
  newEntityAppearance,
  type EntityAppearance,
  type EntityBox,
  type EntitySkinPart,
  type EntityTextureSize,
  type EntityUvRegion
} from '../../modcrafting-core/src/entity-appearance.ts'

type Tool = 'pencil' | 'eraser' | 'fill' | 'eyedropper'
type SkinView = 'whole' | 'split'
type Props = {
  draft: ContentObject
  modId: string
  image?: string
  texturePreview?: string
  busy?: boolean
  onChange: (next: ContentObject, texturePng?: string) => void
}
const palette = ['#000000', '#ffffff', '#7f7f7f', '#c0392b', '#e67e22', '#f1c40f', '#27ae60', '#16a085', '#2980b9', '#8e44ad', '#d3548c', '#8b5a2b']
const appearanceOf = (draft: ContentObject): EntityAppearance => (draft.appearance as EntityAppearance | undefined) ?? newEntityAppearance(draft.parameters.baseEntity)
const textureId = (draft: ContentObject, modId: string) => `${modId}:entity/${draft.id.split(':')[1] || 'new_entity'}`
const axes = ['X', 'Y', 'Z'] as const
const motions = [
  ['none', '不摆动'], ['walk_left', '左腿 / 左侧步态'], ['walk_right', '右腿 / 右侧步态'],
  ['knee_left', '左膝'], ['knee_right', '右膝'], ['arm_left', '左臂'], ['arm_right', '右臂']
] as const

function ancestry(boxes: EntityBox[], boxId: string): EntityBox[] {
  const result: EntityBox[] = [], seen = new Set<string>()
  let box = boxes.find(value => value.id === boxId)
  while (box && !seen.has(box.id)) {
    seen.add(box.id)
    result.unshift(box)
    box = boxes.find(value => value.id === box!.parent)
  }
  return result
}
function hierarchyLabel(boxes: EntityBox[], boxId: string): string {
  return ancestry(boxes, boxId).map(box => box.name).join(' / ')
}

// Match each face, not just the enclosing UV net, when a part changes proportions.
function uvFaces(box: EntityBox, region: EntityUvRegion): Array<[number, number, number, number]> {
  const [w, h, d] = box.size, { x, y } = region
  return [[x + d, y, w, d], [x + d + w, y, w, d], [x, y + d, d, h],
    [x + d, y + d, w, h], [x + d + w, y + d, d, h], [x + 2 * d + w, y + d, w, h]]
}

export function EntityAppearanceEditor({ draft, modId, image, texturePreview, busy = false, onChange }: Props) {
  const appearance = useMemo(() => appearanceOf(draft), [draft.appearance, draft.parameters.baseEntity])
  const [tool, setTool] = useState<Tool>('pencil')
  const [color, setColor] = useState('#c0392b')
  const [brush, setBrush] = useState(2)
  const [zoom, setZoom] = useState(4)
  const [ready, setReady] = useState(false)
  const [history, setHistory] = useState(0)
  const [notice, setNotice] = useState('')
  const [boxError, setBoxError] = useState('')
  const [skinView, setSkinView] = useState<SkinView>('whole')
  const [activePartId, setActivePartId] = useState('head')
  const [paintedParts, setPaintedParts] = useState<Record<string, boolean>>({})
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const partCanvasRef = useRef<HTMLCanvasElement>(null)
  const canvasSource = useRef<string | undefined | null>(null)
  const drawing = useRef(false)
  const last = useRef<{ x: number; y: number } | null>(null)
  const undoStack = useRef<ImageData[]>([])
  const redoStack = useRef<ImageData[]>([])
  const [width, height] = appearance.textureSize
  const customParts = appearance.mode === 'custom'
    ? (() => {
        try {
          return layoutEntityBoxes(appearance.boxes as EntityBox[], appearance.textureSize as EntityTextureSize).regions.map(region => ({
            id: region.boxId,
            name: hierarchyLabel(appearance.boxes, region.boxId),
            x: region.x,
            y: region.y,
            width: region.width,
            height: region.height
          }))
        } catch {
          return []
        }
      })()
    : []
  const parts = appearance.mode === 'base' ? baseSkinParts(draft.parameters.baseEntity) : customParts
  const splitAvailable = parts.length > 0
  const activePart: EntitySkinPart | undefined = parts.find(part => part.id === activePartId) ?? parts[0]

  useEffect(() => {
    if (!splitAvailable) { setSkinView('whole'); return }
    if (!parts.some(part => part.id === activePartId)) setActivePartId(parts[0].id)
  }, [splitAvailable, activePartId, draft.parameters.baseEntity, appearance.mode, appearance.boxes])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    // Our own PNG is already on the canvas. Reloading it would briefly erase split painting.
    if (canvasSource.current === image && canvas.width === width && canvas.height === height) return
    let cancelled = false
    const ctx = canvas.getContext('2d')!
    setReady(false)
    resetHistory()
    const resetCanvas = () => { canvas.width = width; canvas.height = height; canvasSource.current = image }
    if (!image) { resetCanvas(); setReady(true); setPaintedParts({}); return }
    const loaded = new Image()
    loaded.onload = () => {
      if (cancelled) return
      resetCanvas()
      ctx.imageSmoothingEnabled = false
      ctx.drawImage(loaded, 0, 0, width, height)
      setReady(true)
    }
    loaded.onerror = () => {
      if (cancelled) return
      resetCanvas()
      setReady(true)
      setNotice('无法读取当前纹理，画布已清空；请重新绘制或检查纹理路径。')
    }
    loaded.src = image
    return () => { cancelled = true }
  }, [image, width, height])

  useEffect(() => {
    if (!ready) return
    updatePaintedParts()
    if (skinView === 'split' && activePart) syncPartCanvas()
  }, [skinView, activePartId, ready, image, width, height, appearance.mode, appearance.boxes, draft.parameters.baseEntity])

  function getContext(canvas: HTMLCanvasElement | null): CanvasRenderingContext2D | null {
    return canvas?.getContext('2d') ?? null
  }
  function context() { return getContext(canvasRef.current) }
  function partContext() { return getContext(partCanvasRef.current) }
  function pointOn(event: React.PointerEvent<HTMLCanvasElement>, canvas: HTMLCanvasElement, canvasWidth: number, canvasHeight: number) {
    const rect = canvas.getBoundingClientRect()
    return {
      x: Math.max(0, Math.min(canvasWidth - 1, Math.floor((event.clientX - rect.left) / rect.width * canvasWidth))),
      y: Math.max(0, Math.min(canvasHeight - 1, Math.floor((event.clientY - rect.top) / rect.height * canvasHeight)))
    }
  }
  function point(event: React.PointerEvent<HTMLCanvasElement>) { return pointOn(event, canvasRef.current!, width, height) }
  function partPoint(event: React.PointerEvent<HTMLCanvasElement>) { return pointOn(event, partCanvasRef.current!, activePart!.width, activePart!.height) }

  function emit(png?: string) {
    const value = png ?? canvasRef.current?.toDataURL('image/png')
    if (!value) return
    canvasSource.current = value
    updatePaintedParts()
    onChange({ ...draft, texture: textureId(draft, modId), appearance }, value)
  }
  function resetHistory() {
    undoStack.current = []
    redoStack.current = []
    setHistory(0)
  }
  function updatePaintedParts() {
    const canvas = canvasRef.current
    const ctx = getContext(canvas)
    if (!canvas || !ctx || !parts.length) return
    const next: Record<string, boolean> = {}
    for (const part of parts) {
      const data = ctx.getImageData(part.x, part.y, part.width, part.height).data
      let painted = false
      for (let index = 3; index < data.length; index += 4) {
        if (data[index]) { painted = true; break }
      }
      next[part.id] = painted
    }
    setPaintedParts(next)
  }
  function flushPart() {
    if (skinView !== 'split' || !activePart) return
    const full = canvasRef.current, partCanvas = partCanvasRef.current, ctx = context()
    if (!full || !partCanvas || !ctx) return
    ctx.clearRect(activePart.x, activePart.y, activePart.width, activePart.height)
    ctx.drawImage(partCanvas, activePart.x, activePart.y)
  }
  function syncPartCanvas() {
    if (!activePart) return
    const full = canvasRef.current, partCanvas = partCanvasRef.current, ctx = partContext()
    if (!full || !partCanvas || !ctx) return
    partCanvas.width = activePart.width
    partCanvas.height = activePart.height
    ctx.clearRect(0, 0, activePart.width, activePart.height)
    ctx.drawImage(full, activePart.x, activePart.y, activePart.width, activePart.height, 0, 0, activePart.width, activePart.height)
  }
  function snapshot() {
    const ctx = context()
    if (!ctx) return
    undoStack.current.push(ctx.getImageData(0, 0, width, height))
    if (undoStack.current.length > 30) undoStack.current.shift()
    redoStack.current = []
    setHistory(value => value + 1)
  }
  function restore(stack: ImageData[], other: ImageData[]) {
    const value = stack.pop()
    if (!value) return
    const ctx = context()
    if (!ctx) return
    other.push(ctx.getImageData(0, 0, width, height))
    ctx.putImageData(value, 0, 0)
    if (skinView === 'split') syncPartCanvas()
    setHistory(current => current + 1)
    emit()
  }
  function undo() { restore(undoStack.current, redoStack.current) }
  function redo() { restore(redoStack.current, undoStack.current) }
  function paintDot(ctx: CanvasRenderingContext2D, x: number, y: number) {
    const size = Math.max(1, brush)
    ctx.fillStyle = tool === 'eraser' ? '#000000' : color
    if (tool === 'eraser') ctx.clearRect(x - Math.floor(size / 2), y - Math.floor(size / 2), size, size)
    else ctx.fillRect(x - Math.floor(size / 2), y - Math.floor(size / 2), size, size)
  }
  function line(ctx: CanvasRenderingContext2D, from: { x: number; y: number }, to: { x: number; y: number }) {
    const steps = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y), 1)
    for (let index = 0; index <= steps; index++) paintDot(ctx, Math.round(from.x + (to.x - from.x) * index / steps), Math.round(from.y + (to.y - from.y) * index / steps))
  }
  function floodFill(ctx: CanvasRenderingContext2D, start: { x: number; y: number }, canvasWidth: number, canvasHeight: number) {
    const data = ctx.getImageData(0, 0, canvasWidth, canvasHeight), pixels = data.data
    const at = (x: number, y: number) => (y * canvasWidth + x) * 4
    const target = pixels.slice(at(start.x, start.y), at(start.x, start.y) + 4)
    const replacement = tool === 'eraser' ? [0, 0, 0, 0] : [parseInt(color.slice(1, 3), 16), parseInt(color.slice(3, 5), 16), parseInt(color.slice(5, 7), 16), 255]
    if (target.every((value, index) => value === replacement[index])) return
    const stack = [start], seen = new Uint8Array(canvasWidth * canvasHeight)
    while (stack.length) {
      const { x, y } = stack.pop()!, index = y * canvasWidth + x
      if (seen[index] || x < 0 || y < 0 || x >= canvasWidth || y >= canvasHeight) continue
      seen[index] = 1
      const offset = at(x, y)
      if (!target.every((value, channel) => pixels[offset + channel] === value)) continue
      for (let channel = 0; channel < 4; channel++) pixels[offset + channel] = replacement[channel]
      stack.push({ x: x + 1, y }, { x: x - 1, y }, { x, y: y + 1 }, { x, y: y - 1 })
    }
    ctx.putImageData(data, 0, 0)
  }
  function sampleColor(ctx: CanvasRenderingContext2D, x: number, y: number) {
    const value = ctx.getImageData(x, y, 1, 1).data
    if (value[3]) setColor(`#${[value[0], value[1], value[2]].map(channel => channel.toString(16).padStart(2, '0')).join('')}`)
  }
  function onPointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    if (busy || !ready) return
    const ctx = context()
    if (!ctx) return
    try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* synthetic/pointer-capture hosts still draw */ }
    const at = point(event)
    if (tool === 'eyedropper') { sampleColor(ctx, at.x, at.y); return }
    snapshot()
    if (tool === 'fill') { floodFill(ctx, at, width, height); emit(); return }
    drawing.current = true
    last.current = at
    paintDot(ctx, at.x, at.y)
  }
  function onPointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return
    const ctx = context()
    if (!ctx) return
    const at = point(event)
    if (last.current) line(ctx, last.current, at)
    last.current = at
  }
  function onPointerUp() {
    if (!drawing.current) return
    drawing.current = false
    last.current = null
    emit()
  }
  function onPartPointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    if (busy || !ready || !activePart) return
    const ctx = partContext()
    if (!ctx) return
    try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* synthetic/pointer-capture hosts still draw */ }
    const at = partPoint(event)
    if (tool === 'eyedropper') { sampleColor(ctx, at.x, at.y); return }
    snapshot()
    if (tool === 'fill') { floodFill(ctx, at, activePart.width, activePart.height); flushPart(); emit(); return }
    drawing.current = true
    last.current = at
    paintDot(ctx, at.x, at.y)
  }
  function onPartPointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return
    const ctx = partContext()
    if (!ctx) return
    const at = partPoint(event)
    if (last.current) line(ctx, last.current, at)
    last.current = at
  }
  function onPartPointerUp() {
    if (!drawing.current) return
    drawing.current = false
    last.current = null
    flushPart()
    emit()
  }
  function clearTexture() {
    if (!window.confirm('清空整张纹理？可以用撤销恢复。')) return
    snapshot()
    context()?.clearRect(0, 0, width, height)
    if (skinView === 'split') syncPartCanvas()
    emit()
  }
  function clearPart() {
    if (!activePart) return
    if (!window.confirm(`清空「${activePart.name}」？可以用撤销恢复。`)) return
    snapshot()
    partContext()?.clearRect(0, 0, activePart.width, activePart.height)
    flushPart()
    emit()
  }
  function switchSkinView(next: SkinView) {
    if (next === skinView) return
    if (skinView === 'split') { flushPart(); emit() }
    setSkinView(next)
    setNotice(next === 'split' ? '拆分绘制：每个部件的修改会实时合成到整张纹理。' : '')
  }
  function selectPart(partId: string) {
    if (partId === activePart?.id) return
    if (skinView === 'split') { flushPart(); emit() }
    setActivePartId(partId)
    setNotice('')
  }
  function integrate() {
    if (!activePart) return
    flushPart()
    emit()
    setSkinView('whole')
    setNotice(`已整合${parts.map(part => part.name).join('、')}，整张纹理已更新。`)
  }
  function importTexture(file?: File) {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const loaded = new Image()
      loaded.onload = () => {
        if (loaded.width !== width || loaded.height !== height) { setNotice(`导入图片必须是 ${width}×${height}，当前为 ${loaded.width}×${loaded.height}`); return }
        snapshot()
        context()?.drawImage(loaded, 0, 0)
        if (skinView === 'split') syncPartCanvas()
        setNotice('已导入 PNG，确认预览后应用。')
        emit()
      }
      loaded.onerror = () => setNotice('无法读取导入图片')
      loaded.src = String(reader.result)
    }
    reader.readAsDataURL(file)
  }

  function updateBoxes(next: EntityBox[], previousIds: Record<string, string> = {}): boolean {
    if (busy) return false
    if (!next.length || next.length > 32) { setBoxError('自定义模型需要 1–32 个方块部件'); return false }
    try {
      const checked = entityAppearanceSchema.safeParse({ ...appearance, mode: 'custom', boxes: next })
      if (!checked.success) {
        setBoxError(checked.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('；'))
        return false
      }
      const layout = layoutEntityBoxes(next, appearance.textureSize)
      const previous = layoutEntityBoxes(appearance.boxes, appearance.textureSize)
      const oldRegions = new Map(previous.regions.map(region => [region.boxId, region]))
      const oldBoxes = new Map(appearance.boxes.map(box => [box.id, box]))
      const sourceId = (id: string) => Object.hasOwn(previousIds, id) ? previousIds[id] : id
      const uvChanged = layout.textureSize[0] !== width || layout.textureSize[1] !== height || next.length !== appearance.boxes.length || layout.regions.some(region => {
        const old = oldRegions.get(sourceId(region.boxId)), oldBox = oldBoxes.get(sourceId(region.boxId))!
        const box = next.find(value => value.id === region.boxId)!
        return !old || old.x !== region.x || old.y !== region.y || old.width !== region.width || old.height !== region.height || box.size.some((value, axis) => value !== oldBox.size[axis])
      })
      const nextAppearance = { ...checked.data, textureSize: layout.textureSize } as EntityAppearance
      if (!uvChanged) {
        // Parent, rest/death pose, motion and renaming must not rewrite a saved PNG or its resource ID.
        onChange({ ...draft, appearance: nextAppearance })
      } else {
        const source = canvasRef.current
        if (!ready || !source) { setBoxError('请等待纹理读取完成，再调整尺寸或增删部件。'); return false }
        flushPart()
        const remapped = document.createElement('canvas')
        remapped.width = layout.textureSize[0]; remapped.height = layout.textureSize[1]
        const ctx = remapped.getContext('2d')!
        ctx.imageSmoothingEnabled = false
        for (const region of layout.regions) {
          const id = sourceId(region.boxId), oldRegion = oldRegions.get(id), oldBox = oldBoxes.get(id)
          if (!oldRegion || !oldBox) continue // New parts start with an empty UV island.
          const box = next.find(value => value.id === region.boxId)!
          if (box.size.every((value, axis) => value === oldBox.size[axis])) {
            ctx.drawImage(source, oldRegion.x, oldRegion.y, oldRegion.width, oldRegion.height, region.x, region.y, region.width, region.height)
          } else {
            const from = uvFaces(oldBox, oldRegion), to = uvFaces(box, region)
            from.forEach((face, index) => ctx.drawImage(source, ...face, ...to[index]))
          }
        }
        const png = remapped.toDataURL('image/png')
        source.width = remapped.width; source.height = remapped.height
        source.getContext('2d')!.drawImage(remapped, 0, 0)
        canvasSource.current = png
        drawing.current = false; last.current = null
        resetHistory() // Pixel undo from an old atlas would restore islands to the wrong parts.
        onChange({ ...draft, texture: textureId(draft, modId), appearance: nextAppearance }, png)
        setNotice('UV 已按部件 ID 重新排列；原有绘制已保留，尺寸变化的面按最近邻缩放。旧布局的绘画撤销记录已清除。')
      }
      setBoxError('')
      return true
    } catch (cause) { setBoxError(String(cause)); return false }
  }
  function setBox(index: number, change: (box: EntityBox) => EntityBox) {
    const old = appearance.boxes[index], next = change(old)
    const renamed = old.id !== next.id
    const boxes = appearance.boxes.map((box, current) => {
      const value = current === index ? next : box
      return renamed && value.parent === old.id ? { ...value, parent: next.id } : value
    })
    if (updateBoxes(boxes, renamed ? { [next.id]: old.id } : {}) && renamed && activePartId === old.id) setActivePartId(next.id)
  }
  function setBoxNumber(index: number, key: 'origin' | 'size' | 'pivot' | 'rotation' | 'deathRotation', axis: number, value: number) {
    setBox(index, box => ({ ...box, [key]: (box[key] ?? [0, 0, 0]).map((current, currentAxis) => currentAxis === axis ? value : current) as [number, number, number] }))
  }
  function addBox() {
    const used = new Set(appearance.boxes.map(box => box.id))
    let index = appearance.boxes.length
    while (used.has(`part_${index}`)) index++
    updateBoxes([...appearance.boxes, { ...defaultEntityBox(index), id: `part_${index}`, name: `部件 ${appearance.boxes.length + 1}`, motion: 'none' }])
  }
  function deleteBox(index: number) {
    const box = appearance.boxes[index]
    if (appearance.boxes.some(value => value.parent === box.id)) { setBoxError('此部件仍有子部件，请先更改子部件的父级或删除子部件。'); return }
    updateBoxes(appearance.boxes.filter((_, current) => current !== index))
  }
  function startCustom(boxes: EntityBox[]) {
    try {
      const layout = layoutEntityBoxes(boxes, customTextureSize())
      const next = entityAppearanceSchema.parse({ version: 1, mode: 'custom', textureSize: layout.textureSize, boxes })
      const canvas = canvasRef.current
      if (!canvas) return
      canvas.width = layout.textureSize[0]; canvas.height = layout.textureSize[1]
      const png = canvas.toDataURL('image/png')
      canvasSource.current = png
      resetHistory()
      setReady(true)
      setPaintedParts({})
      setActivePartId(boxes[0].id)
      setSkinView('whole')
      setBoxError('')
      onChange({ ...draft, texture: textureId(draft, modId), appearance: next }, png)
    } catch (cause) { setBoxError(String(cause)) }
  }
  function applyHumanoidPreset() {
    if (busy || !window.confirm('应用关节人形预设？这会替换当前全部部件并清空纹理，无法撤销；尚未应用到工程。')) return
    startCustom(articulatedHumanoidBoxes())
    setNotice('已建立带腰、肘、膝父子关节的人形和空白纹理；调整躯干、小臂、小腿的 X 旋转可检查弯曲。')
  }
  function switchMode(mode: 'base' | 'custom') {
    if (busy || mode === appearance.mode) return
    if (!window.confirm('切换模型类型会替换当前模型与纹理草稿，无法撤销。继续？')) return
    setSkinView('whole')
    setNotice('')
    setBoxError('')
    resetHistory()
    if (mode === 'base') {
      const size = baseTextureSize(draft.parameters.baseEntity)
      onChange({ ...draft, texture: `minecraft:entity/${String(draft.parameters.baseEntity)}/${String(draft.parameters.baseEntity)}`, appearance: { version: 1, mode: 'base', textureSize: size, boxes: [] } }, '')
    } else {
      startCustom([defaultEntityBox(0), { ...defaultEntityBox(1), id: 'head', name: '头', origin: [-4, -20, -4], pivot: [0, -16, 0] }])
    }
  }

  const regions: EntityUvRegion[] = (() => {
    if (appearance.mode !== 'custom') return []
    try { return layoutEntityBoxes(appearance.boxes as EntityBox[], appearance.textureSize as EntityTextureSize).regions } catch { return [] }
  })()
  const fullStyle = { width: width * zoom, height: height * zoom }
  const partStyle = activePart ? { width: activePart.width * zoom, height: activePart.height * zoom } : undefined
  return <section className="appearance-studio" aria-label="生物外观编辑">
    <div className="row"><div className="grow"><p className="eyebrow">CREATURE / TEXTURE + MODEL</p><h3>绘制生物外观</h3><p className="muted">直接在像素画布上绘制纹理；基型皮肤或自定义方块模型都可以切换拆分绘制，分别编辑部件后整合到完整纹理。</p></div><span className="badge badge-INCONCLUSIVE">{appearance.mode === 'custom' ? skinView === 'split' ? '自定义模型 · 拆分' : '自定义模型' : skinView === 'split' ? '基型皮肤 · 拆分' : '基型皮肤'}</span></div>
    <div className="appearance-mode" style={{ flexWrap: 'wrap' }}><button disabled={busy} aria-pressed={appearance.mode === 'base'} onClick={() => switchMode('base')}>基型皮肤</button><button disabled={busy} aria-pressed={appearance.mode === 'custom'} onClick={() => switchMode('custom')}>自定义方块模型</button><button disabled={busy} aria-label="应用关节人形预设" onClick={applyHumanoidPreset}>关节人形预设（空白纹理）</button></div>
    {splitAvailable && <div className="appearance-splitbar" aria-label="绘制方式"><span>绘制方式</span><button disabled={busy} aria-pressed={skinView === 'whole'} onClick={() => switchSkinView('whole')}>整体绘制</button><button disabled={busy} aria-pressed={skinView === 'split'} onClick={() => switchSkinView('split')}>拆分绘制</button>{skinView === 'split' && <button className="primary" disabled={busy} onClick={integrate}>整合到整体纹理</button>}</div>}
    {appearance.mode === 'base' && !splitAvailable && <p className="muted">拆分绘制当前按僵尸皮肤布局提供；猪基型请使用整体绘制。</p>}
    {skinView === 'split' && activePart && <div className="appearance-parts" aria-label="皮肤部件">{parts.map(part => <button key={part.id} disabled={busy} aria-pressed={part.id === activePart.id} onClick={() => selectPart(part.id)}><span>{part.name}</span><small>{part.width}×{part.height} · {paintedParts[part.id] ? '已绘制' : '未绘制'}</small></button>)}</div>}
    <div className="appearance-layout">
      <div className="appearance-canvas-column">
        <div className="appearance-toolbar">
          {(['pencil', 'eraser', 'fill', 'eyedropper'] as Tool[]).map(value => <button key={value} disabled={busy} aria-pressed={tool === value} onClick={() => setTool(value)}>{({ pencil: '铅笔', eraser: '橡皮', fill: '填充', eyedropper: '取色' })[value]}</button>)}
          <label className="appearance-color">颜色<input type="color" aria-label="画笔颜色" value={color} onChange={event => setColor(event.target.value)} /></label>
          <label>笔刷<input type="number" aria-label="笔刷大小" min={1} max={16} value={brush} onChange={event => setBrush(Math.max(1, Math.min(16, Number(event.target.value) || 1)))} /></label>
          <label>缩放<select aria-label="画布缩放" value={zoom} onChange={event => setZoom(Number(event.target.value))}><option value={1}>1×</option><option value={2}>2×</option><option value={4}>4×</option><option value={8}>8×</option></select></label>
          <button disabled={busy || !history} onClick={undo}>撤销</button><button disabled={busy || !redoStack.current.length} onClick={redo}>重做</button><button disabled={busy} onClick={clearTexture}>清空整张</button>{skinView === 'split' && activePart && <button disabled={busy} onClick={clearPart}>清空当前部件</button>}<label className="button-like">导入<input type="file" accept="image/png" hidden onChange={event => importTexture(event.target.files?.[0])} /></label><a className="button-like" href={canvasRef.current?.toDataURL('image/png') ?? '#'} download={`${draft.id.split(':')[1] || 'entity'}.png`}>导出 PNG</a>
        </div>
        {skinView === 'split' && activePart && <div className="appearance-part-heading"><strong>{activePart.name}</strong><small>源区域 {activePart.x},{activePart.y} · {activePart.width}×{activePart.height}</small></div>}
        <div className="appearance-canvas-wrap" style={{ ...fullStyle, display: skinView === 'split' ? 'none' : undefined }}>
          <canvas ref={canvasRef} className="appearance-canvas" aria-label="生物纹理画布" style={{ width: width * zoom, height: height * zoom }} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} />
          <div className="appearance-grid" style={{ backgroundSize: `${zoom}px ${zoom}px` }} />
          {regions.map(region => <div key={region.boxId} className="appearance-region" style={{ left: region.x * zoom, top: region.y * zoom, width: region.width * zoom, height: region.height * zoom }}><span>{region.name}</span></div>)}
          {appearance.mode === 'base' && parts.map(part => <div key={part.id} className="appearance-region" style={{ left: part.x * zoom, top: part.y * zoom, width: part.width * zoom, height: part.height * zoom }}><span>{part.name}</span></div>)}
        </div>
        {skinView === 'split' && activePart && <>
          <div className="appearance-canvas-wrap" style={partStyle}>
            <canvas key={activePart.id} ref={partCanvasRef} className="appearance-canvas" aria-label={`${activePart.name}绘制画布`} width={activePart.width} height={activePart.height} style={partStyle} onPointerDown={onPartPointerDown} onPointerMove={onPartPointerMove} onPointerUp={onPartPointerUp} onPointerCancel={onPartPointerUp} />
            <div className="appearance-grid" style={{ backgroundSize: `${zoom}px ${zoom}px` }} />
          </div>
          <div className="appearance-part-map"><div className="appearance-part-map-frame">{texturePreview || image ? <img src={texturePreview || image} alt="整体纹理定位" /> : <span className="appearance-part-map-empty" />}<span className="appearance-part-map-box" style={{ left: `${activePart.x / width * 100}%`, top: `${activePart.y / height * 100}%`, width: `${activePart.width / width * 100}%`, height: `${activePart.height / height * 100}%` }} /></div><small>整体定位</small></div>
        </>}
        <p className="muted">{appearance.mode === 'base' ? (skinView === 'split' && activePart ? `正在单独编辑「${activePart.name}」，修改会实时合成到 ${width}×${height} 整体纹理；完成后点「整合到整体纹理」。` : `基型纹理 ${width}×${height}；按原版 UV 展开图绘制，最终以游戏内渲染为准。`) : `自定义纹理 ${width}×${height}；彩色框是各部件的 UV 展开区域，框外内容不会显示。`}</p>
        <div className="appearance-palette">{palette.map(value => <button key={value} aria-label={`颜色 ${value}`} className="swatch" style={{ background: value }} onClick={() => setColor(value)} />)}</div>
        {notice && <p className="muted" role="status">{notice}</p>}
      </div>
      <aside className="appearance-side">
        <h4>部件与几何</h4>
        {boxError && <p className="error" role="alert">{boxError}</p>}
        {appearance.mode === 'base' ? <><p className="muted">当前复用所选猪/僵尸基型的身体结构。要改变体型，切换到“自定义方块模型”。</p>{splitAvailable && <p className="muted">拆分绘制按僵尸皮肤 UV 划分为头部、躯干、手臂、腿部；左右肢体共用同一块 UV。</p>}</> : <>
          <div className="row"><strong>{appearance.boxes.length} / 32 个方块</strong><button disabled={busy || !ready || appearance.boxes.length >= 32} aria-label="添加方块" onClick={addBox}>添加方块</button></div>
          <p className="muted">拆分绘制按部件 UV 展开图拆分。增删或调整尺寸时按 ID 保留绘制；新增部件纹理为空白。</p>
          <p className="muted">原点和轴心为全局静止坐标（模型像素，Y 向下）；旋转相对父级。父级转动会带动子级，改父级不会重写原点。腰弯曲调躯干 X，肘弯曲调小臂 X，膝弯曲调小腿 X；让子级轴心位于连接处。</p>
          <div className="appearance-boxes">{appearance.boxes.map((box, index) => {
            const children = appearance.boxes.filter(value => value.parent === box.id)
            const parentOptions = appearance.boxes.filter(value => !ancestry(appearance.boxes, value.id).some(ancestor => ancestor.id === box.id))
            return <details key={index} open={index < 2}>
              <summary aria-label={`${box.id} 部件设置`} style={{ flexWrap: 'wrap' }}><strong>{box.name}</strong><small style={{ overflowWrap: 'anywhere' }}>{box.parent ? `${box.parent} / ` : '根 / '}{box.id}</small></summary>
              <p className="muted">{hierarchyLabel(appearance.boxes, box.id)}</p>
              <div className="appearance-fields">
                <label>ID<input disabled={busy} aria-label={`部件 ${index + 1} ID`} maxLength={32} value={box.id} onChange={event => setBox(index, current => ({ ...current, id: event.target.value.replace(/[^a-z0-9_]/g, '_').replace(/^[^a-z]/, 'p_') }))} /></label>
                <label>名称<input disabled={busy} aria-label={`部件 ${index + 1} 名称`} maxLength={40} value={box.name} onChange={event => setBox(index, current => ({ ...current, name: event.target.value }))} /></label>
                <label>父部件<select disabled={busy} aria-label={`${box.id} parent`} value={box.parent ?? ''} onChange={event => setBox(index, current => { const { parent: _parent, ...rest } = current; return event.target.value ? { ...rest, parent: event.target.value } : rest })}>
                  <option value="">无（根部件）</option>{parentOptions.map(value => <option key={value.id} value={value.id}>{hierarchyLabel(appearance.boxes, value.id)} ({value.id})</option>)}
                </select></label>
                <label>走路动作<select disabled={busy} aria-label={`${box.id} motion`} value={box.motion ?? ''} onChange={event => setBox(index, current => { const { motion: _motion, ...rest } = current; return event.target.value ? { ...rest, motion: event.target.value as EntityBox['motion'] } : rest })}>
                  <option value="">兼容旧版（按 leg_ ID）</option>{motions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select></label>
                {(['origin', 'size', 'pivot'] as const).map(key => <div className="appearance-axis" key={key}><span>{({ origin: '原点', size: '尺寸', pivot: '轴心' })[key]}</span>{axes.map((axis, axisIndex) => <label key={axis}>{axis}<input disabled={busy || (key === 'size' && !ready)} aria-label={`${box.name} ${key} ${axisIndex}`} type="number" min={key === 'size' ? 1 : -128} max={key === 'size' ? 64 : 128} step={0.5} value={box[key][axisIndex]} onChange={event => setBoxNumber(index, key, axisIndex, Number(event.target.value) || 0)} /></label>)}</div>)}
                <strong>静态旋转（相对父级，°）</strong>
                {axes.map((axis, axisIndex) => <div key={axis} style={{ display: 'grid', gridTemplateColumns: '16px minmax(0, 1fr) 64px', alignItems: 'center', gap: 6 }}>
                  <span>{axis}</span><input disabled={busy} aria-label={`${box.id} rest rotation ${axis} slider`} type="range" min={-180} max={180} step={1} value={box.rotation[axisIndex]} onChange={event => setBoxNumber(index, 'rotation', axisIndex, Number(event.target.value))} />
                  <input disabled={busy} aria-label={`${box.id} rest rotation ${axis}`} title={`${axis} 轴静态旋转（度）`} type="number" min={-180} max={180} step={1} value={box.rotation[axisIndex]} onChange={event => setBoxNumber(index, 'rotation', axisIndex, Number(event.target.value) || 0)} />
                </div>)}
                <details><summary>死亡姿势偏移（°）</summary><p className="muted">在静态旋转上叠加；在下方死亡预览中检查。</p>
                  {axes.map((axis, axisIndex) => <label key={axis}>{axis}<input disabled={busy} aria-label={`${box.id} death rotation ${axis}`} type="number" min={-180} max={180} step={1} value={box.deathRotation?.[axisIndex] ?? 0} onChange={event => setBoxNumber(index, 'deathRotation', axisIndex, Number(event.target.value) || 0)} /></label>)}
                </details>
                <label className="inline"><input disabled={busy} aria-label={`${box.id} mirror UV`} type="checkbox" checked={Boolean(box.mirror)} onChange={event => setBox(index, current => ({ ...current, mirror: event.target.checked }))} />镜像 UV</label>
                {children.length > 0 && <small className="muted">不能删除：包含 {children.map(value => value.name).join('、')}。请先更改子部件父级或删除子部件。</small>}
                <button className="danger" aria-label={`${box.id} delete`} disabled={busy || !ready || appearance.boxes.length <= 1 || children.length > 0} onClick={() => deleteBox(index)}>删除此方块</button>
              </div>
            </details>
          })}</div>
        </>}
        <p className="muted">自定义模型仍使用所选猪/僵尸基型 AI、碰撞尺寸和属性；改变碰撞尺寸或特殊 AI 需要 Agent 写代码。</p>
        <EntityModelPreview appearance={appearance} image={texturePreview || image} />
      </aside>
    </div>
  </section>
}
