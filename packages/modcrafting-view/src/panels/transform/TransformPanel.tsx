import { useEffect, useState } from 'react'
import type { PackManifest } from '../../../../modcrafting-core/src/pack-model.ts'
import type { PackEntry } from '../../../../modcrafting-core/src/workspace-model.ts'
import type { BrowserAction } from '../../../../../plugins/modcrafting-fabric/src/browser-server.ts'
import { PanelEmptyState, PanelErrorState } from '../../shell/PanelState.tsx'
import { action } from '../../client.ts'

type Level = 'L1' | 'L2' | 'L3' | 'L4'

interface WorkspaceView {
  path: string
  manifest: PackManifest
  revision: string
}

interface DecisionView {
  allowed: boolean
  exportable: boolean
  reasons: string[]
  code?: string
  message: string
}

interface TransformResult {
  ok: true
  action: 'apply'
  level: Level
  entryId: string
  transformId: string
  exportable: boolean
  decision: DecisionView
  warnings: string[]
  output?: string
  zip?: string
  files?: string[]
  projectPath?: string
  transformDir?: string
  plan?: string
  applied?: boolean
  patches?: number
  analysis?: string
  classes?: number
  decompiler?: string
  truncated?: boolean
  existing?: boolean
}

interface RollbackResult {
  ok: true
  removed: boolean
  keptProject: boolean
  warning?: string
}

interface AuditRecord {
  at: string
  action: 'apply' | 'rollback' | 'refuse'
  level: Level
  entryId?: string
  transformId?: string
  decision: { allowed: boolean; exportable: boolean; code?: string; message: string }
}

interface AuditView {
  file: string
  total: number
  records: AuditRecord[]
}

interface Operation {
  path: string
  mode: 'text' | 'copy'
  text: string
}

interface CompanionForm {
  projectPath: string
  modId: string
  modName: string
  sourceModId: string
  className: string
  method: string
}

interface PatchForm {
  className: string
  method: string
  description: string
}

const LEVELS: Array<{ id: Level; label: string; summary: string }> = [
  { id: 'L1', label: 'L1 资源覆盖', summary: '生成独立资源包，替换 assets/ 或 data/ 下的文件；不修改源 jar。' },
  { id: 'L2', label: 'L2 伴生 Mod', summary: '生成 Fabric 伴生工程，用字符串目标注入；源 jar 不进入编译类路径。' },
  { id: 'L3', label: 'L3 字节码计划', summary: '只写出补丁计划，不改写字节；需要许可证允许修改，并对本次操作确认。' },
  { id: 'L4', label: 'L4 结构分析', summary: '只列出类与资源清单；不含反编译器，分析结果永不可导出。' }
]

const EMPTY_COMPANION: CompanionForm = { projectPath: '', modId: '', modName: '', sourceModId: '', className: '', method: '' }
const EMPTY_PATCH: PatchForm = { className: '', method: '', description: '' }

const MOD_ID_RE = /^[a-z][a-z0-9_-]{1,63}$/
const CLASS_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/
const METHOD_RE = /^[A-Za-z_$<][\w$<>]*$/

function licenseLabel(entry: PackEntry): string {
  return entry.license.redistributable ? `${entry.license.id} · 可再分发` : `${entry.license.id} · 仅本地`
}

/**
 * The transform panel is a review surface, not a magic button.
 *
 * It shows the licence decision before the call, separates the four levels by
 * what they actually produce, and requires an explicit consent checkbox for the
 * two levels that touch third-party code. The result keeps every path and warning
 * the action returned, and the audit list makes refusals visible — the audit log
 * is the product's answer to "did this really run?".
 */
export function TransformPanel({ workspacePath, readOnly }: { workspacePath: string; readOnly: boolean }) {
  const [workspace, setWorkspace] = useState<WorkspaceView>()
  const [phase, setPhase] = useState<'idle' | 'loading' | 'missing' | 'ready' | 'error'>('idle')
  const [loadError, setLoadError] = useState('')
  const [entryId, setEntryId] = useState('')
  const [level, setLevel] = useState<Level>('L1')
  const [consent, setConsent] = useState(false)
  const [operations, setOperations] = useState<Operation[]>([{ path: '', mode: 'text', text: '' }])
  const [companion, setCompanion] = useState<CompanionForm>(EMPTY_COMPANION)
  const [patch, setPatch] = useState<PatchForm>(EMPTY_PATCH)
  const [maxClasses, setMaxClasses] = useState('200')
  const [result, setResult] = useState<TransformResult>()
  const [rollbackResult, setRollbackResult] = useState<RollbackResult>()
  const [deleteProject, setDeleteProject] = useState(false)
  const [audit, setAudit] = useState<AuditView>()
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const base = workspacePath.replace(/[\\/]+$/, '')
  const selected = workspace?.manifest.entries.find((entry) => entry.entryId === entryId)
  const defaultCompanionPath = companion.modId.trim() ? `${base}/companions/${companion.modId.trim()}` : ''

  async function reload(): Promise<void> {
    if (!workspacePath) { setPhase('idle'); return }
    setPhase('loading'); setLoadError('')
    try {
      const value = await action<WorkspaceView>({ operation: 'pack_workspace', request: { action: 'load', workspacePath } })
      setWorkspace(value)
      setEntryId((current) => value.manifest.entries.some((entry) => entry.entryId === current)
        ? current
        : value.manifest.entries[0]?.entryId ?? '')
      setPhase('ready')
    } catch (cause) {
      const text = String(cause)
      setWorkspace(undefined)
      if (text.includes('PACK_NOT_FOUND')) setPhase('missing')
      else { setPhase('error'); setLoadError(text) }
    }
  }

  async function refreshAudit(): Promise<void> {
    if (!workspacePath) return
    try {
      setAudit(await action<AuditView>({ operation: 'transform', request: { action: 'audit', workspacePath, limit: 50 } }))
    } catch (cause) {
      setError(String(cause))
    }
  }

  useEffect(() => {
    setWorkspace(undefined); setResult(undefined); setRollbackResult(undefined); setAudit(undefined)
    setError(''); setNotice('')
    void reload()
  }, [workspacePath])

  useEffect(() => {
    if (phase === 'ready') void refreshAudit()
  }, [phase, workspacePath])

  const l1Valid = operations.some((operation) => operation.path.trim() && (operation.mode === 'copy' || operation.text.length > 0))
  const l2Valid = MOD_ID_RE.test(companion.modId.trim())
    && MOD_ID_RE.test(companion.sourceModId.trim())
    && Boolean(companion.modName.trim())
    && CLASS_RE.test(companion.className.trim())
    && (!companion.method.trim() || METHOD_RE.test(companion.method.trim()))
  const l3Valid = CLASS_RE.test(patch.className.trim())
    && METHOD_RE.test(patch.method.trim())
    && Boolean(patch.description.trim())
  const levelValid = level === 'L1' ? l1Valid : level === 'L2' ? l2Valid : level === 'L3' ? l3Valid : true
  const needsConsent = level === 'L3' || level === 'L4'
  const disabled = readOnly || Boolean(busy) || !workspace || !selected || !selected.enabled || !levelValid || (needsConsent && !consent)

  function selectLevel(next: Level): void {
    setLevel(next); setConsent(false); setError(''); setNotice('')
  }

  function updateOperation(index: number, change: Partial<Operation>): void {
    setOperations((current) => current.map((operation, position) => position === index ? { ...operation, ...change } : operation))
  }

  async function apply(): Promise<void> {
    if (!selected) return
    setBusy('改造中'); setError(''); setNotice(''); setRollbackResult(undefined)
    try {
      const request: Record<string, unknown> = {
        action: 'apply',
        level,
        workspacePath,
        entryId: selected.entryId,
        consent
      }
      if (level === 'L1') {
        request.operations = operations
          .filter((operation) => operation.path.trim())
          .map((operation) => operation.mode === 'copy'
            ? { path: operation.path.trim(), copy: true }
            : { path: operation.path.trim(), text: operation.text })
      } else if (level === 'L2') {
        request.companion = {
          projectPath: companion.projectPath.trim() || defaultCompanionPath,
          modId: companion.modId.trim(),
          modName: companion.modName.trim(),
          sourceModId: companion.sourceModId.trim(),
          targets: [{
            className: companion.className.trim(),
            ...(companion.method.trim() ? { method: companion.method.trim() } : {})
          }]
        }
      } else if (level === 'L3') {
        request.patches = [{
          className: patch.className.trim(),
          method: patch.method.trim(),
          description: patch.description.trim()
        }]
      } else {
        request.maxClasses = Math.max(1, Math.min(20_000, Number.parseInt(maxClasses, 10) || 200))
      }
      const value = await action<TransformResult>({ operation: 'transform', request } as BrowserAction)
      setResult(value)
      setNotice(value.existing ? '这次请求与已有产物一致，直接返回了原记录。' : '改造完成；结果与审计记录已写入整合包目录。')
      await refreshAudit()
    } catch (cause) {
      setError(String(cause))
      await refreshAudit()
    } finally {
      setBusy('')
    }
  }

  async function rollback(): Promise<void> {
    if (!result) return
    setBusy('回滚中'); setError(''); setNotice('')
    try {
      const value = await action<RollbackResult>({
        operation: 'transform',
        request: {
          action: 'rollback',
          workspacePath,
          transformId: result.transformId,
          ...(result.level === 'L2' && deleteProject ? { deleteProject: true } : {})
        }
      } as BrowserAction)
      setRollbackResult(value)
      setResult(undefined)
      setNotice(value.keptProject ? '已移除改造记录；伴生工程按请求保留。' : '改造产物与记录已回滚。')
      await refreshAudit()
    } catch (cause) {
      setError(String(cause))
    } finally {
      setBusy('')
    }
  }

  if (!workspacePath) {
    return <PanelEmptyState
      icon="⚗"
      title="改造第三方模组"
      description={<>先绑定整合包目录。改造对象是已经加入 <code>pack.json</code>、并且 jar 已在 <code>mods/</code> 下的条目；源 jar 会被哈希校验，但永远不会被原地改写。</>}
      hint="L1/L2 默认可用；L3/L4 需要许可证允许修改，并对本次操作明确确认。"
    />
  }

  if (phase === 'loading' || phase === 'idle') {
    return <PanelEmptyState icon="⚗" title="改造第三方模组" description="正在读取整合包清单…" />
  }

  if (phase === 'missing') {
    return <PanelEmptyState
      icon="⚗"
      title="改造第三方模组"
      description={<>这个目录还不是整合包（缺少 <code>pack.json</code>）。</>}
      hint="先在“整合包”面板创建或打开一个包，并加入要改造的条目。"
    />
  }

  if (phase === 'error') {
    return <PanelErrorState title="无法读取整合包" message={loadError} retry={() => void reload()} hint="确认目录存在且 pack.json 是合法 JSON，然后重新读取。" />
  }

  return <section className="panel transform-workspace">
    <p className="eyebrow">LICENCE-GATED TRANSFORM</p>
    <div className="row transform-heading">
      <h2>改造第三方模组</h2>
      <button className="ghost" disabled={Boolean(busy)} onClick={() => void reload()}>重新读取清单</button>
    </div>
    <p className="muted">四个等级按“改动有多深”分开：L1/L2 不碰源 jar，默认允许；L3/L4 读取或改写第三方代码，必须同时满足许可证允许修改和本次操作确认。不可再分发的源即使本地改造成功，产物也会被标记为不可导出。</p>

    {workspace?.manifest.entries.length === 0
      ? <p className="pack-warning">整合包里还没有条目。先到“发现模组”或“通用底座”加入候选，并确保 jar 已下载到 mods/。</p>
      : <div className="transform-grid">
        <label className="transform-field">改造对象
          <select value={entryId} onChange={(event) => setEntryId(event.target.value)}>
            {workspace?.manifest.entries.map((entry) => <option key={entry.entryId} value={entry.entryId}>
              {entry.entryId} · {entry.fileName}{entry.enabled ? '' : '（已禁用）'}
            </option>)}
          </select>
        </label>
        <div className="transform-license">
          <span>许可证</span>
          <strong>{selected ? licenseLabel(selected) : '—'}</strong>
          {selected && !selected.license.redistributable && <small>产物只能留在本地，不能进入导出包或发布。</small>}
        </div>
      </div>}

    <div className="transform-levels">
      {LEVELS.map((candidate) => <button
        key={candidate.id}
        className={`transform-level${level === candidate.id ? ' selected' : ''}`}
        onClick={() => selectLevel(candidate.id)}
      >
        <strong>{candidate.label}</strong>
        <span>{candidate.summary}</span>
      </button>)}
    </div>

    {level === 'L1' && <div className="transform-form">
      <p className="muted">每行是一个覆盖文件。`text` 直接写入新内容；`copy` 从源 jar 的同路径复制一份再覆盖。路径必须是 <code>assets/</code> 或 <code>data/</code> 下的普通文件。</p>
      {operations.map((operation, index) => <div className="transform-operation" key={index}>
        <input value={operation.path} onChange={(event) => updateOperation(index, { path: event.target.value })} placeholder="assets/example/lang/en_us.json" />
        <select value={operation.mode} onChange={(event) => updateOperation(index, { mode: event.target.value as Operation['mode'] })}>
          <option value="text">写入文本</option>
          <option value="copy">复制源文件</option>
        </select>
        {operation.mode === 'text' && <textarea value={operation.text} onChange={(event) => updateOperation(index, { text: event.target.value })} placeholder='{"item.example.name":"Renamed"}' />}
        <button className="ghost" disabled={operations.length === 1} onClick={() => setOperations((current) => current.filter((_, position) => position !== index))}>移除</button>
      </div>)}
      <button className="ghost" onClick={() => setOperations((current) => [...current, { path: '', mode: 'text', text: '' }])}>添加覆盖文件</button>
    </div>}

    {level === 'L2' && <div className="transform-form transform-grid">
      <label className="transform-field wide">伴生工程目录<input value={companion.projectPath} onChange={(event) => setCompanion({ ...companion, projectPath: event.target.value })} placeholder={defaultCompanionPath || '留空则使用 <整合包>/companions/<modId>'} /></label>
      <label className="transform-field">伴生 Mod ID<input value={companion.modId} onChange={(event) => setCompanion({ ...companion, modId: event.target.value })} placeholder="例如：exampletweaks" /></label>
      <label className="transform-field">显示名称<input value={companion.modName} onChange={(event) => setCompanion({ ...companion, modName: event.target.value })} placeholder="例如：Example Tweaks" /></label>
      <label className="transform-field">源 Mod ID<input value={companion.sourceModId} onChange={(event) => setCompanion({ ...companion, sourceModId: event.target.value })} placeholder="被适配模组的 fabric.mod.json id" /></label>
      <label className="transform-field">目标类名<input value={companion.className} onChange={(event) => setCompanion({ ...companion, className: event.target.value })} placeholder="com.example.ExampleMod" /></label>
      <label className="transform-field">目标方法<input value={companion.method} onChange={(event) => setCompanion({ ...companion, method: event.target.value })} placeholder="可留空：先只生成空 Mixin 类" /></label>
    </div>}

    {level === 'L3' && <div className="transform-form transform-grid">
      <p className="wide muted">这一层只写计划，不会产生“已打补丁”的 jar。当前版本不含字节码引擎；真正需要改变行为时，优先考虑 L2 伴生 Mod。</p>
      <label className="transform-field">目标类名<input value={patch.className} onChange={(event) => setPatch({ ...patch, className: event.target.value })} placeholder="com.example.Example" /></label>
      <label className="transform-field">目标方法<input value={patch.method} onChange={(event) => setPatch({ ...patch, method: event.target.value })} placeholder="tick" /></label>
      <label className="transform-field wide">计划描述<textarea value={patch.description} onChange={(event) => setPatch({ ...patch, description: event.target.value })} placeholder="说明要注入什么、为什么需要这一层改动" /></label>
    </div>}

    {level === 'L4' && <div className="transform-form transform-grid">
      <p className="wide muted">这一层只做结构清单：类名、大小、Mixin 配置与已声明的元数据。不反编译，不输出类字节，结果不可导出。</p>
      <label className="transform-field">最多列出类数<input type="number" min="1" max="20000" value={maxClasses} onChange={(event) => setMaxClasses(event.target.value)} /></label>
    </div>}

    {needsConsent && <label className="check transform-consent">
      <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
      <span>我确认对 <strong>{selected?.entryId ?? '该条目'}</strong> 执行 {level} 操作，并已核对许可证允许修改。</span>
    </label>}

    <div className="row transform-actions">
      <button className="primary" disabled={disabled} onClick={() => void apply()}>{busy || `应用 ${level}`}</button>
      <span className="muted">输出写入 <code>transforms/&lt;transformId&gt;/</code>；源 jar 只读，回滚只删除本工具创建的产物。</span>
    </div>

    {error && <p className="error">{error}</p>}
    {notice && !error && <p className="pack-notice">{notice}</p>}

    {result && <div className={`transform-result${result.exportable ? '' : ' local-only'}`}>
      <div className="row">
        <h3>{result.level} · {result.entryId}</h3>
        <span className={`badge ${result.exportable ? 'badge-satisfied' : 'badge-gap'}`}>{result.exportable ? '可导出' : '仅本地'}</span>
        {result.existing && <span className="badge">已有记录</span>}
      </div>
      <p>{result.decision.message}</p>
      {result.decision.reasons.length > 0 && <ul className="transform-reasons">{result.decision.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>}
      <div className="pack-summary">
        <div><span>记录 ID</span><strong>{result.transformId}</strong></div>
        <div><span>产物类型</span><strong>{result.level === 'L1' ? '资源覆盖' : result.level === 'L2' ? '伴生工程' : result.level === 'L3' ? '补丁计划' : '结构分析'}</strong></div>
        <div><span>{result.level === 'L4' ? '类数量' : result.level === 'L3' ? '补丁数' : '文件数'}</span><strong>{result.level === 'L4' ? result.classes ?? 0 : result.level === 'L3' ? result.patches ?? 0 : result.files?.length ?? 0}</strong></div>
        <div><span>状态</span><strong>{result.applied === false ? '仅计划' : '已写入'}</strong></div>
      </div>
      <ul className="transform-paths">
        {result.output && <li><span>记录目录</span><code>{result.output}</code></li>}
        {result.zip && <li><span>覆盖包</span><code>{result.zip}</code></li>}
        {result.projectPath && <li><span>伴生工程</span><code>{result.projectPath}</code></li>}
        {result.plan && <li><span>补丁计划</span><code>{result.plan}</code></li>}
        {result.analysis && <li><span>分析结果</span><code>{result.analysis}</code></li>}
      </ul>
      {result.files && result.files.length > 0 && <details><summary>涉及文件 · {result.files.length}</summary><ul>{result.files.map((file) => <li key={file}><code>{file}</code></li>)}</ul></details>}
      {result.warnings.length > 0 && <div className="pack-warning"><ul>{result.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></div>}
      <div className="row transform-actions">
        {result.level === 'L2' && <label className="check"><input type="checkbox" checked={deleteProject} onChange={(event) => setDeleteProject(event.target.checked)} />同时删除伴生工程目录</label>}
        <button disabled={Boolean(busy)} onClick={() => void rollback()}>{busy || '回滚这次改造'}</button>
      </div>
    </div>}

    {rollbackResult?.warning && <p className="pack-warning">{rollbackResult.warning}</p>}

    <div className="transform-audit">
      <div className="row">
        <h3>审计记录</h3>
        <button className="ghost" disabled={Boolean(busy)} onClick={() => void refreshAudit()}>刷新</button>
        <span className="muted">{audit ? `${audit.total} 条 · ${audit.file}` : '尚未读取'}</span>
      </div>
      {audit && audit.records.length === 0 && <p className="muted">还没有改造记录。拒绝与回滚同样会记录在这里。</p>}
      {audit && audit.records.length > 0 && <ul className="transform-audit-list">
        {[...audit.records].reverse().map((record, index) => <li key={`${record.at}:${record.transformId ?? record.entryId ?? index}:${index}`} className={`audit-${record.action}`}>
          <div className="row">
            <strong>{record.action === 'apply' ? '应用' : record.action === 'refuse' ? '拒绝' : '回滚'} · {record.level}</strong>
            <span className="muted">{record.at}</span>
          </div>
          <p>{record.entryId ?? '—'}{record.transformId ? ` · ${record.transformId}` : ''}</p>
          <p className="muted">{record.decision.code ? `${record.decision.code}：` : ''}{record.decision.message}</p>
        </li>)}
      </ul>}
    </div>
  </section>
}
