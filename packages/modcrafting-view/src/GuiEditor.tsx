import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { action, currentSession } from './client.ts'
import { useVisuals, ItemVisual } from './visuals.tsx'
import { guiLayoutSchema, newGuiLayout, newGuiElement, guiTypes, guiTypeLabels, guiOrigin, moveGuiElement, resizeGuiElement, type GuiLayout, type GuiElement, type GuiDocument, type GuiFile } from '../../modcrafting-core/src/gui-model.ts'
import type { GuiRequest } from '../../modcrafting-core/src/gui-workspace.ts'

type Request = GuiRequest extends infer T ? T extends { projectPath: string } ? Omit<T, 'projectPath'> : never : never
type Reply = { documents?: GuiDocument[]; document?: GuiDocument; files?: GuiFile[]; previewRevision?: string; configName?: string }
const layouts = { 'custom-screen': '自定义 Screen', 'option-list': '配置界面', 'hud-overlay': 'HUD 叠层' }
export function GuiEditor({ projectPath, modId }: { projectPath: string; modId: string }) {
  const storageKey = `modcrafting-draft:${currentSession()}:gui:${projectPath}`
  const [restored] = useState(() => { try { return JSON.parse(sessionStorage.getItem(storageKey) || 'null') as { document?: GuiDocument; draft?: GuiLayout; selectedId?: string; values?: Record<string, number | boolean>; simulate?: boolean; grid?: boolean; resolution?: string; guiScale?: number } | null } catch { return null } })
  const [documents, setDocuments] = useState<GuiDocument[]>([]), [document, setDocument] = useState<GuiDocument | undefined>(restored?.document)
  const [draft, setDraft] = useState<GuiLayout>(() => restored?.draft || newGuiLayout(modId)), [selectedId, select] = useState(restored?.selectedId || '')
  const [dirty, setDirty] = useState(Boolean(restored?.draft)), [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState(''), [plan, setPlan] = useState<Reply>()
  const [simulate, setSimulate] = useState(restored?.simulate || false), [values, setValues] = useState<Record<string, number | boolean>>(restored?.values || {}), [grid, setGrid] = useState(restored?.grid ?? true)
  const [resolution, setResolution] = useState(restored?.resolution || '1280x720'), [guiScale, setGuiScale] = useState(restored?.guiScale || 3), [available, setAvailable] = useState(600)
  const [guides, setGuides] = useState<{ guideX?: number; guideY?: number }>({})
  const frame = useRef<HTMLDivElement>(null), drag = useRef<{ id: string; x: number; y: number; element: GuiElement; resize: boolean } | undefined>(undefined)
  const request = (value: Request) => action<Reply>({ operation: 'gui', request: { ...value, projectPath } as GuiRequest })
  const refresh = async () => setDocuments((await request({ action: 'list' })).documents || [])
  async function run(work: () => Promise<void>) { setBusy(true); setError(''); try { await work() } catch (cause) { setError(String(cause)) } finally { setBusy(false) } }
  useEffect(() => {
    let active = true
    void run(async () => {
      const rows = (await request({ action: 'list' })).documents || []
      if (!active) return
      setDocuments(rows)
      if (restored?.document) {
        const latest = rows.find(value => value.id === restored.document!.id)
        if (!latest || latest.revision !== restored.document.revision) { setDocument(undefined); setDirty(false); sessionStorage.removeItem(storageKey); setError('草稿没有恢复：界面文件已在其他位置改变。请重新读取后再编辑。') }
      }
    })
    return () => { active = false }
  }, [projectPath])
  useEffect(() => { if (dirty) sessionStorage.setItem(storageKey, JSON.stringify({ document, draft, selectedId, values, simulate, grid, resolution, guiScale })); else sessionStorage.removeItem(storageKey) }, [dirty, document, draft, selectedId, values, simulate, grid, resolution, guiScale, storageKey])
  useEffect(() => { if (!frame.current) return; const observer = new ResizeObserver(entries => setAvailable(entries[0].contentRect.width)); observer.observe(frame.current); return () => observer.disconnect() }, [])
  useEffect(() => { if (!dirty) return; const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn) }, [dirty])
  const selected = draft.elements.find(element => element.id === selectedId), readonly = !!document && !document.editable
  const validation = guiLayoutSchema.safeParse(draft), issues = validation.success ? [] : validation.error.issues
  const visuals = useVisuals(projectPath, [...new Set(draft.elements.filter(element => element.type === 'slot').map(element => element.itemId))], [...new Set(draft.elements.filter(element => element.type === 'image' && element.texture).map(element => element.texture!))])
  const [windowWidth, windowHeight] = resolution.split('x').map(Number), actualScale = Math.max(1, Math.min(guiScale, Math.floor(windowWidth / 320), Math.floor(windowHeight / 240)))
  const viewport = simulate ? { width: Math.ceil(windowWidth / actualScale), height: Math.ceil(windowHeight / actualScale) } : { width: draft.width, height: draft.height }
  const scale = Math.max(0.15, Math.min(2, available / viewport.width, 480 / viewport.height)), origin = simulate ? guiOrigin(draft, viewport.width, viewport.height) : { x: 0, y: 0 }
  function change(value: GuiLayout) { setDraft(value); setDirty(true); setPlan(undefined); setMessage('') }
  function patch(element: GuiElement, changes: Partial<GuiElement>) { change({ ...draft, elements: draft.elements.map(item => item.id === element.id ? { ...item, ...changes } : item) }); if (changes.id) select(changes.id) }
  async function load(value: GuiDocument) {
    if (dirty && !window.confirm('放弃尚未应用的界面草稿，重新读取工程？')) return
    const next = (await request({ action: 'read', id: value.id })).document!
    setDocument(next); if (next.value) setDraft(next.value); setDirty(false); setPlan(undefined); select(''); setValues({}); setSimulate(false); setMessage('已读回工程；修改后需重新构建/启动游戏')
  }
  function fresh() {
    if (dirty && !window.confirm('放弃尚未应用的界面草稿？')) return
    setDocument(undefined); setDraft(newGuiLayout(modId)); setDirty(false); select(''); setPlan(undefined); setSimulate(false); setError(''); setMessage(''); setValues({})
  }
  function add(type: GuiElement['type']) {
    let index = 1; while (draft.elements.some(element => element.id === `${type}_${index}`)) index++
    const element = newGuiElement(type, `${type}_${index}`)
    element.x = Math.min(24 + (draft.elements.length % 4) * 8, draft.width - element.width); element.y = Math.min(24 + (draft.elements.length % 6) * 24, draft.height - element.height)
    change({ ...draft, elements: [...draft.elements, element] }); select(element.id)
  }
  const currentValue = (element: GuiElement) => values[element.id] ?? (element.type === 'toggle' ? element.checked : element.initial)
  function text(element: GuiElement) {
    if (element.type === 'slider' || element.type === 'toggle') return `${element.label}: ${element.type === 'toggle' ? currentValue(element) ? 'ON' : 'OFF' : currentValue(element)}`
    if (!element.bind) return element.label
    const target = draft.elements.find(item => item.id === element.bind)
    return element.label + ': ' + (target ? target.type === 'toggle' ? currentValue(target) ? 'ON' : 'OFF' : currentValue(target) : 20)
  }
  function interact(element: GuiElement) {
    if (!simulate) { select(element.id); return }
    if (element.type === 'toggle') setValues(previous => ({ ...previous, [element.id]: !(previous[element.id] ?? element.checked) }))
    if (element.type === 'button') {
      if (element.action === 'close') { setMessage('网页模拟：游戏中此按钮关闭 Screen；当前只结束试用'); setSimulate(false) }
      if (element.action === 'reset') setValues({})
      const target = draft.elements.find(item => item.id === element.target)
      if (element.action === 'increment' && target) setValues(previous => ({ ...previous, [target.id]: Math.min(target.max, Number(previous[target.id] ?? target.initial) + 1) }))
    }
  }
  function begin(event: PointerEvent<HTMLElement>, element: GuiElement, resize = false) {
    if (simulate || readonly || busy || event.button !== 0) return
    event.preventDefault(); event.stopPropagation(); select(element.id)
    drag.current = { id: element.id, x: event.clientX, y: event.clientY, element, resize }; event.currentTarget.setPointerCapture(event.pointerId)
  }
  function move(event: PointerEvent<HTMLElement>) {
    const active = drag.current; if (!active) return
    const dx = (event.clientX - active.x) / scale, dy = (event.clientY - active.y) / scale
    if (active.resize) patch(active.element, resizeGuiElement(draft, active.element, active.element.width + dx, active.element.height + dy, grid))
    else { const next = moveGuiElement(draft, active.element, active.element.x + dx, active.element.y + dy, grid); patch(active.element, next.element); setGuides(next) }
  }
  const end = () => { drag.current = undefined; setGuides({}) }
  const numeric = (key: 'x' | 'y' | 'width' | 'height' | 'min' | 'max' | 'initial', title: string) => selected && <label key={key}>{title}<input type="number" aria-label={`界面元素${title}`} value={selected[key]} disabled={busy || readonly} onChange={event => patch(selected, { [key]: Number(event.target.value) })} /></label>
  return <section className="panel gui-workspace" aria-label="MC 界面创作工作区">
    <div className="row"><div className="grow"><p className="eyebrow">SCREEN / CONFIG / HUD</p><h2>MC 界面创作</h2><p className="muted">摆放组件、试用交互，确认布局和生成文件，再到游戏验证。</p></div><span className={`badge badge-${dirty ? 'INCONCLUSIVE' : 'PASS'}`}>{dirty ? '未应用布局' : document ? '已读回工程' : '新界面'}</span></div>
    <div className="gui-layout"><aside className="gui-directory"><div className="row"><strong>工程界面</strong><button disabled={busy} onClick={fresh}>新建界面</button><button disabled={busy} onClick={() => void run(refresh)}>刷新界面目录</button></div>
      {documents.map(value => <button key={value.id} data-gui-id={value.id} className={document?.id === value.id ? 'selected' : ''} disabled={busy} onClick={() => void run(() => load(value))}>{value.value?.title || value.id}<small>{value.id}</small><small>{value.editable ? '可编辑' : '交由 Agent 合并'}</small></button>)}
      <p className="muted">手写或第三方 Screen/HUD 不自动反向编辑，交由 Agent 检查；不会用默认布局覆盖。</p>
    </aside><div className="gui-body">
      {readonly ? <div className="message"><p>{document.reason}</p><pre>{document.files.join('\n')}</pre></div> : <>
      <div className="gui-settings"><label>界面 ID<input aria-label="界面 ID" value={draft.id} disabled={busy || !!document} onChange={event => change({ ...draft, id: event.target.value })} /></label><label>标题<input aria-label="界面标题" value={draft.title} disabled={busy} onChange={event => change({ ...draft, title: event.target.value })} /></label>
        <label>布局类型<select aria-label="界面布局类型" value={draft.layoutType} disabled={busy} onChange={event => change({ ...draft, layoutType: event.target.value as GuiLayout['layoutType'] })}>{Object.entries(layouts).map(([key, title]) => <option value={key} key={key}>{title}</option>)}</select></label>
        <label>布局锚点<select aria-label="界面锚点" value={draft.anchor} disabled={busy} onChange={event => change({ ...draft, anchor: event.target.value as GuiLayout['anchor'] })}>{[['center', '居中'], ['top-left', '左上'], ['top-right', '右上'], ['bottom-left', '左下'], ['bottom-right', '右下']].map(([key, title]) => <option value={key} key={key}>{title}</option>)}</select></label>
        <label>设计宽（GUI 像素）<input type="number" aria-label="界面设计宽" min={160} max={640} value={draft.width} onChange={event => change({ ...draft, width: Number(event.target.value) })} /></label><label>设计高（GUI 像素）<input type="number" aria-label="界面设计高" min={120} max={480} value={draft.height} onChange={event => change({ ...draft, height: Number(event.target.value) })} /></label>
        <label>默认快捷键<select aria-label="界面快捷键" value={draft.keyCode} onChange={event => change({ ...draft, keyCode: Number(event.target.value) })}>{Array.from({ length: 26 }, (_, index) => <option key={index} value={65 + index}>{String.fromCharCode(65 + index)}</option>)}</select></label>
      </div>
      <p className="muted">快捷键在游戏“控制”中可改键；Screen 用于打开（Esc 或关闭按钮返回），HUD 用于显示/隐藏。交互控件的样式沿用原版皮肤。</p>
      <div className="row gui-toolbar"><button aria-pressed={!simulate} onClick={() => { setSimulate(false); setValues({}) }}>编辑布局</button><button aria-pressed={simulate} onClick={() => { setSimulate(true); setValues({}); select('') }}>交互 / 窗口预览</button><label><input type="checkbox" checked={grid} onChange={event => setGrid(event.target.checked)} />8px 吸附与对齐</label>
        {simulate && <><label>窗口<select aria-label="界面预览窗口" value={resolution} onChange={event => setResolution(event.target.value)}>{['1280x720', '1024x768', '1920x1080', '2560x1080'].map(size => <option key={size}>{size}</option>)}</select></label><label>GUI 缩放<select aria-label="界面 GUI 缩放" value={guiScale} onChange={event => setGuiScale(Number(event.target.value))}>{[1, 2, 3, 4].map(value => <option key={value}>{value}</option>)}</select></label></>}
      </div>
      <div className="gui-tools">{guiTypes.map(type => <button key={type} disabled={busy || simulate || draft.elements.length >= 64 || draft.layoutType === 'hud-overlay' && ['button', 'toggle', 'slider'].includes(type)} onClick={() => add(type)}>＋{guiTypeLabels[type]}</button>)}</div>
      <p className="muted" role="status">{simulate ? `网页模拟 · GUI 缩放 ${actualScale}，可见 ${viewport.width}×${viewport.height}；玩家生命/饥饿示例值为 20，不读取游戏。` : '拖动移动，右下角调整尺寸；选择后编辑属性。位置单位为 Minecraft GUI 像素。'}</p>
      <div className="gui-canvas-frame" ref={frame}><div style={{ width: viewport.width * scale, height: viewport.height * scale }}><div data-testid="gui-canvas" className={`gui-canvas ${grid && !simulate ? 'gui-grid' : ''}`} style={{ width: viewport.width, height: viewport.height, transform: `scale(${scale})` }}>
        {draft.elements.map(element => <div key={element.id} data-layout-id={element.id} data-element-type={element.type} className={`gui-node gui-node-${element.type} ${!simulate && selectedId === element.id ? 'gui-selected' : ''}`} role={['button', 'toggle'].includes(element.type) ? 'button' : undefined} tabIndex={simulate ? 0 : -1}
          style={{ left: origin.x + element.x, top: origin.y + element.y, width: element.width, height: element.height, color: element.color, opacity: ['label', 'panel'].includes(element.type) ? element.alpha : 1, backgroundColor: element.type === 'panel' ? element.color : undefined, textShadow: element.shadow ? '1px 1px #202020' : 'none' }}
          onPointerDown={event => begin(event, element)} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onClick={() => interact(element)} onKeyDown={event => { if (simulate && ['Enter', ' '].includes(event.key)) { event.preventDefault(); interact(element) } }}>
          {element.type === 'slot' ? <ItemVisual image={visuals.items?.[element.itemId]} label={element.itemId.split(':')[1]} /> : element.type === 'image' ? (visuals.textures?.[element.texture || ''] ? <img className="gui-node-image" src={visuals.textures[element.texture!]!} alt={element.label} draggable={false} /> : <span className="gui-node-image-missing">图片</span>) : element.type === 'panel' ? null : element.type === 'slider' && simulate ? <label>{text(element)}<input type="range" min={element.min} max={element.max} step={1} value={Number(currentValue(element))} onChange={event => { const value = Number(event.target.value); setValues(previous => ({ ...previous, [element.id]: value })) }} /></label> : text(element)}
          {!simulate && selectedId === element.id && <span className="gui-resize" aria-label="调整元素尺寸" onPointerDown={event => begin(event, element, true)} onPointerMove={move} onPointerUp={end} onPointerCancel={end} />}
        </div>)}
        {!simulate && guides.guideX !== undefined && <i className="gui-guide gui-guide-x" style={{ left: guides.guideX }} />}{!simulate && guides.guideY !== undefined && <i className="gui-guide gui-guide-y" style={{ top: guides.guideY }} />}
      </div></div></div>
      <p className="muted">展示槽位仅渲染物品，不接收物品交换；服务端容器同步未实现。网页试用不会保存游戏配置。应用后请构建/重启，再验证真实交互。</p>
      <div className="gui-inspector"><div className="row"><label className="grow">元素<select aria-label="选择界面元素" value={selectedId} onChange={event => select(event.target.value)}><option value="">选择画布元素</option>{draft.elements.map(element => <option key={element.id} value={element.id}>{element.id} · {guiTypeLabels[element.type]}</option>)}</select></label>{selected && <button disabled={busy} onClick={() => { change({ ...draft, elements: draft.elements.filter(element => element.id !== selected.id) }); select('') }}>删除选中元素</button>}</div>
        {selected && <div className="gui-settings"><label>稳定 ID<input aria-label="界面元素 ID" value={selected.id} onChange={event => patch(selected, { id: event.target.value })} /></label><label>文字<input aria-label="界面元素文字" value={selected.label} onChange={event => patch(selected, { label: event.target.value })} /></label>{numeric('x', 'X')}{numeric('y', 'Y')}{numeric('width', '宽')}{numeric('height', '高')}
          {['label', 'panel'].includes(selected.type) && <><label>颜色<input type="color" aria-label="界面元素颜色" value={selected.color} onChange={event => patch(selected, { color: event.target.value })} /></label><label>透明度<input type="number" aria-label="界面元素透明度" min={0} max={1} step={0.1} value={selected.alpha} onChange={event => patch(selected, { alpha: Number(event.target.value) })} /></label><label><input type="checkbox" checked={selected.shadow} onChange={event => patch(selected, { shadow: event.target.checked })} />文字阴影</label></>}
          {selected.type === 'label' && <label>数据绑定<select aria-label="界面元素绑定" value={selected.bind} onChange={event => patch(selected, { bind: event.target.value })}><option value="">无绑定</option><option value="player-health">玩家生命</option><option value="player-food">玩家饥饿</option>{draft.elements.filter(element => ['slider', 'toggle'].includes(element.type)).map(element => <option value={element.id} key={element.id}>{element.id}</option>)}</select></label>}
          {selected.type === 'slider' && <>{numeric('min', '最小值')}{numeric('max', '最大值')}{numeric('initial', '默认值')}</>}
          {selected.type === 'toggle' && <label><input type="checkbox" aria-label="界面开关默认开启" checked={selected.checked} onChange={event => patch(selected, { checked: event.target.checked })} />默认开启</label>}
          {selected.type === 'button' && <><label>点击行为<select aria-label="界面按钮行为" value={selected.action} onChange={event => patch(selected, { action: event.target.value as GuiElement['action'] })}><option value="close">关闭界面</option><option value="reset">恢复本布局默认值</option><option value="increment">递增指定滑块</option></select></label>{selected.action === 'increment' && <label>目标滑块<select aria-label="界面按钮目标" value={selected.target} onChange={event => patch(selected, { target: event.target.value })}><option value="">选择滑块</option>{draft.elements.filter(element => element.type === 'slider').map(element => <option value={element.id} key={element.id}>{element.id}</option>)}</select></label>}</>}
          {selected.type === 'slot' && <label>展示物品 ID<input aria-label="界面展示物品" value={selected.itemId} onChange={event => patch(selected, { itemId: event.target.value })} /></label>}
          {selected.type === 'image' && <label>图片纹理 ID<input aria-label="界面图片纹理" placeholder="mymod:gui/icon" value={selected.texture || ''} onChange={event => patch(selected, { texture: event.target.value })} /><small className="muted">在“纹理”工作区绘制并保存，例如 mymod:gui/health_bar；也可以在内容工作区绘制物品图标。</small></label>}
        </div>}
      </div>
      {issues.length > 0 && <p role="alert" className="error">{issues.map(issue => issue.path.join('.') + '：' + issue.message).join('；')}</p>}
      <div className="row gui-save"><button disabled={busy || !validation.success} onClick={() => void run(async () => { setPlan(await request({ action: 'preview', value: draft, expectedRevision: document?.revision ?? null })); setMessage('请检查生成的客户端代码、布局资源和入口；确认后应用') })}>预览界面变更</button><button className="primary" disabled={busy || !plan || !validation.success} onClick={() => void run(async () => { const value = (await request({ action: 'save', value: draft, expectedRevision: document?.revision ?? null, previewRevision: plan!.previewRevision! })).document!; setDocument(value); setDraft(value.value!); setDirty(false); setPlan(undefined); await refresh(); setMessage('已应用并读回工程；Agent 可用 fabric_gui_workspace 接续。重新构建/启动游戏后按快捷键验证。') })}>确认应用界面</button>{document && <button disabled={busy} onClick={() => void run(() => load(document))}>重新加载界面</button>}</div>
      {plan && <div className="gui-diff"><p>游戏本地配置文件：config/{plan.configName}（与工程布局分开）</p>{plan.files?.filter(file => file.before !== file.after).map(file => <details key={file.path}><summary>{file.before === null ? '新建' : '更新'} · {file.path}</summary><div className="columns"><pre>{file.before ?? '尚不存在'}</pre><pre>{file.after}</pre></div></details>)}</div>}
      </>}
      {error && <p role="alert" className="message error">{error}</p>}{message && <p role="status" className="connected">{message}</p>}
    </div></div>
  </section>
}
