import { useEffect, useState } from 'react'
import { action, currentSession } from './client.ts'
import { useVisuals } from './visuals.tsx'
import { EntityAppearanceEditor } from './EntityAppearanceEditor.tsx'
import { TexturePainter } from './TexturePainter.tsx'
import { baseTextureSize } from '../../modcrafting-core/src/entity-appearance.ts'
import { contentForms, contentKinds, contentObjectSchema, newContentObject, type ContentKind, type ContentObject, type ContentDocument, type ContentFile } from '../../modcrafting-core/src/content-model.ts'
import type { ContentRequest } from '../../modcrafting-core/src/content-workspace.ts'

type Request = ContentRequest extends infer T ? T extends { projectPath: string } ? Omit<T, 'projectPath'> : never : never
type Reply = { document?: ContentDocument; documents?: ContentDocument[]; files?: ContentFile[]; previewRevision?: string; image?: string; texture?: { path: string; base64: string; sha256: string; width: number; height: number } }
export function ContentEditor({ projectPath, modId }: { projectPath: string; modId: string }) {
  const storageKey = `modcrafting-draft:${currentSession()}:content:${projectPath}`
  const [restored] = useState(() => { try { return JSON.parse(sessionStorage.getItem(storageKey) || 'null') as { document?: ContentDocument; draft?: ContentObject } | null } catch { return null } })
  const [documents, setDocuments] = useState<ContentDocument[]>([]), [document, setDocument] = useState<ContentDocument | undefined>(restored?.document)
  const [draft, setDraft] = useState<ContentObject>(() => restored?.draft || newContentObject('item', modId))
  const [dirty, setDirty] = useState(Boolean(restored?.draft)), [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('')
  const [preview, setPreview] = useState<Reply>(), [query, setQuery] = useState(''), [texturePng, setTexturePng] = useState<string>()
  const request = (value: Request) => action<Reply>({ operation: 'content', request: { ...value, projectPath } as ContentRequest })
  async function run(work: () => Promise<void>) { setBusy(true); setError(''); try { await work() } catch (cause) { setError(String(cause)) } finally { setBusy(false) } }
  const refresh = async () => setDocuments((await request({ action: 'list' })).documents || [])
  useEffect(() => {
    let active = true
    void run(async () => {
      const rows = (await request({ action: 'list' })).documents || []
      if (!active) return
      setDocuments(rows)
      if (restored?.document) {
        const latest = rows.find(value => value.id === restored.document!.id)
        if (!latest || latest.revision !== restored.document.revision) {
          setDocument(undefined); setDirty(false); sessionStorage.removeItem(storageKey)
          setError('草稿没有恢复：工程文件已在其他位置改变。请重新读取工程后再编辑。')
        } else setDocument(restored.document)
      }
    })
    return () => { active = false }
  }, [projectPath])
  useEffect(() => { if (dirty) sessionStorage.setItem(storageKey, JSON.stringify({ draft, document })); else sessionStorage.removeItem(storageKey) }, [dirty, draft, document, storageKey])
  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])
  function change(next: ContentObject, png?: string) { setDraft(next); if (png !== undefined) setTexturePng(png || undefined); setDirty(true); setPreview(undefined); setMessage('') }
  function fresh(kind: ContentKind) {
    if (dirty && !window.confirm('放弃尚未应用的参数草稿？')) return
    setDocument(undefined); setDraft(newContentObject(kind, modId)); setDirty(false); setPreview(undefined); setTexturePng(undefined); setError(''); setMessage('')
  }
  async function load(selected: ContentDocument) {
    if (dirty && !window.confirm('放弃当前草稿，重新读取工程参数？')) return
    const value = selected.value ? (await request({ action: 'read', id: selected.id })).document! : selected
    setDocument(value); if (value.value) setDraft(value.value); setDirty(false); setPreview(undefined); setTexturePng(undefined); setMessage('已读取工程；仅编辑支持的声明式对象')
  }
  const form = contentForms[draft.kind], readonly = !!document && !document.editable, validation = contentObjectSchema.safeParse(draft)
  const issues = validation.success ? [] : validation.error.issues
  const [imageFailed, setImageFailed] = useState(false)
  const visuals = useVisuals(projectPath, [], [draft.texture])
  const savedImage = visuals.textures?.[draft.texture] || preview?.image || (document?.value?.texture === draft.texture ? document.image : undefined)
  const image = texturePng || savedImage
  useEffect(() => setImageFailed(false), [image])
  const showImage = image && !imageFailed
  const items = documents.filter(doc => `${doc.id} ${doc.value?.displayName || ''}`.toLowerCase().includes(query.toLowerCase()))
  return <section className="panel content-workspace" aria-label="内容参数工作区">
    <div className="row"><div className="grow"><p className="eyebrow">CONTENT / FABRIC 1.21.4</p><h2>内容创作</h2><p className="muted">调整实际属性，确认代码和资源变更，再应用到工程。</p></div><span className={`badge badge-${dirty ? 'INCONCLUSIVE' : 'PASS'}`}>{dirty ? '未应用草稿' : document ? '已读回工程' : '新对象'}</span></div>
    <div className="content-layout">
      <aside className="content-list"><div className="row"><strong>工程内容 · {documents.length}</strong><button disabled={busy} onClick={() => void run(refresh)}>刷新目录</button></div><input aria-label="搜索工程内容" placeholder="名称或 ID" value={query} onChange={event => setQuery(event.target.value)} />
        {items.map(doc => <button key={doc.id} data-content-id={doc.id} className={document?.id === doc.id ? 'selected' : ''} disabled={busy} onClick={() => void run(() => load(doc))}><strong>{doc.value?.displayName || doc.id}</strong><small>{doc.id}</small><small>{doc.kind ? contentForms[doc.kind].title : '已有内容'} · {doc.editable ? '参数可编辑' : '交给 Agent 检查'}</small></button>)}
        {!items.length && <p className="muted">选择一种内容开始创建。已有手写代码保持原样。</p>}
      </aside>
      <div className="content-body"><div className="content-types" aria-label="新建内容类型">{contentKinds.map(kind => <button key={kind} disabled={busy} aria-pressed={draft.kind === kind} onClick={() => fresh(kind)}><span aria-hidden>{contentForms[kind].icon}</span> 新建{contentForms[kind].title}</button>)}</div>
        {readonly ? <div className="message"><h3>{document.id}</h3><p>{document.reason}</p><p>没有加载默认参数或覆盖源码。请让 Agent 检查以下文件：</p><pre>{document.files.join('\n')}</pre>{document.value && <pre>{JSON.stringify(document.value, null, 2)}</pre>}</div> : <>
          <div className="content-heading"><div className="content-appearance" aria-label="关联外观预览">{showImage ? <img src={image} onError={() => setImageFailed(true)} alt={draft.kind === 'entity' ? '生物纹理展开图' : '关联纹理'} /> : <span aria-hidden>{form.icon}</span>}<small>{showImage ? draft.kind === 'entity' ? '纹理展开图' : '关联纹理' : '类型示意'}</small></div><div className="grow"><h3>{draft.displayName || '新' + form.title}</h3><code>{draft.id}</code><p className="muted">{form.hint}</p></div></div>
          <div className="content-fields"><label>显示名称<input aria-label="内容显示名称" maxLength={80} disabled={busy} value={draft.displayName} onChange={event => change({ ...draft, displayName: event.target.value })} /></label><label>内容 ID<input aria-label="内容 ID" disabled={busy || !!document} value={draft.id} onChange={event => change({ ...draft, id: event.target.value })} /></label>
            {form.fields.filter(field => !(draft.kind === 'tool' && draft.parameters.toolType === 'sword' && field.key === 'miningSpeed')).map(field => <label key={field.key}>{field.label}{field.unit && <small className="muted"> · {field.unit} {field.min !== undefined && `(${field.min}～${field.max})`}</small>}
              {field.type === 'select' ? <select aria-label={field.label} disabled={busy} value={String(draft.parameters[field.key])} onChange={event => {
                let next = { ...draft, parameters: { ...draft.parameters, [field.key]: event.target.value } }
                if (field.key === 'baseEntity' && ['minecraft:entity/pig/pig', 'minecraft:entity/zombie/zombie'].includes(next.texture)) next.texture = `minecraft:entity/${event.target.value}/${event.target.value}`
                if (field.key === 'baseEntity' && next.appearance?.mode === 'base') next = { ...next, appearance: { ...next.appearance, textureSize: baseTextureSize(event.target.value), boxes: [] } }
                change(next)
              }}>{field.options?.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select> : field.type === 'checkbox' ? <input type="checkbox" aria-label={field.label} disabled={busy} checked={Boolean(draft.parameters[field.key])} onChange={event => change({ ...draft, parameters: { ...draft.parameters, [field.key]: event.target.checked } })} /> : <input type="number" aria-label={field.label} disabled={busy} min={field.min} max={field.max} step={field.step ?? 1} value={Number.isNaN(draft.parameters[field.key]) ? '' : Number(draft.parameters[field.key])} onChange={event => change({ ...draft, parameters: { ...draft.parameters, [field.key]: event.target.value === '' ? NaN : Number(event.target.value) } })} />}
              {issues.filter(issue => issue.path[1] === field.key).map(issue => <span className="error" key={issue.message}>{issue.message}</span>)}
            </label>)}
          </div>
          {draft.kind === 'entity' && <EntityAppearanceEditor key={`${draft.id}:${document?.revision ?? 'new'}`} draft={draft} modId={modId} image={texturePng || savedImage} texturePreview={texturePng} busy={busy} onChange={change} />}
          {draft.kind !== 'entity' && <TexturePainter key={`${draft.id}:${document?.revision ?? 'new'}`} image={texturePng || savedImage} disabled={busy} label={contentForms[draft.kind].title} onChange={png => change({ ...draft, texture: `${modId}:${draft.kind === 'block' ? 'block' : 'item'}/${draft.id.split(':')[1] || 'new'}` }, png)} />}
          {draft.kind === 'tool' && draft.parameters.toolType === 'sword' && <p className="muted">剑使用原版剑的挖掘规则，不应用采集工具的挖掘速度参数。</p>}
          <p className="muted" role="status">{visuals.loading ? '正在读取本地素材…' : visuals.ready ? showImage ? '已读取关联贴图' : '此资源没有可用贴图，请核对纹理路径或工程 PNG。' : visuals.message}<button disabled={visuals.loading} onClick={visuals.retry}>重新读取贴图</button></p>
          {draft.voxel ? <p className="muted">此对象使用 3D 体素模型，纹理图集由插件自动生成（{draft.texture}）。请到“模型”页编辑外观，本页只调参数。</p> : <>
            <label>关联纹理<input aria-label="关联纹理" disabled={busy} value={draft.texture} onChange={event => change({ ...draft, texture: event.target.value })} /></label><p className="muted">{draft.texture} → {`assets/${draft.texture.replace(':', '/textures/')}.png`}。原版资源由游戏提供；自定义 PNG 须已放入工程，应用后可读回实际纹理。生物纹理沿用所选基型布局。</p>
          </>}
          {issues.length > 0 && <p className="error" role="alert">{issues.map(issue => issue.message).join('；')}</p>}
          <div className="row content-save"><button disabled={busy || !validation.success} onClick={() => void run(async () => { setPreview(await request({ action: 'preview', value: draft, expectedRevision: document?.revision ?? null, ...(texturePng ? { texturePng } : {}) })); setMessage('已生成待应用变更，确认文件后应用') })}>预览参数变更</button><button className="primary" disabled={busy || !preview || !validation.success} onClick={() => void run(async () => {
            const value = (await request({ action: 'save', value: draft, expectedRevision: document?.revision ?? null, previewRevision: preview!.previewRevision!, ...(texturePng ? { texturePng } : {}) })).document!
            setDocument(value); setDraft(value.value!); setDirty(false); setPreview(undefined); setTexturePng(undefined); await refresh(); setMessage('参数已写入并读回。Agent 可通过 fabric_content_workspace 接续；重新构建/启动游戏后验证实际属性。')
          })}>确认应用到工程</button>{document && <button disabled={busy} onClick={() => void run(() => load(document))}>重新加载参数</button>}</div>
          {preview && <div className="content-diff"><h3>将应用到 {draft.id}</h3>{preview.texture && <p className="muted">纹理 {preview.texture.path} · {preview.texture.width}×{preview.texture.height} · {preview.texture.sha256.slice(0, 12)}…</p>}{preview.files?.filter(file => file.before !== file.after).map(file => <details key={file.path}><summary>{file.before === null ? '新建' : '更新'} · {file.path}</summary>{file.binary ? <div className="binary-diff"><img src={`data:image/png;base64,${file.after}`} alt={file.path} /><p className="muted">二进制 PNG · {file.size} 字节</p></div> : <div className="columns"><div><h4>当前文件</h4><pre>{file.before ?? '尚不存在，不覆盖其他文件'}</pre></div><div><h4>待应用内容</h4><pre>{file.after}</pre></div></div>}</details>)}</div>}
        </>}
        {error && <p role="alert" className="message error">{error}</p>}{message && <p role="status" className="connected">{message}</p>}
      </div>
    </div>
  </section>
}
