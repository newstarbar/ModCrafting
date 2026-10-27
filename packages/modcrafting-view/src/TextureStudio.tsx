import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, PointerEvent as ReactPointerEvent } from 'react'
import { action, currentSession, uploadTextureSource } from './client.ts'
import { analyzeTexture, defaultTextureOptions, normalizeTextureOptions, type TextureAnalysis, type TextureMetrics, type TextureOptions, type TextureSize, type TextureWarning } from '../../modcrafting-core/src/texture-core.ts'
import type { TextureRequest } from '../../modcrafting-core/src/texture-workspace.ts'
import {
  blankImage, cloneImage, drawLine, drawRect, extractColors, floodFill, fromBase64, hexToRgba, mirrorX, putPixel,
  replaceColor, rgbaAt, rgbaToHex, toBase64, type PixelImage, type PixelTool, type RGBA
} from './pixel-editor.ts'

type TextureSummary = { textureId: string; name: string; filePath: string; revision: string; image: string; sizeBytes: number }
type Candidate = { candidateId: string; createdAt: string; image: string | null; options: TextureOptions; metrics?: TextureMetrics; failures?: TextureWarning[]; warnings?: TextureWarning[] }
type TextureReply = {
  ok: boolean; textureId: string; filePath: string; exists?: boolean
  image: string | null; pixels: { width: number; height: number; base64: string } | null
  palette: string[]; metrics: TextureMetrics | null; failures: TextureWarning[]; warnings: TextureWarning[]
  qualityOk: boolean; revision: string | null; previewRevision?: string; candidateId?: string; options?: TextureOptions
}
type ListReply = { ok: boolean; textures: TextureSummary[]; candidates: Candidate[] }
type ContentDocument = { id: string; kind?: string; editable: boolean; revision: string; value?: { displayName?: string; texture?: string } }
type Brief = {
  prompt: string; negativePrompt: string; size: TextureSize; background: string; palette: string[]
  target: { textureId: string; filePath: string }; standard: string; checklist: string[]; instructions: string[]
}
type Draft = { textureId: string; revision: string | null; base64: string; width: number; height: number; options: TextureOptions; candidateId?: string }

const tools: Array<{ id: PixelTool; label: string; key: string }> = [
  { id: 'pencil', label: '铅笔', key: 'B' }, { id: 'eraser', label: '橡皮', key: 'E' }, { id: 'fill', label: '填充', key: 'G' },
  { id: 'eyedropper', label: '吸管', key: 'I' }, { id: 'line', label: '直线', key: 'L' }, { id: 'rect', label: '矩形', key: 'R' }
]
const draftKey = (scope: string, textureId: string) => `modcrafting-draft:${currentSession()}:texture:${scope}:${textureId}`
const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32) || 'new_texture'
const standardSize = (value: number): TextureSize => value === 32 || value === 64 ? value : 16

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file) })
}
function readDraft(scope: string, textureId: string): Draft | undefined {
  try { const value = JSON.parse(sessionStorage.getItem(draftKey(scope, textureId)) || 'null') as Draft | null; return value?.textureId === textureId && value.base64 ? value : undefined } catch { return undefined }
}
function removeDraft(scope: string, textureId: string) { try { sessionStorage.removeItem(draftKey(scope, textureId)) } catch { /* storage can be unavailable */ } }

export function TextureStudio({ projectPath, modId }: { projectPath: string; modId: string }) {
  const [textures, setTextures] = useState<TextureSummary[]>([])
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [selected, setSelected] = useState('')
  const [textureIdInput, setTextureIdInput] = useState(`${modId}:item/new_texture`)
  const [pixels, setPixels] = useState<PixelImage>()
  const [revision, setRevision] = useState<string | null>(null)
  const [candidateId, setCandidateId] = useState<string>()
  const [sourceImage, setSourceImage] = useState('')
  const [options, setOptions] = useState<TextureOptions>({ ...defaultTextureOptions, size: 16 })
  const [brief, setBrief] = useState<Brief>()
  const [description, setDescription] = useState('')
  const [itemId, setItemId] = useState('')
  const [briefBackground, setBriefBackground] = useState<'magenta' | 'white' | 'transparent' | 'auto'>('magenta')
  const [tool, setTool] = useState<PixelTool>('pencil')
  const [color, setColor] = useState('#c8c8c8')
  const [replaceWith, setReplaceWith] = useState('#ffffff')
  const [zoom, setZoom] = useState(16)
  const [grid, setGrid] = useState(true)
  const [mirror, setMirror] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [dirty, setDirty] = useState(false)
  const [undoStack, setUndoStack] = useState<Uint8ClampedArray[]>([])
  const [redoStack, setRedoStack] = useState<Uint8ClampedArray[]>([])
  const [contentDocs, setContentDocs] = useState<ContentDocument[]>([])
  const [bindId, setBindId] = useState('')
  const [query, setQuery] = useState('')
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const previewRef = useRef<HTMLCanvasElement>(null)
  const pixelsRef = useRef<PixelImage | undefined>(undefined)
  const dragRef = useRef<{ startX: number; startY: number; lastX: number; lastY: number; base: PixelImage } | undefined>(undefined)
  const fileRef = useRef<HTMLInputElement>(null)

  const currentId = selected || textureIdInput
  const textRequest = <T,>(value: TextureRequest) => action<T>({ operation: 'texture', request: value })
  const palette = useMemo(() => pixels ? extractColors(pixels, 32) : [], [pixels])
  const analysis = useMemo(() => pixels ? analyzeTexture(pixels, { ...options, pixelize: false, trim: false, background: 'keep', outlineExpansion: false }) : undefined, [pixels, options])
  const filtered = textures.filter(value => `${value.textureId} ${value.name}`.toLowerCase().includes(query.toLowerCase()))

  useEffect(() => { pixelsRef.current = pixels }, [pixels])
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !pixels) return
    canvas.width = pixels.width; canvas.height = pixels.height
    const context = canvas.getContext('2d')
    if (!context) return
    context.imageSmoothingEnabled = false
    context.putImageData(new ImageData(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height), 0, 0)
    const preview = previewRef.current
    if (preview) {
      preview.width = 64; preview.height = 64
      const previewContext = preview.getContext('2d')
      if (previewContext) { previewContext.imageSmoothingEnabled = false; previewContext.clearRect(0, 0, 64, 64); previewContext.drawImage(canvas, 0, 0, 64, 64) }
    }
  }, [pixels])
  useEffect(() => {
    if (!pixels) return
    try {
      if (dirty) sessionStorage.setItem(draftKey(projectPath, currentId), JSON.stringify({ textureId: currentId, revision, base64: toBase64(pixels), width: pixels.width, height: pixels.height, options, candidateId } satisfies Draft))
      else removeDraft(projectPath, currentId)
    } catch { /* session storage is best-effort */ }
  }, [dirty, pixels, options, revision, candidateId, currentId, projectPath])
  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])
  useEffect(() => {
    const shortcuts = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); if (event.shiftKey) redo(); else undo(); return }
      const found = tools.find(value => value.key.toLowerCase() === event.key.toLowerCase())
      if (found) { setTool(found.id); return }
      if (event.key === '+' || event.key === '=') setZoom(value => Math.min(48, value + 4))
      if (event.key === '-') setZoom(value => Math.max(4, value - 4))
    }
    window.addEventListener('keydown', shortcuts); return () => window.removeEventListener('keydown', shortcuts)
  })
  useEffect(() => {
    let active = true
    void run(async () => {
      const list = await textRequest<ListReply>({ action: 'list', projectPath })
      if (!active) return
      setTextures(list.textures); setCandidates(list.candidates || [])
      const first = list.textures[0]
      if (first) await loadTexture(first.textureId)
      await refreshContent()
    })
    return () => { active = false }
  }, [projectPath])

  async function run(work: () => Promise<void>) { setBusy(true); setError(''); try { await work() } catch (cause) { if (!(cause instanceof DOMException && cause.name === 'AbortError')) setError(String(cause)) } finally { setBusy(false) } }
  function pushUndo() { const image = pixelsRef.current; if (!image) return; setUndoStack(stack => [...stack.slice(-63), new Uint8ClampedArray(image.data)]); setRedoStack([]) }
  function commit(next: PixelImage, record = false) { if (record) pushUndo(); pixelsRef.current = next; setPixels(next); setDirty(true) }
  function undo() {
    if (!pixels || !undoStack.length) return
    const previous = undoStack.at(-1)!
    setRedoStack(stack => [...stack, new Uint8ClampedArray(pixels.data)])
    const restored = { width: pixels.width, height: pixels.height, data: new Uint8ClampedArray(previous) }
    setUndoStack(stack => stack.slice(0, -1)); pixelsRef.current = restored; setPixels(restored); setDirty(true)
  }
  function redo() {
    if (!pixels || !redoStack.length) return
    const next = redoStack.at(-1)!
    setUndoStack(stack => [...stack, new Uint8ClampedArray(pixels.data)])
    const restored = { width: pixels.width, height: pixels.height, data: new Uint8ClampedArray(next) }
    setRedoStack(stack => stack.slice(0, -1)); pixelsRef.current = restored; setPixels(restored); setDirty(true)
  }
  function patch(next: Partial<TextureOptions>) { setOptions(old => normalizeTextureOptions({ ...old, ...next })); setDirty(true) }
  function colorFor(): RGBA { return tool === 'eraser' ? [0, 0, 0, 0] : hexToRgba(color) }

  async function refreshList(textureId?: string) {
    const list = await textRequest<ListReply>({ action: 'list', projectPath, ...(textureId ? { textureId } : {}) })
    setTextures(list.textures); setCandidates(list.candidates || [])
  }
  async function refreshContent() {
    const reply = await action<{ documents?: ContentDocument[] }>({ operation: 'content', request: { action: 'list', projectPath } })
    const docs = (reply.documents || []).filter(value => value.editable && value.value && (!value.kind || ['item', 'food', 'tool', 'armor'].includes(value.kind)))
    setContentDocs(docs); setBindId(current => current && docs.some(value => value.id === current) ? current : docs[0]?.id || '')
  }
  async function loadTexture(textureId: string) {
    const value = await textRequest<TextureReply>({ action: 'read', projectPath, textureId })
    setSelected(textureId); setTextureIdInput(textureId); setRevision(value.revision); setCandidateId(undefined); setSourceImage('')
    const draft = readDraft(projectPath, textureId)
    let image = value.pixels ? fromBase64(value.pixels.base64, value.pixels.width, value.pixels.height) : undefined
    if (draft) {
      if (draft.revision === value.revision) {
        image = fromBase64(draft.base64, draft.width, draft.height)
        setOptions(normalizeTextureOptions(draft.options)); setCandidateId(draft.candidateId); setDirty(true); setMessage('已恢复未保存草稿')
      } else { removeDraft(projectPath, textureId); setMessage('草稿已过期，已读取工程贴图') }
    } else { setDirty(false); setMessage(value.exists ? '已读取工程贴图' : '这个贴图还不存在；导入 PNG 或直接绘制后保存') }
    if (image) { setPixels(image); if (!draft) setOptions(old => ({ ...old, size: standardSize(image!.width) })) } else { setPixels(undefined); setOptions(old => ({ ...old, size: 16 })) }
    setUndoStack([]); setRedoStack([])
    await refreshList(textureId)
  }
  function openNew() {
    const image = blankImage(options.size, options.size)
    setSelected(''); setTextureIdInput(`${modId}:item/new_texture`); setRevision(null); setCandidateId(undefined); setSourceImage('')
    setPixels(image); pixelsRef.current = image; setDirty(true); setUndoStack([]); setRedoStack([]); setCandidates([]); setMessage('已创建空白画布；绘制或导入 PNG 后保存')
  }
  function applyReply(value: TextureReply) {
    if (!value.pixels) return
    const image = fromBase64(value.pixels.base64, value.pixels.width, value.pixels.height)
    setPixels(image); pixelsRef.current = image; setRevision(value.revision); setCandidateId(value.candidateId ?? candidateId)
    setOptions(old => ({ ...old, size: standardSize(image.width) })); setDirty(true); setUndoStack([]); setRedoStack([])
  }

  function point(event: ReactPointerEvent<HTMLCanvasElement>) {
    const image = pixelsRef.current
    if (!image) return undefined
    const rect = event.currentTarget.getBoundingClientRect()
    return {
      x: Math.max(0, Math.min(image.width - 1, Math.floor((event.clientX - rect.left) / rect.width * image.width))),
      y: Math.max(0, Math.min(image.height - 1, Math.floor((event.clientY - rect.top) / rect.height * image.height)))
    }
  }
  function strokeLine(image: PixelImage, x0: number, y0: number, x1: number, y1: number, stroke: RGBA) {
    drawLine(image, x0, y0, x1, y1, stroke)
    if (mirror) drawLine(image, image.width - 1 - x0, y0, image.width - 1 - x1, y1, stroke)
  }
  function strokeRect(image: PixelImage, x0: number, y0: number, x1: number, y1: number, stroke: RGBA) {
    drawRect(image, x0, y0, x1, y1, stroke)
    if (mirror) drawRect(image, image.width - 1 - x0, y0, image.width - 1 - x1, y1, stroke)
  }
  function pointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    const image = pixelsRef.current
    if (!image || busy) return
    const position = point(event)
    if (!position) return
    event.currentTarget.setPointerCapture(event.pointerId)
    if (tool === 'eyedropper') {
      const picked = rgbaAt(image, position.x, position.y)
      if (picked[3] === 0) { setColor('#000000'); setMessage('取到透明像素；使用橡皮或继续取色') }
      else { setColor(rgbaToHex(picked)); setMessage('已取色 ' + rgbaToHex(picked)) }
      return
    }
    pushUndo()
    if (tool === 'fill') {
      const next = cloneImage(image); floodFill(next, position.x, position.y, colorFor()); if (mirror) mirrorX(next); commit(next); return
    }
    const next = cloneImage(image)
    if (tool === 'pencil' || tool === 'eraser') putPixel(next, position.x, position.y, colorFor())
    else if (tool === 'line') strokeLine(next, position.x, position.y, position.x, position.y, colorFor())
    else strokeRect(next, position.x, position.y, position.x, position.y, colorFor())
    dragRef.current = { startX: position.x, startY: position.y, lastX: position.x, lastY: position.y, base: cloneImage(image) }
    commit(next)
  }
  function pointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    const drag = dragRef.current, image = pixelsRef.current
    if (!drag || !image) return
    const position = point(event)
    if (!position) return
    const next = tool === 'pencil' || tool === 'eraser' ? cloneImage(image) : cloneImage(drag.base)
    if (tool === 'pencil' || tool === 'eraser') strokeLine(next, drag.lastX, drag.lastY, position.x, position.y, colorFor())
    else if (tool === 'line') strokeLine(next, drag.startX, drag.startY, position.x, position.y, colorFor())
    else if (tool === 'rect') strokeRect(next, drag.startX, drag.startY, position.x, position.y, colorFor())
    drag.lastX = position.x; drag.lastY = position.y
    commit(next)
  }
  function pointerUp() { dragRef.current = undefined }

  async function generateBrief() {
    if (!description.trim()) throw Error('先描述要生成的物品，例如“黑曜石紫水晶长剑”。')
    const value = await textRequest<Brief>({ action: 'prompt', projectPath, itemId: itemId.trim() || undefined, description: description.trim(), size: options.size, background: briefBackground })
    setBrief(value); setTextureIdInput(value.target.textureId); setMessage('提示词包已生成；复制给聊天 Agent 生图，再回到这里导入 PNG')
  }
  async function importFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.png') && file.type !== 'image/png') throw Error('首版只接受 PNG 源图；请让 Agent 导出 PNG。')
    if (file.size > 8 * 1024 * 1024) throw Error('源图超过 8MB，请先压缩。')
    const dataUrl = await fileToDataUrl(file)
    const upload = await uploadTextureSource(file)
    const value = await textRequest<TextureReply>({ action: 'import', projectPath, textureId: currentId, sourceToken: upload.sourceToken, options, prompt: brief?.prompt })
    setSourceImage(dataUrl); setSelected(currentId); setTextureIdInput(currentId); applyReply(value); setMessage('已导入并完成 MC 像素化；检查质检和画布，再保存到工程')
    await refreshList(currentId)
  }
  async function previewSource() {
    if (!candidateId) throw Error('先导入 AI 源图，或在左侧选择一个 AI 候选。')
    const value = await textRequest<TextureReply>({ action: 'preview', projectPath, textureId: currentId, candidateId, options })
    applyReply(value); setMessage('已按当前参数重新像素化；检查后保存')
  }
  async function previewRefine() {
    if (!pixels) throw Error('画布还没有像素。')
    const value = await textRequest<TextureReply>({ action: 'preview', projectPath, textureId: currentId, pixelsBase64: toBase64(pixels), width: pixels.width, height: pixels.height, options: { ...options, pixelize: false, trim: false, background: 'keep', outlineExpansion: false } })
    applyReply(value); setMessage('已应用二次优化参数；可撤销或继续编辑')
  }
  async function save() {
    if (!pixels) throw Error('没有可保存的像素。')
    const body = { pixelsBase64: toBase64(pixels), width: pixels.width, height: pixels.height, options }
    const preview = await textRequest<TextureReply>({ action: 'preview', projectPath, textureId: currentId, ...body, analyzeOnly: true })
    if (preview.failures?.length) throw Error(preview.failures.map(value => value.message + value.fix).join('；'))
    if (!preview.previewRevision) throw Error('质检未返回 previewRevision，请重试。')
    const value = await textRequest<TextureReply>({ action: 'save', projectPath, textureId: currentId, ...body, expectedRevision: revision, previewRevision: preview.previewRevision })
    setSelected(currentId); setRevision(value.revision); setDirty(false); setMessage('已保存到工程；需要重新构建并重启 Minecraft 才能看到新贴图。'); await refreshList(currentId)
  }
  async function bind() {
    const document = contentDocs.find(value => value.id === bindId)
    if (!document) throw Error('先选择一个可编辑的物品/工具/食物/护甲内容对象。')
    await textRequest({ action: 'bind', projectPath, contentId: document.id, textureId: currentId, expectedRevision: document.revision })
    setMessage('已绑定到内容对象；重新构建并重启 Minecraft 后验证游戏内外观。'); await refreshContent()
  }
  async function copy(value: string) {
    try { await navigator.clipboard.writeText(value); setMessage('已复制到剪贴板') }
    catch { setMessage('复制失败，请手动选择文本复制') }
  }
  async function loadCandidate(id: string) {
    const value = await textRequest<TextureReply>({ action: 'preview', projectPath, textureId: currentId, candidateId: id, options })
    applyReply(value); setCandidateId(id); setSourceImage(''); setMessage('已载入候选；可继续微调和保存')
  }

  return <section className="panel texture-workspace" aria-label="物品贴图工作区">
    <div className="row"><div className="grow"><p className="eyebrow">TEXTURE / FABRIC 1.21.4</p><h2>AI 物品贴图</h2><p className="muted">常规流程在聊天里由 Agent 自动完成生成、导入、保存与绑定；本页用于逐像素手工润色和参数化二次优化。</p></div><span className={`badge badge-${dirty ? 'INCONCLUSIVE' : 'PASS'}`}>{dirty ? '未保存草稿' : '已同步工程'}</span></div>
    <div className="texture-layout">
      <aside className="texture-list">
        <div className="row"><strong>工程贴图 · {textures.length}</strong><button disabled={busy} onClick={() => void run(() => refreshList(selected || undefined))}>刷新</button></div>
        <input aria-label="搜索贴图" placeholder="搜索贴图" value={query} onChange={event => setQuery(event.target.value)} />
        <button className="texture-new" disabled={busy} onClick={openNew}>＋ 新建空白</button>
        {filtered.map(value => <button key={value.textureId} className={selected === value.textureId ? 'selected' : ''} disabled={busy} onClick={() => void run(() => loadTexture(value.textureId))}><span className="texture-thumb"><img src={value.image} alt="" /></span><span><strong>{value.name}</strong><small>{value.textureId}</small></span></button>)}
        {!filtered.length && <p className="muted">工程里还没有物品贴图。让 Agent 生成，或拖入一张 PNG。</p>}
        <div className="texture-candidates"><strong>AI 候选 · {candidates.length}</strong>
          {candidates.map(value => <button key={value.candidateId} disabled={busy} onClick={() => void run(() => loadCandidate(value.candidateId))}><span className="texture-thumb">{value.image && <img src={value.image} alt="" />}</span><span><small>{new Date(value.createdAt).toLocaleString()}</small><small>{value.metrics ? `${value.metrics.width}×${value.metrics.height} · ${value.metrics.uniqueColors} 色` : '候选'}</small></span></button>)}
          {!candidates.length && <p className="muted">导入 AI 源图后会在这里保留候选。</p>}
        </div>
      </aside>
      <div className="texture-editor">
        <div className="texture-toolbar" role="toolbar" aria-label="像素工具">
          {tools.map(value => <button key={value.id} disabled={!pixels || busy} aria-pressed={tool === value.id} title={`${value.label} (${value.key})`} onClick={() => setTool(value.id)}>{value.label}</button>)}
          <span className="texture-toolbar-separator" />
          <button disabled={!undoStack.length} onClick={undo}>撤销</button><button disabled={!redoStack.length} onClick={redo}>重做</button>
          <label className="texture-inline"><input type="checkbox" checked={mirror} onChange={event => setMirror(event.target.checked)} />镜像</label>
          <label className="texture-inline"><input type="checkbox" checked={grid} onChange={event => setGrid(event.target.checked)} />网格</label>
          <label className="texture-inline">缩放<select value={zoom} onChange={event => setZoom(Number(event.target.value))}>{[8, 12, 16, 24, 32, 48].map(value => <option key={value} value={value}>{value}px</option>)}</select></label>
        </div>
        {pixels ? <div className="texture-canvas-shell pixel-checker" style={{ width: pixels.width * zoom, height: pixels.height * zoom }}>
          <canvas ref={canvasRef} className="texture-canvas" style={{ width: pixels.width * zoom, height: pixels.height * zoom }} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp} />
          {grid && <div className="texture-grid" style={{ backgroundSize: `${zoom}px ${zoom}px` }} />}
        </div> : <div className="texture-empty"><strong>没有打开的贴图</strong><p>从左侧选择、新建空白，或在右侧导入 AI 生成的 PNG。</p></div>}
        <div className="row texture-id-row"><label className="grow">贴图 ID<input value={textureIdInput} disabled={busy} onChange={event => setTextureIdInput(event.target.value)} placeholder={`${modId}:item/name`} /></label><label>当前颜色<input type="color" value={color} disabled={busy} onChange={event => setColor(event.target.value)} /></label><label>替换为<input type="color" value={replaceWith} onChange={event => setReplaceWith(event.target.value)} /></label><button disabled={!pixels || busy} onClick={() => { if (!pixels) return; const next = cloneImage(pixels); replaceColor(next, color, replaceWith); commit(next, true) }}>替换当前色</button></div>
        <div className="texture-palette" aria-label="调色板">{palette.map(value => <button key={value} title={value} aria-pressed={color.toLowerCase() === value} className={color.toLowerCase() === value ? 'selected' : ''} style={{ background: value }} onClick={() => setColor(value)} />)}{!palette.length && <span className="muted">画布还没有不透明颜色。</span>}</div>
        {analysis && <Quality analysis={analysis} />}
        <div className="row texture-save"><button className="primary" disabled={!pixels || busy} onClick={() => void run(save)}>保存到工程</button><button disabled={!candidateId || busy} onClick={() => void run(previewSource)}>重新像素化</button><button disabled={!pixels || busy} onClick={() => void run(previewRefine)}>应用二次优化</button><span className="muted">{revision ? `revision ${revision.slice(0, 8)}` : '尚未写入工程'}</span></div>
      </div>
      <aside className="texture-side">
        <section className="texture-card"><h3>1 · AI 生成</h3><p className="muted">推荐直接在聊天里让 Agent 全自动出图；此面板供手动生成提示词。</p><label>物品描述<textarea rows={2} value={description} onChange={event => setDescription(event.target.value)} placeholder="例如：黑曜石紫水晶长剑，透明背景" /></label><label>物品 ID（可选）<input value={itemId} onChange={event => setItemId(event.target.value)} placeholder={`${modId}:amethyst_sword`} /></label><div className="row"><label>背景<select value={briefBackground} onChange={event => setBriefBackground(event.target.value as typeof briefBackground)}><option value="magenta">品红背景（推荐）</option><option value="white">白色背景</option><option value="transparent">透明背景</option></select></label><label>目标尺寸<select value={options.size} onChange={event => patch({ size: Number(event.target.value) as TextureSize })}><option value={16}>16×16</option><option value={32}>32×32</option><option value={64}>64×64</option></select></label></div><button disabled={busy} onClick={() => void run(generateBrief)}>生成提示词包</button>
          {brief && <div className="texture-brief"><p><strong>目标</strong> <code>{brief.target.textureId}</code> · {brief.standard}</p><label>Prompt<textarea readOnly rows={5} value={brief.prompt} /></label><button onClick={() => void copy(brief.prompt)}>复制 Prompt</button><label>Negative<textarea readOnly rows={2} value={brief.negativePrompt} /></label><button onClick={() => void copy(brief.negativePrompt)}>复制负向词</button><ol>{brief.checklist.map(value => <li key={value}>{value}</li>)}</ol></div>}
        </section>
        <section className="texture-card"><h3>2 · 导入与候选</h3><p className="muted">把 Agent 生成的 PNG 拖入或选择。导入会自动抠背景、像素化并质检。</p><input ref={fileRef} type="file" accept="image/png,.png" disabled={busy} onChange={event => void run(() => importFile(event))} /><div className="row"><button disabled={busy} onClick={() => fileRef.current?.click()}>选择 PNG</button><button disabled={!candidateId || busy} onClick={() => void run(previewSource)}>按参数重新像素化</button></div>{sourceImage && <figure className="texture-source"><img src={sourceImage} alt="AI 源图" /><figcaption>AI 源图；画布为处理结果</figcaption></figure>}<div className="texture-preview"><div className="pixel-checker"><canvas ref={previewRef} /></div><figcaption>64px 物品预览</figcaption></div></section>
        <section className="texture-card"><h3>3 · 二次优化</h3><div className="texture-options"><label>调色板<select value={options.paletteSize} onChange={event => patch({ paletteSize: Number(event.target.value) })}>{[8, 12, 16, 20, 24, 32].map(value => <option key={value} value={value}>{value} 色</option>)}</select></label><label>抖动<select value={options.dither} onChange={event => patch({ dither: event.target.value as TextureOptions['dither'] })}><option value="none">关闭</option><option value="bayer2">Bayer 2×2</option><option value="bayer4">Bayer 4×4</option><option value="floyd">Floyd–Steinberg</option></select></label><label>描边<select value={options.outline} onChange={event => patch({ outline: Number(event.target.value) as TextureOptions['outline'] })}><option value={0}>无</option><option value={1}>轻</option><option value={2}>中</option><option value={3}>重</option></select></label><label>背景<select value={options.background} onChange={event => patch({ background: event.target.value as TextureOptions['background'] })}><option value="auto">自动抠除</option><option value="keep">保留</option><option value="chroma">色度键</option><option value="color">指定色</option></select></label><label>Alpha 阈值<input type="number" min={1} max={254} value={options.alphaThreshold} onChange={event => patch({ alphaThreshold: Number(event.target.value) })} /></label><label>容差<input type="number" min={0} max={255} value={options.backgroundTolerance} onChange={event => patch({ backgroundTolerance: Number(event.target.value) })} /></label><label>对比度<input type="number" min={-50} max={50} value={options.contrast} onChange={event => patch({ contrast: Number(event.target.value) })} /></label><label>饱和度<input type="number" min={-50} max={50} value={options.saturation} onChange={event => patch({ saturation: Number(event.target.value) })} /></label><label>材质换色<select value={options.recolor?.preset || ''} onChange={event => patch({ recolor: event.target.value ? { preset: event.target.value as NonNullable<TextureOptions['recolor']>['preset'] } : undefined })}><option value="">不换色</option><option value="wood">木</option><option value="stone">石</option><option value="iron">铁</option><option value="gold">金</option><option value="diamond">钻石</option><option value="netherite">下界合金</option><option value="amethyst">紫水晶</option></select></label></div><button disabled={!pixels || busy} onClick={() => void run(previewRefine)}>应用到画布</button><p className="muted">参数会作用到当前画布；“重新像素化”从 AI 源图重新生成。</p></section>
        <section className="texture-card"><h3>4 · 绑定到物品</h3><select value={bindId} onChange={event => setBindId(event.target.value)} disabled={!contentDocs.length}>{contentDocs.map(value => <option key={value.id} value={value.id}>{value.value?.displayName || value.id} · {value.value?.texture || '默认纹理'}</option>)}</select><button disabled={!bindId || !pixels || busy} onClick={() => void run(bind)}>绑定当前贴图</button>{!contentDocs.length && <p className="muted">工程还没有可编辑的物品/工具/食物/护甲对象；先在“内容”工作区创建。</p>}</section>
      </aside>
    </div>
    {error && <p role="alert" className="message error top-message">{error}<button onClick={() => setError('')}>收起</button></p>}
    {message && <p role="status" className="message top-message">{message}</p>}
  </section>
}

function Quality({ analysis }: { analysis: TextureAnalysis }) {
  const metrics = analysis.metrics
  return <div className={`texture-quality ${analysis.ok ? 'ok' : 'bad'}`}>
    <div className="row"><strong>质检</strong><span className={`badge badge-${analysis.ok ? 'PASS' : 'FAIL'}`}>{analysis.ok ? '结构通过' : '有硬性问题'}</span><span className="muted">{metrics.width}×{metrics.height} · {metrics.visiblePixels}px · {metrics.uniqueColors} 色 · {Math.round(metrics.occupancy * 100)}% 占用</span></div>
    {analysis.failures.map(value => <p className="error" key={value.code}>{value.message} {value.fix}</p>)}
    {analysis.warnings.map(value => <p className="texture-warning" key={value.code}>{value.message} {value.fix}</p>)}
    {!analysis.failures.length && !analysis.warnings.length && <p className="connected">尺寸、Alpha、剪影和配色都符合当前规则。</p>}
  </div>
}
