import { useEffect, useState } from 'react'
import type { PackLock, PackManifest, ResolveFinding, ResolveVerdict } from '../../../../modcrafting-core/src/pack-model.ts'
import type { PackEntry } from '../../../../modcrafting-core/src/workspace-model.ts'
import { PanelEmptyState, PanelErrorState } from '../../shell/PanelState.tsx'
import { action } from '../../client.ts'

interface PackWorkspaceView {
  path: string
  manifestFile: string
  lockFile: string
  manifest: PackManifest
  revision: string
  lock: PackLock | null
  drift: { missingInLock: string[]; extraInLock: string[] } | null
}

interface SolveView {
  action: 'solve'
  verdict: ResolveVerdict
  findings: ResolveFinding[]
  missing: string[]
  lock: PackLock
  wrote: boolean
  drift: PackWorkspaceView['drift']
}

interface ExportView {
  action: 'export'
  kind: 'mrpack' | 'prism'
  file: string
  bytes: number
  targetId: string
  loaderVersion: string
  warnings: string[]
  files: string[]
}

const VERDICT_LABELS: Record<ResolveVerdict, string> = {
  satisfied: '可构建',
  gap: '有缺口',
  conflict: '有冲突',
  unsatisfiable: '无法构建'
}

function size(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

function sourceLabel(entry: PackEntry): string {
  return entry.source === 'baseline' ? '底座' : entry.source === 'local' ? '本地' : entry.source === 'transform' ? '改造' : entry.source
}

/**
 * The pack panel is deliberately the only place that writes `pack.json`.
 *
 * Discovery and baseline panels resolve candidates and then hand ready entries
 * here through the same revision-checked action; the manifest stays the single
 * review surface, and the lock/export view can never disagree with it silently.
 */
export function PackPanel({ workspacePath, initialTargetId, readOnly }: { workspacePath: string; initialTargetId: string; readOnly: boolean }) {
  const [workspace, setWorkspace] = useState<PackWorkspaceView>()
  const [phase, setPhase] = useState<'loading' | 'missing' | 'ready' | 'error' | 'idle'>('idle')
  const [loadError, setLoadError] = useState('')
  const [name, setName] = useState('')
  const [version, setVersion] = useState('0.1.0')
  const [targetId, setTargetId] = useState(initialTargetId)
  const [solveResult, setSolveResult] = useState<SolveView>()
  const [exportResult, setExportResult] = useState<ExportView>()
  const [overwriteKind, setOverwriteKind] = useState<'mrpack' | 'prism'>()
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  async function reload(showLoading = false): Promise<void> {
    if (!workspacePath) { setPhase('idle'); return }
    if (showLoading) setPhase('loading')
    setLoadError('')
    try {
      const value = await action<PackWorkspaceView>({ operation: 'pack_workspace', request: { action: 'load', workspacePath } })
      setWorkspace(value)
      setPhase('ready')
    } catch (cause) {
      const text = String(cause)
      setWorkspace(undefined)
      if (text.includes('PACK_NOT_FOUND')) setPhase('missing')
      else { setPhase('error'); setLoadError(text) }
    }
  }

  useEffect(() => {
    setWorkspace(undefined); setSolveResult(undefined); setExportResult(undefined)
    setError(''); setNotice('')
    void reload(true)
  }, [workspacePath])

  async function call<T>(label: string, work: () => Promise<T>): Promise<T | undefined> {
    setBusy(label); setError(''); setNotice('')
    try {
      return await work()
    } catch (cause) {
      const text = String(cause)
      setError(text.includes('PACK_REVISION_CONFLICT')
        ? `${text}（清单已被其他面板或编辑器修改，请先点“重新读取”。）`
        : text)
      return undefined
    } finally {
      setBusy('')
    }
  }

  async function create(): Promise<void> {
    const value = await call('创建整合包', () => action<PackWorkspaceView>({
      operation: 'pack_workspace',
      request: {
        action: 'create',
        workspacePath,
        name: name.trim() || '未命名整合包',
        version: version.trim(),
        targetId: targetId.trim()
      }
    }))
    if (!value) return
    setWorkspace(value)
    setPhase('ready')
    setNotice('整合包清单已建立。可以在“发现模组”或“通用底座”里挑选条目，也可以直接求解空包。')
  }

  async function toggle(entry: PackEntry): Promise<void> {
    if (!workspace) return
    const value = await call(entry.enabled ? '停用条目' : '启用条目', () => action<PackWorkspaceView>({
      operation: 'pack_workspace',
      request: { action: 'set_enabled', workspacePath, entryId: entry.entryId, enabled: !entry.enabled, expectedRevision: workspace.revision }
    }))
    if (value) setWorkspace(value)
  }

  async function remove(entry: PackEntry): Promise<void> {
    if (!workspace) return
    const value = await call('移除条目', () => action<PackWorkspaceView>({
      operation: 'pack_workspace',
      request: { action: 'remove_entries', workspacePath, entryIds: [entry.entryId], expectedRevision: workspace.revision }
    }))
    if (value) setWorkspace(value)
  }

  async function solve(): Promise<void> {
    const value = await call('求解依赖', () => action<SolveView>({
      operation: 'pack_workspace',
      request: { action: 'solve', workspacePath, writeLock: true }
    }))
    if (!value) return
    setSolveResult(value)
    setExportResult(undefined)
    await reload()
    setNotice(value.wrote
      ? '求解完成并写入 pack.lock.json。'
      : '求解完成，但结果有冲突或无法构建，没有写锁文件。先处理下面的问题。')
  }

  async function exportAs(kind: 'mrpack' | 'prism', overwrite = false): Promise<void> {
    setBusy(kind === 'mrpack' ? '导出 .mrpack' : '导出 Prism 实例'); setError(''); setNotice('')
    try {
      const value = await action<ExportView>({
        operation: 'pack_workspace',
        request: { action: 'export', workspacePath, kind, ...(overwrite ? { overwrite: true } : {}) }
      })
      setExportResult(value)
      setOverwriteKind(undefined)
      setNotice(`已导出到 ${value.file}`)
    } catch (cause) {
      const text = String(cause)
      setError(text)
      if (text.includes('EXPORT_EXISTS')) {
        setOverwriteKind(kind)
        setNotice('导出目标已存在。确认要覆盖时点“覆盖导出”。')
      }
    } finally {
      setBusy('')
    }
  }

  if (!workspacePath) {
    return <PanelEmptyState
      icon="◫"
      title="整合包"
      description={<>先绑定整合包目录。整合包面板会读取和写入该目录下的 <code>pack.json</code> 与 <code>pack.lock.json</code>，导出结果放在包内的 <code>dist/</code>。</>}
      hint="已有 pack.json 时可以直接读取；空目录可以从这里建立第一份清单。"
    />
  }

  if (phase === 'loading') return <PanelEmptyState icon="◫" title="整合包" description="读取清单中…" />
  if (phase === 'error') return <PanelErrorState title="无法读取整合包" message={loadError} retry={() => void reload(true)} hint="确认目录存在且 pack.json 是合法 JSON，然后重新读取。" />

  if (phase === 'missing') {
    return <section className="panel pack-workspace">
      <p className="eyebrow">PACK MANIFEST</p>
      <h2>建立整合包清单</h2>
      <p className="muted">这个目录还没有 <code>pack.json</code>。清单是人工审阅的唯一入口：它记录“要什么”，锁文件记录“解析成了什么版本”。</p>
      <div className="pack-create">
        <label>名称<input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：空岛任务之旅" /></label>
        <label>版本<input value={version} onChange={(event) => setVersion(event.target.value)} placeholder="0.1.0" /></label>
        <label>目标<input value={targetId} onChange={(event) => setTargetId(event.target.value)} placeholder="fabric@1.21.4" /></label>
        <button className="primary" disabled={readOnly || Boolean(busy) || !targetId.trim() || !/^\d+\.\d+\.\d+/.test(version.trim())} onClick={() => void create()}>{busy || '创建清单'}</button>
      </div>
      {error && <p className="error">{error}</p>}
    </section>
  }

  const entries = workspace?.manifest.entries ?? []
  const lockEntries = workspace?.lock?.entries ?? []
  const drift = workspace?.drift
  const drifted = Boolean(drift && (drift.missingInLock.length > 0 || drift.extraInLock.length > 0))

  return <section className="panel pack-workspace">
    <p className="eyebrow">PACK MANIFEST · {workspace!.revision.slice(0, 12)}</p>
    <div className="row pack-heading">
      <div className="grow"><h2>{workspace!.manifest.name}</h2><p className="muted">{workspace!.path}</p></div>
      <button onClick={() => void reload()} disabled={Boolean(busy)}>重新读取</button>
    </div>

    <div className="pack-summary">
      <div><span>版本</span><strong>{workspace!.manifest.version}</strong></div>
      <div><span>目标</span><strong>{workspace!.manifest.targetId}</strong></div>
      <div><span>条目</span><strong>{entries.length}</strong></div>
      <div><span>已锁定</span><strong>{lockEntries.length}</strong></div>
      <div><span>锁文件</span><strong>{workspace!.lock ? workspace!.lock.generatedAt.slice(0, 10) : '未生成'}</strong></div>
    </div>

    {error && <p className="error">{error}</p>}
    {notice && <p className="pack-notice">{notice}</p>}
    {drifted && <p className="pack-warning">清单与锁文件不一致：{drift!.missingInLock.length > 0 ? `缺少 ${drift!.missingInLock.join('、')}` : ''}{drift!.missingInLock.length > 0 && drift!.extraInLock.length > 0 ? '；' : ''}{drift!.extraInLock.length > 0 ? `多出 ${drift!.extraInLock.join('、')}` : ''}。导出前必须重新求解。</p>}

    <div className="row pack-actions">
      <button className="primary" disabled={readOnly || Boolean(busy)} onClick={() => void solve()}>{busy === '求解依赖' ? '求解中…' : '求解并写锁'}</button>
      <button disabled={readOnly || Boolean(busy) || !workspace!.lock || drifted} onClick={() => void exportAs('mrpack')}>导出 .mrpack</button>
      <button disabled={readOnly || Boolean(busy) || !workspace!.lock || drifted} onClick={() => void exportAs('prism')}>导出 Prism 实例</button>
      {overwriteKind && <button disabled={readOnly || Boolean(busy)} onClick={() => void exportAs(overwriteKind, true)}>覆盖导出</button>}
      {(workspace!.lock && !drifted) && <span className="muted">导出读取锁文件；清单改动后需要重新求解。</span>}
    </div>

    <table className="pack-table">
      <thead><tr><th>启用</th><th>条目</th><th>来源</th><th>文件</th><th>许可</th><th /></tr></thead>
      <tbody>{entries.map((entry) => {
        const locked = lockEntries.find((row) => row.entryId === entry.entryId)
        return <tr key={entry.entryId} className={entry.enabled ? '' : 'disabled'}>
          <td><input type="checkbox" aria-label={`${entry.enabled ? '停用' : '启用'} ${entry.entryId}`} checked={entry.enabled} disabled={readOnly || Boolean(busy)} onChange={() => void toggle(entry)} /></td>
          <td><strong>{entry.entryId}</strong>{locked?.versionId && <small>锁定 {locked.versionId}</small>}</td>
          <td>{sourceLabel(entry)}</td>
          <td><code>{entry.fileName}</code></td>
          <td>{entry.license.redistributable ? entry.license.id : <span className="error" title="不可再分发：导出只写引用，不复制字节">{entry.license.id}</span>}</td>
          <td><button disabled={readOnly || Boolean(busy)} onClick={() => void remove(entry)}>移除</button></td>
        </tr>
      })}</tbody>
    </table>
    {entries.length === 0 && <p className="muted">清单还没有条目。到“通用底座”装配优化/操作模组，或到“发现模组”搜索社区模组；加入后会出现在这里。</p>}

    {workspace!.lock?.warnings.length ? <details className="pack-warnings"><summary>锁文件警告 · {workspace!.lock.warnings.length}</summary><ul>{workspace!.lock.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></details> : null}

    {solveResult && <div className={`pack-solve verdict-${solveResult.verdict}`}>
      <div className="row"><h3>求解结果</h3><span className={`badge badge-${solveResult.verdict}`}>{VERDICT_LABELS[solveResult.verdict]}</span><span className="muted">{solveResult.wrote ? '已写入锁文件' : '未写锁文件'}</span></div>
      {solveResult.findings.length === 0 && <p className="muted">依赖闭合，目标版本都有可用构建。</p>}
      {solveResult.findings.length > 0 && <ul className="pack-findings">{solveResult.findings.map((finding) => <li key={`${finding.code}:${finding.projectId || ''}:${finding.message}`} className={`finding-${finding.verdict}`}><code>{finding.code}</code><span>{finding.message}</span></li>)}</ul>}
      {solveResult.missing.length > 0 && <p className="pack-warning">缺少项目：{solveResult.missing.join('、')}。可以改用替代模组，或把它们列入桥接/改造流程。</p>}
    </div>}

    {exportResult && <div className="pack-export">
      <h3>导出结果</h3>
      <p><strong>{exportResult.kind === 'mrpack' ? '.mrpack' : 'Prism 实例'}</strong><code>{exportResult.file}</code><span className="muted">{size(exportResult.bytes)} · 加载器 {exportResult.loaderVersion}</span></p>
      <p className="muted">{exportResult.files.length} 个文件。{exportResult.kind === 'mrpack' ? '把 .mrpack 拖进支持的启动器即可安装。' : '把整个实例目录放进 Prism/MultiMC 的 instances 目录。'}</p>
      {exportResult.warnings.length > 0 && <details open><summary>导出警告 · {exportResult.warnings.length}</summary><ul>{exportResult.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></details>}
    </div>}
  </section>
}
