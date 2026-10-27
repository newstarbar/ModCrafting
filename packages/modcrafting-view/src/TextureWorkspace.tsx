import { useEffect, useState } from 'react'
import { action } from './client.ts'
import { TexturePainter } from './TexturePainter.tsx'

type TextureInfo = { id: string; path: string; width: number; height: number; revision: string }
type TextureDocument = TextureInfo & { image: string }
type Reply = { ok: true; textures?: TextureInfo[]; document?: TextureDocument }

function blank(width: number, height: number) {
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height
  return canvas.toDataURL('image/png')
}

export function TextureWorkspace({ projectPath, modId }: { projectPath: string; modId: string }) {
  const [textures, setTextures] = useState<TextureInfo[]>([])
  const [selected, setSelected] = useState('')
  const [image, setImage] = useState<string>(), [texturePng, setTexturePng] = useState<string>()
  const [revision, setRevision] = useState<string | null>(null), [width, setWidth] = useState(32), [height, setHeight] = useState(32)
  const [name, setName] = useState('new_icon'), [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('')
  async function call<T extends Reply>(request: Record<string, unknown>) { return action<T>({ operation: 'gui-texture', request: { projectPath, ...request } } as never) }
  async function refresh() { setBusy(true); setError(''); try { const value = await call<Reply>({ action: 'list' }); setTextures(value.textures || []) } catch (cause) { setError(String(cause)) } finally { setBusy(false) } }
  useEffect(() => { setSelected(''); setImage(undefined); setTexturePng(undefined); setRevision(null); void refresh() }, [projectPath])
  async function open(id: string) {
    setBusy(true); setError(''); setMessage('')
    try { const value = await call<{ ok: true; document: TextureDocument }>({ action: 'read', id }); setSelected(id); setImage(value.document.image); setTexturePng(undefined); setRevision(value.document.revision); setWidth(value.document.width); setHeight(value.document.height); setName(id.split('/').at(-1) || '') }
    catch (cause) { setError(String(cause)) } finally { setBusy(false) }
  }
  function create() {
    const safe = name.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^[^a-z]/, 'i_')
    if (!safe) { setError('纹理名称必须包含小写英文、数字或下划线'); return }
    const w = Math.max(16, Math.min(512, Math.floor(width))), h = Math.max(16, Math.min(512, Math.floor(height)))
    const id = `${modId}:gui/${safe}`
    if (textures.some(item => item.id === id)) { setError('同名纹理已存在，请从左侧打开或换一个名称'); return }
    setSelected(id); setImage(undefined); setTexturePng(blank(w, h)); setRevision(null); setWidth(w); setHeight(h); setName(safe); setError(''); setMessage('已创建空白纹理；绘制后保存到工程。')
  }
  async function save() {
    if (!selected) { setError('先选择或创建一个纹理'); return }
    if (!texturePng) { setError('画布还没有可保存的纹理'); return }
    setBusy(true); setError(''); setMessage('')
    try {
      const value = await call<{ ok: true; document: TextureDocument }>({ action: 'save', id: selected, texturePng, expectedRevision: revision })
      setImage(value.document.image); setTexturePng(undefined); setRevision(value.document.revision); setWidth(value.document.width); setHeight(value.document.height); setMessage(`已保存 ${value.document.path}；可在界面图片元素中使用 ${value.document.id}`); await refresh()
    } catch (cause) { setError(String(cause)) } finally { setBusy(false) }
  }
  const shown = texturePng || image
  return <section className="panel gui-texture-workspace" aria-label="通用纹理工作区">
    <div className="row"><div className="grow"><p className="eyebrow">ASSET / PIXEL TEXTURE</p><h2>纹理画布</h2><p className="muted">绘制 HUD 血条、Buff 图标、界面图片或其他附加纹理。保存到 assets/&lt;模组&gt;/textures/gui，随后在界面的“图片”元素中引用。</p></div><span className="badge badge-INCONCLUSIVE">{selected || '未选择'}</span></div>
    <div className="gui-texture-layout">
      <aside className="gui-texture-list"><div className="row"><strong>GUI 纹理 · {textures.length}</strong><button disabled={busy} onClick={() => void refresh()}>刷新</button></div>
        {textures.map(item => <button key={item.id} className={selected === item.id ? 'selected' : ''} disabled={busy} onClick={() => void open(item.id)}><strong>{item.id.split('/').at(-1)}</strong><small>{item.id}</small><small>{item.width}×{item.height}</small></button>)}
        {!textures.length && <p className="muted">还没有 GUI 纹理。</p>}
        <div className="texture-create"><label>名称<input aria-label="新纹理名称" value={name} onChange={event => setName(event.target.value)} /></label><div className="texture-size"><label>宽<input aria-label="新纹理宽度" type="number" min={16} max={512} value={width} onChange={event => setWidth(Number(event.target.value) || 32)} /></label><label>高<input aria-label="新纹理高度" type="number" min={16} max={512} value={height} onChange={event => setHeight(Number(event.target.value) || 32)} /></label></div><button disabled={busy} onClick={create}>新建空白纹理</button></div>
      </aside>
      <div className="gui-texture-body">
        {shown !== undefined ? <TexturePainter key={`${selected}:${revision ?? 'new'}:${width}x${height}`} image={shown} defaultSize={width} defaultHeight={height} disabled={busy || !selected} label={selected ? selected.split('/').at(-1)! : 'GUI 纹理'} onChange={setTexturePng} /> : <div className="panel"><h3>选择或创建纹理</h3><p className="muted">纹理会作为 PNG 保存到工程；不会自动生成 Java 代码。血条/Buff 的外观可先用这里绘制，再到“界面”工作区添加图片元素。</p></div>}
        <div className="row gui-texture-save"><button className="primary" disabled={busy || !selected || !texturePng} onClick={() => void save()}>保存纹理到工程</button>{selected && <span className="muted">{selected} → assets/{modId}/textures/gui/{selected.split('/').at(-1)}.png</span>}</div>
        {error && <p className="error" role="alert">{error}</p>}{message && <p className="connected" role="status">{message}</p>}
      </div>
    </div>
  </section>
}
