import { useEffect, useState } from 'react'
import type { BaselineProfile } from '../../../../modcrafting-core/src/pack-model.ts'
import type { BaselineMissing, BaselinePick } from '../../../../modcrafting-core/src/pack/pack-baseline.ts'
import type { PackEntry } from '../../../../modcrafting-core/src/workspace-model.ts'
import { PanelEmptyState } from '../../shell/PanelState.tsx'
import { action } from '../../client.ts'

interface BaselineRead {
  action: 'read'
  profile: BaselineProfile
  source: 'builtin' | 'workspace'
  file: string
}

interface BaselineResolve {
  action: 'resolve'
  targetId: string
  picks: BaselinePick[]
  missing: BaselineMissing[]
  warnings: string[]
  entries: PackEntry[]
}

/**
 * The baseline is a set of groups, not a shopping list. Checking availability is
 * a deliberate action because it costs two registry reads per entry; the result
 * names the exact version, licence and replacement used.
 */
export function BaselinePanel({ workspacePath, initialTargetId, readOnly }: { workspacePath: string; initialTargetId: string; readOnly: boolean }) {
  const [profile, setProfile] = useState<BaselineProfile>()
  const [source, setSource] = useState<'builtin' | 'workspace'>('builtin')
  const [selected, setSelected] = useState<string[]>(['performance', 'qol'])
  const [targetId, setTargetId] = useState(initialTargetId)
  const [result, setResult] = useState<BaselineResolve>()
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(false)
  const [added, setAdded] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    setProfile(undefined); setResult(undefined); setError('')
    if (!workspacePath) return
    void action<BaselineRead>({ operation: 'pack_baseline', request: { action: 'read', workspacePath } })
      .then((value) => {
        if (!active) return
        setProfile(value.profile)
        setSource(value.source)
        const available = new Set(value.profile.groups.map((group) => group.id))
        setSelected((current) => current.filter((id) => available.has(id)).length > 0 ? current.filter((id) => available.has(id)) : value.profile.groups.slice(0, 2).map((group) => group.id))
      })
      .catch((cause) => { if (active) setError(String(cause)) })
    return () => { active = false }
  }, [workspacePath])

  async function resolve() {
    if (!workspacePath) return
    setBusy(true); setError('')
    try {
      setResult(await action<BaselineResolve>({
        operation: 'pack_baseline',
        request: { action: 'resolve', workspacePath, targetId: targetId.trim(), groupIds: selected }
      }))
    } catch (cause) {
      setError(String(cause))
    } finally {
      setBusy(false)
    }
  }

  async function addToPack(): Promise<void> {
    if (!workspacePath || !result || result.entries.length === 0) return
    setAdding(true); setError(''); setAdded('')
    try {
      const loaded = await action<{ revision: string }>({
        operation: 'pack_workspace',
        request: { action: 'load', workspacePath }
      })
      const value = await action<{ added: number; replaced: number }>({
        operation: 'pack_workspace',
        request: {
          action: 'add_entries',
          workspacePath,
          entries: result.entries,
          expectedRevision: loaded.revision
        }
      })
      setAdded(`已加入 ${value.added} 项，更新 ${value.replaced} 项。到“整合包”面板求解并导出。`)
    } catch (cause) {
      const text = String(cause)
      setError(text.includes('PACK_NOT_FOUND')
        ? '这个目录还没有整合包清单。先到“整合包”面板建立 pack.json，再把底座条目加入。'
        : text)
    } finally {
      setAdding(false)
    }
  }

  if (!workspacePath) {
    return <PanelEmptyState
      icon="▤"
      title="通用底座"
      description={<>先绑定整合包目录，或在概览中打开一个工程。底座文件会写到 <code>.modcrafting/baseline.json</code>；没有自定义文件时使用内置分组。</>}
      hint="底座只收优化、画面与操作类模组，不改变原版玩法。"
    />
  }

  return <section className="panel baseline-workspace">
    <p className="eyebrow">SHARED BASELINE</p>
    <h2>通用底座</h2>
    <p className="muted">底座只放「让游戏更顺手」的模组：优化、画面与操作。玩法模组会被拒绝，因为它们改变的是游戏内容。来源：{source === 'workspace' ? '工作区自定义配置' : '内置配置'}。</p>

    <div className="row baseline-target">
      <label className="grow">目标版本<input value={targetId} onChange={(event) => setTargetId(event.target.value)} placeholder="fabric@1.21.4" /></label>
      <button className="primary" disabled={readOnly || busy || selected.length === 0 || !targetId.trim()} onClick={() => void resolve()}>{busy ? '检查中…' : '检查可用性并装配'}</button>
    </div>
    {error && <p className="error">{error}</p>}
    {added && <p className="pack-notice">{added}</p>}

    {profile && <div className="baseline-groups">
      {profile.groups.map((group) => {
        const checked = selected.includes(group.id)
        return <article className={`baseline-group${checked ? ' selected' : ''}`} key={group.id}>
          <label className="check">
            <input type="checkbox" checked={checked} disabled={readOnly} onChange={(event) => setSelected((current) => event.target.checked ? [...new Set([...current, group.id])] : current.filter((id) => id !== group.id))} />
            <strong>{group.label}</strong>
            <span className="badge">{group.entries.length} 项</span>
          </label>
          <p className="muted">{group.description}</p>
          <p className="baseline-slugs">{group.entries.map((entry) => <code key={entry.slug}>{entry.slug}{entry.required ? '*' : ''}</code>)}</p>
        </article>
      })}
    </div>}

    {result && <>
      <div className="baseline-summary">
        <div><span>目标</span><strong>{result.targetId}</strong></div>
        <div><span>已装配</span><strong>{result.picks.length}</strong></div>
        <div><span>必需缺口</span><strong>{result.missing.length}</strong></div>
        <div><span>生成条目</span><strong>{result.entries.length}</strong></div>
      </div>
      <div className="row baseline-add">
        <button className="primary" disabled={readOnly || adding || result.entries.length === 0} onClick={() => void addToPack()}>{adding ? '加入中…' : '加入整合包'}</button>
        <span className="muted">加入只写 pack.json；依赖与锁文件仍需在“整合包”面板求解。</span>
      </div>

      {result.warnings.length > 0 && <details className="baseline-warnings" open><summary>警告与替代</summary><ul>{result.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></details>}

      {result.missing.length > 0 && <div className="baseline-missing">
        <h3>必需但不可用</h3>
        <ul>{result.missing.map((entry) => <li key={`${entry.group}:${entry.slug}`}><strong>{entry.slug}</strong><span>{entry.group}</span><small>{entry.reason}</small></li>)}</ul>
        <p className="muted">可以换一个目标版本、放宽该组，或把缺口交给改造/桥接流程。</p>
      </div>}

      <table className="baseline-table">
        <thead><tr><th>条目</th><th>组</th><th>版本</th><th>许可</th><th>说明</th></tr></thead>
        <tbody>{result.picks.map((pick) => <tr key={pick.slug}>
          <td><strong>{pick.slug}</strong>{pick.alternative && <span className="badge badge-INCONCLUSIVE" title={`替代 ${pick.requestedSlug}`}>替代</span>}<small>{pick.file.fileName}</small></td>
          <td>{pick.group}</td>
          <td>{pick.version.versionNumber}</td>
          <td>{pick.project.license.redistributable ? pick.project.license.id : <span className="error">{pick.project.license.id}</span>}</td>
          <td>{pick.reason}</td>
        </tr>)}</tbody>
      </table>
      {result.picks.length === 0 && <p className="muted">没有条目被装配。检查目标版本或所选分组。</p>}
    </>}
  </section>
}
