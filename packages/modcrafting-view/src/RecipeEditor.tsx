import React, { useEffect, useState } from 'react'
import { action, currentSession } from './client.ts'
import { ItemVisual, useVisuals } from './visuals.tsx'
import { newRecipeDraft, recipeContentFromDraft, recipeDraftFromContent, type RecipeDraft } from '../../modcrafting-core/src/recipe-editor.ts'
import { slotFromRef, applySlot, type SlotRef } from '../../modcrafting-core/src/recipe-grid.ts'
import { validateRecipeContent, type RecipeKind } from '../../modcrafting-core/src/recipe-format.ts'
import type { RecipeDocument, RecipeItem, RecipeRequest } from '../../modcrafting-core/src/recipe-workspace.ts'

const kinds: Record<RecipeKind, string> = { shaped: '有序合成', shapeless: '无序合成', smelting: '熔炉', blasting: '高炉', stonecutting: '切石机' }
const mime = 'application/x-modcrafting-recipe-slot'
type Request = RecipeRequest extends infer T ? T extends { projectPath: string } ? Omit<T, 'projectPath'> : never : never
type Reply = { recipes?: RecipeDocument[]; document?: RecipeDocument; items?: RecipeItem[] }
export function RecipeEditor({ projectPath, modId }: { projectPath: string; modId: string }) {
  const storageKey = `modcrafting-draft:${currentSession()}:recipe:${projectPath}`
  const [restored] = useState(() => { try { return JSON.parse(sessionStorage.getItem(storageKey) || 'null') as { document?: RecipeDocument; draft?: RecipeDraft; recipeId?: string; query?: string; target?: SlotRef } | null } catch { return null } })
  const [recipes, setRecipes] = useState<RecipeDocument[]>([]), [items, setItems] = useState<RecipeItem[]>([])
  const [document, setDocument] = useState<RecipeDocument | undefined>(restored?.document), [draft, setDraft] = useState<RecipeDraft>(restored?.draft || newRecipeDraft)
  const [recipeId, setRecipeId] = useState(restored?.recipeId || modId + ':new_recipe'), [query, setQuery] = useState(restored?.query || '')
  const [target, setTarget] = useState<SlotRef>(restored?.target || { kind: 'grid', row: 0, col: 0 }), [message, setMessage] = useState(''), [error, setError] = useState('')
  const [busy, setBusy] = useState(false), [dirty, setDirty] = useState(Boolean(restored?.draft)), [preview, setPreview] = useState(false)
  const request = (value: Request) => action<Reply>({ operation: 'recipe', request: { ...value, projectPath } as RecipeRequest })
  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])
  async function run(work: () => Promise<void>) { setBusy(true); setError(''); try { await work() } catch (cause) { setError(String(cause)) } finally { setBusy(false) } }
  useEffect(() => {
    let active = true
    void Promise.all([request({ action: 'list' }), request({ action: 'catalog' })]).then(([list, catalog]) => { if (active) {
      const rows = list.recipes || []; setRecipes(rows); setItems(catalog.items || [])
      if (restored?.document) {
        const latest = rows.find(value => value.recipeId === restored.document!.recipeId)
        if (!latest || latest.revision !== restored.document.revision) { setDocument(undefined); setDirty(false); sessionStorage.removeItem(storageKey); setError('草稿没有恢复：配方文件已在其他位置改变。请重新读取后再编辑。') }
      }
    } }).catch(cause => { if (active) setError(String(cause)) })
    return () => { active = false }
  }, [projectPath])
  useEffect(() => { if (dirty) sessionStorage.setItem(storageKey, JSON.stringify({ document, draft, recipeId, query, target })); else sessionStorage.removeItem(storageKey) }, [dirty, document, draft, recipeId, query, target, storageKey])
  function change(value: RecipeDraft) { setDraft(value); setDirty(true); setPreview(false); setMessage('') }
  async function load(id: string) {
    if (dirty && !window.confirm('放弃尚未保存的配方草稿，重新读取工程文件？')) return
    const value = (await request({ action: 'read', recipeId: id } as Request)).document!
    setDocument(value); setRecipeId(id); setDraft(value.editable ? recipeDraftFromContent(value.content) : newRecipeDraft()); setDirty(false); setPreview(false); setMessage('已从工程读取最新版本')
  }
  let content = '', issue = ''
  try { content = recipeContentFromDraft(draft, document?.content, document?.minecraft); const validation = validateRecipeContent(content, { mcVersion: document?.minecraft }); if (!validation.valid) issue = validation.errors.join('；') } catch (cause) { issue = String(cause).replace(/^Error: /, '') }
  const readonly = document && !document.editable
  const oneIngredient = !['shaped', 'shapeless'].includes(draft.type)
  const names = new Map(items.map(item => [item.id, item.zhName || item.name]))
  const label = (id: string) => names.get(id) || (id.startsWith('#') ? '标签 ' + id.slice(1) : id.split(':')[1])
  const matches = items.filter(item => `${item.id} ${item.name} ${item.zhName || ''}`.toLowerCase().includes(query.toLowerCase())).slice(0, 60)
  const visuals = useVisuals(projectPath, [...new Set([...matches.map(item => item.id), ...draft.grid.flat().map(cell => cell.itemId), draft.outputItem].filter(id => id && !id.startsWith('#')))])
  function put(id: string) {
    if (target.kind === 'output' && id.startsWith('#')) { setError('产物必须是具体物品，不能使用标签'); return }
    change({ ...draft, ...applySlot(target, { itemId: id, count: 1 }, draft.grid, draft.outputItem, draft.outputCount) })
  }
  function slot(ref: SlotRef) {
    const value = slotFromRef(ref, draft.grid, draft.outputItem, draft.outputCount), selected = JSON.stringify(target) === JSON.stringify(ref)
    const accessible = ref.kind === 'output' ? '产物槽' : `材料槽 ${ref.row + 1}-${ref.col + 1}`
    return <button type="button" className={`recipe-slot ${selected ? 'selected' : ''} ${value.itemId ? 'filled' : ''}`} data-slot={ref.kind === 'output' ? 'output' : `${ref.row}-${ref.col}`} aria-label={`${accessible}${value.itemId ? '：' + value.itemId : '：空'}`} aria-pressed={selected} disabled={busy || !!readonly} title={value.itemId || accessible} draggable={!!value.itemId} onClick={() => setTarget(ref)} onContextMenu={event => { event.preventDefault(); change({ ...draft, ...applySlot(ref, { itemId: '', count: 0 }, draft.grid, draft.outputItem, draft.outputCount) }) }} onDragStart={event => { event.dataTransfer.setData(mime, JSON.stringify(ref)); event.dataTransfer.effectAllowed = 'move' }} onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' }} onDrop={event => {
      event.preventDefault()
      try {
        const from = event.dataTransfer.getData(mime)
        if (from) {
          const source = JSON.parse(from) as SlotRef
          if (source.kind !== 'output' && (source.kind !== 'grid' || !Number.isInteger(source.row) || !Number.isInteger(source.col) || source.row < 0 || source.row > 2 || source.col < 0 || source.col > 2)) return
          const picked = slotFromRef(source, draft.grid, draft.outputItem, draft.outputCount)
          if (ref.kind === 'output' && picked.itemId.startsWith('#') || source.kind === 'output' && value.itemId.startsWith('#')) return
          let next = applySlot(ref, picked, draft.grid, draft.outputItem, draft.outputCount); next = applySlot(source, value, next.grid, next.outputItem, next.outputCount); change({ ...draft, ...next })
        } else {
          const id = event.dataTransfer.getData('text/plain')
          if (!items.some(item => item.id === id)) return
          change({ ...draft, ...applySlot(ref, { itemId: id, count: 1 }, draft.grid, draft.outputItem, draft.outputCount) })
        }
      } catch { /* External drag payloads are not recipe edits. */ }
    }}>{value.itemId ? <><ItemVisual image={visuals.items?.[value.itemId]} label={label(value.itemId)} /><small>{label(value.itemId)}</small>{ref.kind === 'output' && draft.outputCount > 1 && <b>{draft.outputCount}</b>}</> : <span className="recipe-slot-empty">＋</span>}</button>
  }
  return <section className="panel recipe-workspace" aria-label="配方创作工作区">
    <div className="row"><div className="grow"><p className="eyebrow">CRAFT / FABRIC</p><h2>配方工坊</h2><p className="muted">拖放材料，调整产物。确认后的配方可由 Agent 直接读回。</p></div><span className={`badge ${dirty ? 'badge-INCONCLUSIVE' : 'badge-PASS'}`}>{dirty ? '未保存草稿' : document ? '已读回工程' : '新配方'}</span></div>
    <div className="recipe-layout">
      <aside className="recipe-list"><div className="row"><strong>工程配方 · {recipes.length}</strong><button disabled={busy} onClick={() => { if (dirty && !window.confirm('放弃当前未保存草稿？')) return; setDocument(undefined); setDraft(newRecipeDraft()); setRecipeId(modId + ':new_recipe'); setDirty(false); setPreview(false); setError(''); setMessage('') }}>新建配方</button></div>
        {!recipes.length && <p className="muted">还没有配方，从右侧材料开始创建。</p>}
        {recipes.map(recipe => <button key={recipe.recipeId} className={document?.recipeId === recipe.recipeId ? 'selected' : ''} disabled={busy} onClick={() => void run(() => load(recipe.recipeId))}>{recipe.recipeId}<small>{recipe.editable ? '可编辑' : '只读 · 暂不支持'}</small></button>)}
      </aside>
      <div>
        <div className="row"><label className="grow">配方 ID<input aria-label="配方 ID" value={recipeId} disabled={busy || !!document} onChange={event => { setRecipeId(event.target.value); setDirty(true); setPreview(false) }} /></label><label>配方类型<select aria-label="配方类型" disabled={busy || !!readonly} value={draft.type} onChange={event => { const type = event.target.value as RecipeKind; if (!['shaped', 'shapeless'].includes(type) && draft.grid.flat().slice(1).some(cell => cell.itemId) && !window.confirm('此类型只使用左上角材料，其余槽位不会写入。是否切换？')) return; change({ ...draft, type, outputCount: ['smelting', 'blasting'].includes(type) ? 1 : draft.outputCount }) }}>{Object.entries(kinds).map(([key, title]) => <option key={key} value={key}>{title}</option>)}</select></label></div>
        {readonly ? <p className="error">此配方保持只读：{document.errors.join('；')}。原文件不会被默认表单覆盖。</p> : <>
          <div className="recipe-table"><div><span className="recipe-caption">{oneIngredient ? '投入材料' : draft.type === 'shapeless' ? '材料列表 · 顺序不限' : '合成网格 · 3 × 3'}</span><div className={oneIngredient ? 'recipe-single' : 'recipe-grid'}>{(oneIngredient ? [[draft.grid[0][0]]] : draft.grid).map((row, y) => row.map((_, x) => <React.Fragment key={`${y}-${x}`}>{slot({ kind: 'grid', row: y, col: x })}</React.Fragment>))}</div></div><span className="recipe-arrow" aria-hidden>➜</span><div><span className="recipe-caption">合成产物</span>{slot({ kind: 'output' })}<label>产物数量<input type="number" aria-label="产物数量" min={1} max={items.find(item => item.id === draft.outputItem)?.stackSize || 64} value={draft.outputCount} disabled={busy || ['smelting', 'blasting'].includes(draft.type)} onChange={event => change({ ...draft, outputCount: Number(event.target.value) })} /></label></div></div>
          <div className="row"><span className="muted">先选择槽位，再点击物品；也可直接拖入。右键清空，槽位间拖动换位。</span><button disabled={busy} onClick={() => change({ ...draft, grid: newRecipeDraft().grid })}>清空材料</button></div>
          {['smelting', 'blasting'].includes(draft.type) && <div className="row"><label>经验<input type="number" aria-label="经验" min={0} step={0.1} value={draft.experience} onChange={event => change({ ...draft, experience: Number(event.target.value) })} /></label><label>耗时（tick）<input type="number" aria-label="耗时" min={1} value={draft.cookingTime} onChange={event => change({ ...draft, cookingTime: Number(event.target.value) })} /></label></div>}
          <div className="recipe-catalog"><label>查找材料与产物<input aria-label="查找材料与产物" value={query} placeholder="搜索中文名、英文名或 namespace:id" onChange={event => setQuery(event.target.value)} /></label><span className="muted">当前选择：{target.kind === 'output' ? '产物槽' : `材料槽 ${target.row + 1}-${target.col + 1}`} · {items.length} 项（原版知识 / 工程资源）</span><div className="recipe-palette">{matches.map(item => <button key={item.id} disabled={busy} draggable data-item-id={item.id} title={item.id} aria-label={`使用物品 ${item.id}`} onDragStart={event => { event.dataTransfer.setData('text/plain', item.id); event.dataTransfer.effectAllowed = 'copy' }} onClick={() => put(item.id)}><ItemVisual image={visuals.items?.[item.id]} label={item.zhName || item.name} /><span>{item.zhName || item.name}<small>{item.id}</small></span></button>)}</div>
            <p className="muted" role="status">{visuals.loading ? '正在读取本地素材…' : visuals.ready ? '贴图来自本地客户端 / 工程资源；方块展示纹理面，动态渲染或标签材料使用文字标识。' : visuals.message}<button disabled={visuals.loading} onClick={visuals.retry}>重新读取贴图</button></p>
            {!matches.length && <p className="muted">没有匹配物品。工程物品需提供 items 或 models/item 资源。</p>}
            {target.kind !== 'output' && <div className="row"><button disabled={busy || !/^#[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(query)} onClick={() => put(query)}>使用 #标签材料</button><small>可输入 #minecraft:planks；标签成员由游戏确认。</small></div>}
          </div>
        </>}
        {error && <p role="alert" className="message error">{error}</p>}{message && <p role="status" className="connected">{message}</p>}
        {!readonly && <div className="row recipe-save"><button disabled={busy || !!issue || !draft.outputItem || !Number.isInteger(draft.outputCount) || draft.outputCount < 1} onClick={() => { setError(''); setPreview(true) }}>预览保存变更</button><button className="primary" disabled={busy || !preview || !!issue} onClick={() => void run(async () => {
          const saved = (await request({ action: 'save', recipeId, expectedRevision: document?.revision ?? null, content } as Request)).document!
          setDocument(saved); setDraft(recipeDraftFromContent(saved.content)); setRecipes((await request({ action: 'list' })).recipes || []); setDirty(false); setPreview(false); setMessage('已保存并读回工程。Agent 可通过 fabric_recipe_workspace 读取同一配方；构建或重新启动游戏后生效。')
        })}>{busy ? '处理中…' : '确认保存配方'}</button>{document && <button disabled={busy} onClick={() => void run(() => load(document.recipeId))}>重新加载工程版本</button>}{issue && <span className="muted">{issue}</span>}</div>}
        {(preview || readonly) && <div className="recipe-diff"><h3>{readonly ? '原始配方（只读）' : '确认写入 · ' + (document?.file || '保存后按工程目标版本确定路径')}</h3><div className="columns"><div><h4>工程中的原版本</h4><pre>{document?.content || '新建文件，不覆盖已有配方'}</pre></div>{!readonly && <div><h4>待写入版本</h4><pre data-testid="recipe-preview">{content}</pre></div>}</div></div>}
      </div>
    </div>
  </section>
}
