import { useEffect, useMemo, useRef, useState } from 'react'
import { action, currentSession } from './client.ts'
import { contentObjectSchema, newContentObject, type ContentDocument, type ContentFile, type ContentObject } from '../../modcrafting-core/src/content-model.ts'
import type { ContentRequest } from '../../modcrafting-core/src/content-workspace.ts'
import type { VoxelDsl } from '../../modcrafting-core/src/voxel-dsl.ts'
import { meshVoxel } from '../../modcrafting-core/src/voxel-mesh.ts'
import { VoxelCanvas, type VoxelEdit } from './VoxelCanvas.tsx'
import { defaultVoxel, flattenVoxel, gridFromDsl, layersFromGrid, paletteSymbolsOf, sizeOf } from './voxel-editor.ts'

type Request = ContentRequest extends infer T ? T extends { projectPath: string } ? Omit<T, 'projectPath'> : never : never
type Reply = { document?: ContentDocument; documents?: ContentDocument[]; files?: ContentFile[]; previewRevision?: string; image?: string }
type Tool = 'place' | 'erase' | 'paint'

const atlasPath = (draft: ContentObject) => `${draft.texture.split(':')[0]}:${draft.kind === 'block' ? 'block' : 'item'}/${draft.id.split(':')[1]}_atlas`

function remapGrid(grid: Uint8Array, previous: string[], next: string[]): Uint8Array {
  const mapping = new Map<number, number>()
  previous.forEach((symbol, index) => {
    const position = next.indexOf(symbol)
    mapping.set(index + 1, position >= 0 ? position + 1 : 0)
  })
  const output = new Uint8Array(grid.length)
  for (let index = 0; index < grid.length; index += 1) output[index] = mapping.get(grid[index]) ?? 0
  return output
}

export function ModelEditor({ projectPath, modId }: { projectPath: string; modId: string }) {
  const storageKey = `modcrafting-draft:${currentSession()}:voxel:${projectPath}`
  const [restored] = useState(() => { try { return JSON.parse(sessionStorage.getItem(storageKey) || 'null') as { document?: ContentDocument; draft?: ContentObject } | null } catch { return null } })
  const [documents, setDocuments] = useState<ContentDocument[]>([])
  const [document, setDocument] = useState<ContentDocument | undefined>(restored?.document)
  const [draft, setDraft] = useState<ContentObject | undefined>(restored?.draft)
  const [dirty, setDirty] = useState(Boolean(restored?.draft))
  const [preview, setPreview] = useState<Reply>()
  const [tool, setTool] = useState<Tool>('place')
  const [symbolName, setSymbolName] = useState('a')
  const [symmetry, setSymmetry] = useState('')
  const [layerLock, setLayerLock] = useState(false)
  const [activeLayer, setActiveLayer] = useState(0)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('')
  const undoRef = useRef<Uint8Array[]>([]), redoRef = useRef<Uint8Array[]>([])
  const [historyVersion, setHistoryVersion] = useState(0)

  const request = (value: Request) => action<Reply>({ operation: 'content', request: { ...value, projectPath } as ContentRequest })
  const run = async (work: () => Promise<void>) => { setBusy(true); setError(''); try { await work() } catch (cause) { setError(String(cause)) } finally { setBusy(false) } }
  const symbols = useMemo(() => draft?.voxel ? paletteSymbolsOf(draft.voxel) : [], [draft])
  const flattenPending = Boolean(draft?.voxel?.ops?.length)
  const gridState = useMemo(() => draft?.voxel ? gridFromDsl(draft.voxel) : undefined, [draft])
  const grid = gridState?.grid
  const stats = useMemo(() => {
    if (!grid || !draft?.voxel) return undefined
    const { rects, exposedFaces } = meshVoxel(grid, sizeOf(draft.voxel), draft.voxel.optimize.merge)
    return { cuboids: rects.length, exposedFaces, solid: grid.reduce((sum, value) => sum + (value ? 1 : 0), 0) }
  }, [grid, draft])
  const validation = draft ? contentObjectSchema.safeParse(voxelForSave()) : undefined

  function voxelForSave(): ContentObject {
    if (!draft?.voxel || !grid) return draft!
    const flattened = flattenVoxel(draft.voxel, grid, gridState!.symbols)
    return { ...draft, voxel: flattened }
  }
  function persist(next: { document?: ContentDocument; draft?: ContentObject; dirty: boolean }) {
    if (next.dirty && next.draft) sessionStorage.setItem(storageKey, JSON.stringify({ document: next.document, draft: next.draft }))
    else sessionStorage.removeItem(storageKey)
  }
  function change(next: ContentObject) { setDraft(next); setDirty(true); setPreview(undefined); setMessage(''); persist({ document, draft: next, dirty: true }) }

  const refresh = async () => setDocuments(((await request({ action: 'list' })).documents || []).filter(doc => doc.value?.voxel))
  useEffect(() => {
    let active = true
    void run(async () => {
      const rows = ((await request({ action: 'list' })).documents || []).filter(doc => doc.value?.voxel)
      if (!active) return
      setDocuments(rows)
      if (restored?.draft) {
        const latest = rows.find(row => row.id === restored.draft!.id)
        if (!latest || latest.revision !== restored.document?.revision) {
          setDocument(undefined); setDraft(undefined); setDirty(false); sessionStorage.removeItem(storageKey)
          setError('草稿没有恢复：工程文件已在其他位置改变。请重新读取后再编辑。')
        }
      }
    })
    return () => { active = false }
  }, [projectPath])
  useEffect(() => { if (grid && layerLock && draft?.voxel && activeLayer >= sizeOf(draft.voxel)[1]) setActiveLayer(sizeOf(draft.voxel)[1] - 1) }, [layerLock, activeLayer, grid, draft])

  function fresh(kind: 'block' | 'item') {
    if (dirty && !window.confirm('放弃尚未保存的模型草稿？')) return
    const value = newContentObject(kind, modId)
    value.voxel = defaultVoxel()
    value.texture = `${modId}:${kind}/${value.id.split(':')[1]}_atlas`
    setDocument(undefined); setDraft(value); setDirty(false); setPreview(undefined); setError(''); setMessage('')
    undoRef.current = []; redoRef.current = []; setHistoryVersion(version => version + 1)
    setSymbolName('a'); setActiveLayer(0); setLayerLock(false)
    persist({ draft: value, dirty: false })
  }
  async function load(selected: ContentDocument) {
    if (dirty && !window.confirm('放弃当前草稿，重新读取工程模型？')) return
    const value = selected.value ? (await request({ action: 'read', id: selected.id })).document! : selected
    setDocument(value); setDraft(value.value); setDirty(false); setPreview(undefined); setMessage('')
    undoRef.current = []; redoRef.current = []; setHistoryVersion(version => version + 1)
    setSymbolName(value.value?.voxel ? paletteSymbolsOf(value.value.voxel)[0] ?? 'a' : 'a')
    persist({ document: value, draft: value.value, dirty: false })
  }
  function applyEdits(edits: VoxelEdit[]) {
    if (!grid || !draft?.voxel || flattenPending) return
    const [sx, , sz] = sizeOf(draft.voxel)
    const next = new Uint8Array(grid)
    for (const edit of edits) next[(edit.y * sz + edit.z) * sx + edit.x] = edit.value
    undoRef.current = [...undoRef.current.slice(-49), new Uint8Array(grid)]
    redoRef.current = []
    setHistoryVersion(version => version + 1)
    commitGrid(draft, next)
  }
  function commitGrid(base: ContentObject, cells: Uint8Array) {
    const voxel = base.voxel ? { ...base.voxel, layers: layersFromGrid(cells, sizeOf(base.voxel), paletteSymbolsOf(base.voxel)), ops: [] } : base.voxel
    const next = { ...base, voxel }
    setDraft(next); setDirty(true); setPreview(undefined); setMessage(''); persist({ document, draft: next, dirty: true })
  }
  function undo() {
    const previous = undoRef.current.pop()
    if (!previous || !grid || !draft) return
    redoRef.current = [...redoRef.current, new Uint8Array(grid)]
    setHistoryVersion(version => version + 1)
    commitGrid(draft, previous)
  }
  function redo() {
    const next = redoRef.current.pop()
    if (!next || !grid || !draft) return
    undoRef.current = [...undoRef.current, new Uint8Array(grid)]
    setHistoryVersion(version => version + 1)
    commitGrid(draft, next)
  }
  function flatten() {
    if (!draft?.voxel || !grid) return
    commitGrid(draft, grid)
    setMessage('已把 box 原语压平为可编辑图层。')
  }
  function updatePalette(symbol: string, patch: Record<string, unknown>) {
    if (!draft?.voxel) return
    const raw = draft.voxel.palette[symbol]
    const base = typeof raw === 'string' ? { color: raw, pattern: 'flat' as const } : raw
    change({ ...draft, voxel: { ...draft.voxel, palette: { ...draft.voxel.palette, [symbol]: { ...base, ...patch } } } })
  }
  function addSymbol() {
    if (!draft?.voxel) return
    const existing = paletteSymbolsOf(draft.voxel)
    const nextLetter = 'abcdefghijklmnopqrstuvwxyz'.split('').find(letter => !existing.includes(letter))
    if (!nextLetter) { setError('调色板最多 26 个符号。'); return }
    change({ ...draft, voxel: { ...draft.voxel, palette: { ...draft.voxel.palette, [nextLetter]: '#88aa66' } } })
  }
  function removeSymbol(symbol: string) {
    if (!draft?.voxel || !grid) return
    const previous = paletteSymbolsOf(draft.voxel)
    const used = grid.some(value => previous[value - 1] === symbol)
    if (used) { setError(`符号 ${symbol} 仍在模型中使用，先擦除或改色后再删除。`); return }
    const palette = { ...draft.voxel.palette }; delete palette[symbol]
    const nextSymbols = paletteSymbolsOf({ ...draft.voxel, palette })
    const next = { ...draft, voxel: { ...draft.voxel, palette } }
    undoRef.current = [...undoRef.current.slice(-49), new Uint8Array(grid)]
    setHistoryVersion(version => version + 1)
    setDraft(next)
    commitGrid(next, remapGrid(grid, previous, nextSymbols))
  }
  function resize(nextSize: [number, number, number]) {
    if (!draft?.voxel || document) return
    if (stats && stats.solid > 0 && !window.confirm('调整尺寸会清空当前体素，继续？')) return
    const voxel = { ...draft.voxel, size: nextSize, layers: Array.from({ length: nextSize[1] }, () => '-'), ops: [] }
    change({ ...draft, voxel })
  }

  const voxel = draft?.voxel
  const size = voxel ? sizeOf(voxel) : undefined
  const symbolIndex = voxel ? Math.max(1, symbols.indexOf(symbolName) + 1) : 1
  const swatch = (symbol: string) => { const raw = voxel?.palette[symbol]; return typeof raw === 'string' ? raw : raw?.color ?? '#888' }

  return <section className="panel model-workspace" aria-label="3D 体素模型工作区">
    <div className="row"><div className="grow"><p className="eyebrow">MODEL / VOXEL · FABRIC 1.21.4</p><h2>3D 模型工坊</h2><p className="muted">Agent 用体素 DSL 生成模型，你在这里旋转、增删体素、调色并保存；保存走统一 revision 冲突检查。</p></div><span className={`badge badge-${dirty ? 'INCONCLUSIVE' : 'PASS'}`}>{dirty ? '未应用草稿' : document ? '已读回工程' : '新模型'}</span></div>
    <div className="model-layout">
      <aside className="model-list">
        <div className="row"><strong>模型 · {documents.length}</strong><button disabled={busy} onClick={() => void run(refresh)}>刷新</button></div>
        {documents.map(doc => <button key={doc.id} className={document?.id === doc.id ? 'selected' : ''} disabled={busy} onClick={() => void run(() => load(doc))}><strong>{doc.value?.displayName || doc.id}</strong><small>{doc.id}</small><small>{doc.value?.voxel ? `${doc.value.voxel.size[0]}×${doc.value.voxel.size[1]}×${doc.value.voxel.size[2]}` : ''} · {doc.editable ? '可编辑' : '只读'}</small></button>)}
        {!documents.length && <p className="muted">还没有体素模型；用下面按钮新建，或让 Agent 通过 fabric_voxel_workspace 生成。</p>}
        <div className="row model-new"><button disabled={busy} onClick={() => fresh('block')}>新建方块模型</button><button disabled={busy} onClick={() => fresh('item')}>新建物品模型</button></div>
      </aside>
      {!draft || !voxel || !size || !grid ? <div className="model-body"><p className="muted">从左侧选择一个模型，或新建方块/物品模型开始。</p></div> : <>
        <div className="model-body">
          {document && !document.editable ? <div className="message"><h3>{document.id}</h3><p>{document.reason}</p><p>没有加载默认参数或覆盖源码。请让 Agent 检查以下文件：</p><pre>{document.files.join('\n')}</pre></div> : <>
            <div className="content-heading"><div className="content-appearance">{preview?.image ? <img src={preview.image} alt="图集预览" /> : <span aria-hidden>⬢</span>}</div><div className="grow"><h3>{draft.displayName || '新模型'}</h3><code>{draft.id}</code><p className="muted">{flattenPending ? '此模型包含 box 原语；先压平为图层才能编辑。' : '拖动旋转 · 滚轮缩放 · 右键平移 · 单击编辑。'}</p></div></div>
            <div className="voxel-stage">{flattenPending ? <p className="muted voxel-readonly-note">只读预览：该模型由 Agent 以原语方式提交。</p> : undefined}<VoxelCanvas size={size} grid={grid} dsl={voxel} symbols={symbols} tool={tool} symbol={symbolIndex} symmetry={symmetry} layerLock={layerLock} activeLayer={activeLayer} onEdit={applyEdits} /></div>
            <div className="voxel-toolbar" role="toolbar" aria-label="编辑工具">
              {([['place', '增设'], ['paint', '涂色'], ['erase', '擦除']] as const).map(([value, label]) => <button key={value} aria-pressed={tool === value} onClick={() => setTool(value)}>{label}</button>)}
              <span className="toolbar-separator" />
              {([['', '自由'], ['x', '镜像X'], ['z', '镜像Z'], ['xz', '镜像XZ']] as const).map(([value, label]) => <button key={value || 'free'} aria-pressed={symmetry === value} onClick={() => setSymmetry(value)}>{label}</button>)}
              <span className="toolbar-separator" />
              <button disabled={!undoRef.current.length} onClick={undo}>撤销</button><button disabled={!redoRef.current.length} onClick={redo}>重做</button>
              <span className="toolbar-separator" />
              <label className="inline-check"><input type="checkbox" checked={layerLock} onChange={event => setLayerLock(event.target.checked)} />锁定层</label>
              <label className="inline-check">层 Y<input type="number" min={0} max={size[1] - 1} value={activeLayer} disabled={!layerLock} onChange={event => setActiveLayer(Math.max(0, Math.min(size[1] - 1, Number(event.target.value))))} /></label>
              {flattenPending && <button className="primary" onClick={flatten}>转为可编辑层</button>}
            </div>
            <div className="model-panels">
              <div className="model-panel">
                <h3>调色板 · {symbols.length}/26</h3>
                <div className="palette-grid">{symbols.map(symbol => <div key={symbol} className={`palette-row${symbolName === symbol ? ' selected' : ''}`}>
                  <button className="palette-swatch" style={{ background: swatch(symbol) }} aria-pressed={symbolName === symbol} title={`选择 ${symbol}`} onClick={() => setSymbolName(symbol)} />
                  <code>{symbol}</code>
                  <input type="color" value={swatch(symbol)} aria-label={`${symbol} 颜色`} onChange={event => updatePalette(symbol, { color: event.target.value })} />
                  <select aria-label={`${symbol} 纹理图案`} value={typeof voxel.palette[symbol] === 'string' ? 'flat' : (voxel.palette[symbol] as { pattern?: string }).pattern ?? 'flat'} onChange={event => updatePalette(symbol, { pattern: event.target.value })}><option value="flat">纯色</option><option value="noise">噪点</option><option value="checker">棋盘</option></select>
                  <button className="palette-remove" title={`删除 ${symbol}`} disabled={busy} onClick={() => removeSymbol(symbol)}>×</button>
                </div>)}</div>
                <button disabled={busy || symbols.length >= 26} onClick={addSymbol}>添加符号</button>
              </div>
              <div className="model-panel">
                <h3>基本设置</h3>
                <label>显示名称<input disabled={busy} value={draft.displayName} onChange={event => change({ ...draft, displayName: event.target.value })} /></label>
                <label>内容 ID<input disabled={busy || !!document} value={draft.id} onChange={event => change({ ...draft, id: event.target.value, texture: `${draft.texture.split(':')[0]}:${draft.kind === 'block' ? 'block' : 'item'}/${event.target.value.split(':')[1]}_atlas` })} /></label>
                <div className="row">
                  <label>X<input type="number" min={1} max={32} disabled={busy || !!document} value={size[0]} onChange={event => resize([Math.max(1, Math.min(32, Number(event.target.value) || 1)), size[1], size[2]])} /></label>
                  <label>Y<input type="number" min={1} max={32} disabled={busy || !!document} value={size[1]} onChange={event => resize([size[0], Math.max(1, Math.min(32, Number(event.target.value) || 1)), size[2]])} /></label>
                  <label>Z<input type="number" min={1} max={32} disabled={busy || !!document} value={size[2]} onChange={event => resize([size[0], size[1], Math.max(1, Math.min(32, Number(event.target.value) || 1))])} /></label>
                </div>
                <label>纹理模式<select disabled={busy} value={voxel.texture.mode} onChange={event => change({ ...draft, voxel: { ...voxel, texture: { ...voxel.texture, mode: event.target.value as 'shaded' | 'material' } } })}><option value="shaded">受光（顶/侧/底）</option><option value="material">单材质</option></select></label>
                <p className="muted">纹理图集由插件生成：{atlasPath(draft)}</p>
              </div>
              <div className="model-panel">
                <h3>二次优化</h3>
                <label className="inline-check"><input type="checkbox" checked={voxel.optimize.merge} onChange={event => change({ ...draft, voxel: { ...voxel, optimize: { ...voxel.optimize, merge: event.target.checked } } })} />贪心合并 cuboid（贴图会被拉伸）</label>
                <label>调色板量化到 N 色<input type="number" min={0} max={8} disabled={busy} value={voxel.optimize.quantize} onChange={event => change({ ...draft, voxel: { ...voxel, optimize: { ...voxel.optimize, quantize: Math.max(0, Math.min(8, Number(event.target.value) || 0)) } } })} /></label>
                <label>降采样<select disabled={busy} value={voxel.optimize.downscale} onChange={event => change({ ...draft, voxel: { ...voxel, optimize: { ...voxel.optimize, downscale: Number(event.target.value) as 1 | 2 } } })}><option value={1}>不降采样</option><option value={2}>2×2×2</option></select></label>
                <label className="inline-check"><input type="checkbox" checked={voxel.optimize.removeFloating} onChange={event => change({ ...draft, voxel: { ...voxel, optimize: { ...voxel.optimize, removeFloating: event.target.checked } } })} />移除悬浮体素</label>
                <label>cuboid 上限<input type="number" min={1} max={4000} disabled={busy} value={voxel.optimize.maxCuboids} onChange={event => change({ ...draft, voxel: { ...voxel, optimize: { ...voxel.optimize, maxCuboids: Math.max(1, Math.min(4000, Number(event.target.value) || 1500)) } } })} /></label>
                {stats && <p className="muted">体素 {stats.solid} · 外露面 {stats.exposedFaces} · 预计 cuboid {stats.cuboids}</p>}
              </div>
            </div>
            {validation && !validation.success && <p className="error" role="alert">{validation.error.issues.map(issue => issue.message).join('；')}</p>}
            <div className="row content-save">
              <button disabled={busy || !validation?.success} onClick={() => void run(async () => { setPreview(await request({ action: 'preview', value: voxelForSave(), expectedRevision: document?.revision ?? null })); setMessage('已生成待应用变更，确认文件后应用。') })}>预览变更</button>
              <button className="primary" disabled={busy || !preview || !validation?.success} onClick={() => void run(async () => {
                const saved = (await request({ action: 'save', value: voxelForSave(), expectedRevision: document?.revision ?? null, previewRevision: preview!.previewRevision! })).document!
                setDocument(saved); setDraft(saved.value); setDirty(false); setPreview(undefined); undoRef.current = []; redoRef.current = []; setHistoryVersion(version => version + 1); await refresh(); persist({ document: saved, draft: saved.value, dirty: false }); setMessage('模型已写入并读回。重新构建并启动游戏后即可看到外观。')
              })}>应用到工程</button>
              {document && <button disabled={busy} onClick={() => void run(() => load(document))}>重新加载</button>}
            </div>
            {preview && <div className="content-diff"><h3>将应用到 {draft.id}</h3>{preview.files?.filter(file => file.before !== file.after).map(file => <details key={file.path}><summary>{file.before === null ? '新建' : '更新'} · {file.path}</summary>{file.binary ? <div className="binary-diff"><img src={`data:image/png;base64,${file.after}`} alt={`${file.path} 预览`} /><p className="muted">二进制 PNG · {file.size} 字节</p></div> : <div className="columns"><div><h4>当前文件</h4><pre>{file.before ?? '尚不存在，不覆盖其他文件'}</pre></div><div><h4>待应用内容</h4><pre>{file.after}</pre></div></div>}</details>)}</div>}
          </>}
        </div>
      </>}
      {error && <p role="alert" className="message error">{error}</p>}{message && <p role="status" className="connected">{message}</p>}
    </div>
  </section>
}
