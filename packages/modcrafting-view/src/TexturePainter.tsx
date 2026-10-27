import React, { useEffect, useRef, useState } from 'react'

type Tool = 'pencil' | 'eraser' | 'fill' | 'eyedropper'
type Props = { image?: string; defaultSize?: number; defaultHeight?: number; disabled?: boolean; onChange: (dataUrl: string) => void; label?: string }
const palette = ['#000000', '#ffffff', '#7f7f7f', '#c0392b', '#e67e22', '#f1c40f', '#27ae60', '#16a085', '#2980b9', '#8e44ad', '#d3548c', '#8b5a2b']

export function TexturePainter({ image, defaultSize = 16, defaultHeight, disabled = false, onChange, label = '纹理' }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const initialHeight = defaultHeight ?? defaultSize
  const [size, setSize] = useState([defaultSize, initialHeight])
  const [tool, setTool] = useState<Tool>('pencil')
  const [color, setColor] = useState('#c0392b')
  const [brush, setBrush] = useState(1)
  const [zoom, setZoom] = useState(Math.max(defaultSize, initialHeight) <= 32 ? 8 : 4)
  const [ready, setReady] = useState(false)
  const [history, setHistory] = useState(0)
  const [notice, setNotice] = useState('')
  const drawing = useRef(false), last = useRef<{ x: number; y: number } | null>(null)
  const undoStack = useRef<ImageData[]>([]), redoStack = useRef<ImageData[]>([])
  const [width, height] = size

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    setReady(false)
    if (!image) {
      canvas.width = defaultSize; canvas.height = initialHeight; setSize([defaultSize, initialHeight])
      canvas.getContext('2d')!.clearRect(0, 0, defaultSize, initialHeight); setReady(true); return
    }
    const loaded = new Image()
    loaded.onload = () => {
      const w = Math.max(16, Math.min(512, loaded.naturalWidth)), h = Math.max(16, Math.min(512, loaded.naturalHeight))
      canvas.width = w; canvas.height = h; setSize([w, h])
      const ctx = canvas.getContext('2d')!; ctx.clearRect(0, 0, w, h); ctx.drawImage(loaded, 0, 0, w, h)
      setReady(true)
    }
    loaded.onerror = () => { setReady(true); setNotice('无法读取当前纹理；可以从空白画布重新绘制。') }
    loaded.src = image
  }, [image, defaultSize, initialHeight])

  function ctx() { return canvasRef.current?.getContext('2d')! }
  function point(event: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current!, rect = canvas.getBoundingClientRect()
    return { x: Math.max(0, Math.min(width - 1, Math.floor((event.clientX - rect.left) / rect.width * width))), y: Math.max(0, Math.min(height - 1, Math.floor((event.clientY - rect.top) / rect.height * height))) }
  }
  function snapshot() { const c = ctx(); if (!c) return; undoStack.current.push(c.getImageData(0, 0, width, height)); if (undoStack.current.length > 30) undoStack.current.shift(); redoStack.current = []; setHistory(v => v + 1) }
  function emit() { const value = canvasRef.current?.toDataURL('image/png'); if (value) onChange(value) }
  function dot(x: number, y: number) { const c = ctx(); if (!c) return; const n = Math.max(1, brush); const left = x - Math.floor(n / 2), top = y - Math.floor(n / 2); if (tool === 'eraser') c.clearRect(left, top, n, n); else { c.fillStyle = color; c.fillRect(left, top, n, n) } }
  function line(from: { x: number; y: number }, to: { x: number; y: number }) { const steps = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y), 1); for (let i = 0; i <= steps; i++) dot(Math.round(from.x + (to.x - from.x) * i / steps), Math.round(from.y + (to.y - from.y) * i / steps)) }
  function fill(start: { x: number; y: number }) {
    const c = ctx(); if (!c) return
    const data = c.getImageData(0, 0, width, height), pixels = data.data, at = (x: number, y: number) => (y * width + x) * 4
    const target = Array.from(pixels.slice(at(start.x, start.y), at(start.x, start.y) + 4))
    const replacement = tool === 'eraser' ? [0, 0, 0, 0] : [parseInt(color.slice(1, 3), 16), parseInt(color.slice(3, 5), 16), parseInt(color.slice(5, 7), 16), 255]
    if (target.every((value, index) => value === replacement[index])) return
    const stack = [start], seen = new Uint8Array(width * height)
    while (stack.length) {
      const { x, y } = stack.pop()!, index = y * width + x
      if (seen[index] || x < 0 || y < 0 || x >= width || y >= height) continue
      seen[index] = 1; const offset = at(x, y)
      if (!target.every((value, channel) => pixels[offset + channel] === value)) continue
      for (let channel = 0; channel < 4; channel++) pixels[offset + channel] = replacement[channel]
      stack.push({ x: x + 1, y }, { x: x - 1, y }, { x, y: y + 1 }, { x, y: y - 1 })
    }
    c.putImageData(data, 0, 0)
  }
  function down(event: React.PointerEvent<HTMLCanvasElement>) {
    if (disabled || !ready) return
    try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* synthetic pointer hosts still draw */ }
    const at = point(event)
    if (tool === 'eyedropper') { const p = ctx().getImageData(at.x, at.y, 1, 1).data; if (p[3]) setColor(`#${[p[0], p[1], p[2]].map(v => v.toString(16).padStart(2, '0')).join('')}`); return }
    snapshot()
    if (tool === 'fill') { fill(at); emit(); return }
    drawing.current = true; last.current = at; dot(at.x, at.y)
  }
  function move(event: React.PointerEvent<HTMLCanvasElement>) { if (!drawing.current) return; const at = point(event); if (last.current) line(last.current, at); last.current = at }
  function up() { if (!drawing.current) return; drawing.current = false; last.current = null; emit() }
  function restore(from: ImageData[], to: ImageData[]) { const value = from.pop(); if (!value) return; const c = ctx(); if (!c) return; to.push(c.getImageData(0, 0, width, height)); c.putImageData(value, 0, 0); setHistory(v => v + 1); emit() }
  function clear() { if (!window.confirm(`清空 ${label}？可以用撤销恢复。`)) return; snapshot(); ctx().clearRect(0, 0, width, height); emit() }
  function importPng(file?: File) {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => { const loaded = new Image(); loaded.onload = () => { if (loaded.naturalWidth < 16 || loaded.naturalHeight < 16 || loaded.naturalWidth > 512 || loaded.naturalHeight > 512) { setNotice('导入 PNG 尺寸必须在 16×16 到 512×512 之间'); return }; const canvas = canvasRef.current!; canvas.width = loaded.naturalWidth; canvas.height = loaded.naturalHeight; setSize([loaded.naturalWidth, loaded.naturalHeight]); const c = canvas.getContext('2d')!; c.clearRect(0, 0, loaded.naturalWidth, loaded.naturalHeight); c.drawImage(loaded, 0, 0); setNotice('已导入 PNG'); emit() }; loaded.src = String(reader.result) }
    reader.readAsDataURL(file)
  }
  const style = { width: width * zoom, height: height * zoom }
  return <section className="texture-painter" aria-label={`${label}绘制`}><div className="row"><div className="grow"><p className="eyebrow">PIXEL TEXTURE</p><h3>{label}绘制</h3><p className="muted">16～512 像素的 PNG 可以保存到工程；画布上的透明区域会保持透明。</p></div><span className="badge badge-INCONCLUSIVE">{width}×{height}</span></div>
    <div className="appearance-toolbar">{(['pencil', 'eraser', 'fill', 'eyedropper'] as Tool[]).map(value => <button key={value} disabled={disabled} aria-pressed={tool === value} onClick={() => setTool(value)}>{({ pencil: '铅笔', eraser: '橡皮', fill: '填充', eyedropper: '取色' })[value]}</button>)}<label className="appearance-color">颜色<input type="color" aria-label="画笔颜色" value={color} onChange={event => setColor(event.target.value)} /></label><label>笔刷<input type="number" aria-label="笔刷大小" min={1} max={16} value={brush} onChange={event => setBrush(Math.max(1, Math.min(16, Number(event.target.value) || 1)))} /></label><label>缩放<select aria-label="画布缩放" value={zoom} onChange={event => setZoom(Number(event.target.value))}><option value={2}>2×</option><option value={4}>4×</option><option value={8}>8×</option><option value={16}>16×</option></select></label><button disabled={disabled || !history} onClick={() => restore(undoStack.current, redoStack.current)}>撤销</button><button disabled={disabled || !redoStack.current.length} onClick={() => restore(redoStack.current, undoStack.current)}>重做</button><button disabled={disabled} onClick={clear}>清空</button><label className="button-like">导入<input type="file" accept="image/png" hidden onChange={event => importPng(event.target.files?.[0])} /></label><a className="button-like" href={canvasRef.current?.toDataURL('image/png') ?? '#'} download={`${label}.png`}>导出 PNG</a></div>
    <div className="appearance-canvas-wrap" style={style}><canvas ref={canvasRef} className="appearance-canvas" aria-label={`${label}画布`} style={style} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} /><div className="appearance-grid" style={{ backgroundSize: `${zoom}px ${zoom}px` }} /></div>
    <div className="appearance-palette">{palette.map(value => <button key={value} aria-label={`颜色 ${value}`} className="swatch" style={{ background: value }} onClick={() => setColor(value)} />)}</div>{notice && <p className="muted" role="status">{notice}</p>}
  </section>
}
