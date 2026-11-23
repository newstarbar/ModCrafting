import { useState } from 'react'
import type { Candidate, GapReport } from '../../../../modcrafting-core/src/pack-model.ts'
import { PanelEmptyState } from '../../shell/PanelState.tsx'
import { action } from '../../client.ts'

interface DiscoverResult {
  targetId: string
  candidates: Candidate[]
  gap: GapReport
  warnings: string[]
  queries: string[]
}

type Registry = 'modrinth' | 'curseforge'

const split = (value: string): string[] => value.split(/[\n,，;；]+/).map((part) => part.trim()).filter(Boolean)
const percent = (value: number): string => `${Math.round(value * 100)}%`

function registryUrl(candidate: Candidate): string {
  return candidate.registry === 'modrinth'
    ? `https://modrinth.com/mod/${candidate.slug}`
    : `https://www.curseforge.com/minecraft/mc-mods/${candidate.slug}`
}

/**
 * Discovery is intentionally a form plus a report, not a wizard: the Agent can
 * produce the intent, a human can correct it, and the same core call backs both.
 * Accepting a candidate resolves its exact version and adds it through the same
 * revision-checked pack action the pack panel uses, so the manifest stays the one
 * place that records what the pack contains.
 */
export function DiscoverPanel({ workspacePath, initialTargetId, readOnly }: { workspacePath: string; initialTargetId: string; readOnly: boolean }) {
  const [goal, setGoal] = useState('')
  const [features, setFeatures] = useState('')
  const [mustHave, setMustHave] = useState('')
  const [niceToHave, setNiceToHave] = useState('')
  const [keywords, setKeywords] = useState('')
  const [domain, setDomain] = useState('')
  const [targetId, setTargetId] = useState(initialTargetId)
  const [registries, setRegistries] = useState({ modrinth: true, curseforge: true })
  const [result, setResult] = useState<DiscoverResult>()
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState('')
  const [added, setAdded] = useState('')
  const [error, setError] = useState('')

  const selected = (): Registry[] => [
    ...(registries.modrinth ? ['modrinth' as const] : []),
    ...(registries.curseforge ? ['curseforge' as const] : [])
  ]
  const disabled = readOnly || busy || !goal.trim() || !targetId.trim() || selected().length === 0

  async function search() {
    setBusy(true); setError('')
    try {
      const keywordList = split(keywords)
      const value = await action<DiscoverResult>({
        operation: 'pack_discover',
        request: {
          intent: {
            goal: goal.trim(),
            features: split(features),
            mustHave: split(mustHave),
            niceToHave: split(niceToHave),
            ...(keywordList.length > 0 ? { keywords: keywordList } : {}),
            ...(domain.trim() ? { domain: domain.trim() } : {})
          },
          targetId: targetId.trim(),
          registries: selected(),
          limit: 20
        }
      })
      setResult(value)
    } catch (cause) {
      setError(String(cause))
    } finally {
      setBusy(false)
    }
  }

  async function addCandidate(candidate: Candidate): Promise<void> {
    if (!workspacePath) return
    setAdding(candidate.projectId); setError(''); setAdded('')
    try {
      // Read immediately before writing so the revision check protects the small
      // window between another panel's edit and this click.
      const loaded = await action<{ revision: string }>({
        operation: 'pack_workspace',
        request: { action: 'load', workspacePath }
      })
      const value = await action<{ added: number; replaced: number }>({
        operation: 'pack_workspace',
        request: {
          action: 'add_candidate',
          workspacePath,
          registry: candidate.registry,
          projectId: candidate.projectId,
          expectedRevision: loaded.revision
        }
      })
      setAdded(`${candidate.title} 已${value.replaced > 0 ? '更新到清单' : '加入清单'}。到“整合包”面板求解并导出。`)
    } catch (cause) {
      const text = String(cause)
      setError(text.includes('PACK_NOT_FOUND')
        ? '这个目录还没有整合包清单。先到“整合包”面板建立 pack.json，再把候选加入。'
        : text)
    } finally {
      setAdding('')
    }
  }

  if (!workspacePath) {
    return <PanelEmptyState
      icon="⌕"
      title="发现模组"
      description="先绑定整合包目录。检索结果会按整合包的目标加载器与版本过滤，候选也通过同一个清单加入整合包。"
      hint="没有整合包时，可以先到“整合包”面板建立 pack.json。"
    />
  }

  return <section className="panel discover-workspace">
    <p className="eyebrow">COMMUNITY DISCOVERY</p>
    <h2>发现模组</h2>
    <p className="muted">把想法拆成可核对的能力。检索按目标加载器与版本过滤；覆盖不足的条目会进入缺口报告，作为桥接或分级改造的输入。</p>

    <div className="discover-form">
      <label className="wide">整合包目标<input value={targetId} onChange={(event) => setTargetId(event.target.value)} placeholder="fabric@1.21.4" /></label>
      <label className="wide">这个整合包想做什么<textarea rows={3} value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="例如：一个以任务书驱动的空岛生存整合包，强调自动化与探索" /></label>
      <label>必须具备<textarea rows={3} value={mustHave} onChange={(event) => setMustHave(event.target.value)} placeholder="每行一个，例如：skyblock" /></label>
      <label>希望具备<textarea rows={3} value={niceToHave} onChange={(event) => setNiceToHave(event.target.value)} placeholder="每行一个，例如：map" /></label>
      <label>功能点<textarea rows={4} value={features} onChange={(event) => setFeatures(event.target.value)} placeholder="每行一个，例如：quest book / rewards" /></label>
      <label>检索关键词<textarea rows={4} value={keywords} onChange={(event) => setKeywords(event.target.value)} placeholder="中英文都写，例如：ftb quests / 任务书" /></label>
      <label>领域<input value={domain} onChange={(event) => setDomain(event.target.value)} placeholder="例如：adventure" /></label>
    </div>

    <div className="row discover-actions">
      <label className="check"><input type="checkbox" checked={registries.modrinth} onChange={(event) => setRegistries((old) => ({ ...old, modrinth: event.target.checked }))} />Modrinth</label>
      <label className="check"><input type="checkbox" checked={registries.curseforge} onChange={(event) => setRegistries((old) => ({ ...old, curseforge: event.target.checked }))} />CurseForge（需要 API Key）</label>
      <button className="primary" disabled={disabled} onClick={() => void search()}>{busy ? '检索中…' : '开始检索'}</button>
    </div>
    {error && <p className="error">{error}</p>}
    {added && <p className="pack-notice">{added}</p>}
    {!workspacePath && <p className="muted">还没有绑定整合包目录；仍可检索，但“加入整合包”需要先在“整合包”面板建立清单。</p>}

    {result && <>
      {result.warnings.map((warning) => <p className="discover-warning" key={warning}>{warning}</p>)}
      <div className="discover-summary">
        <div><span>目标</span><strong>{result.targetId}</strong></div>
        <div><span>覆盖度</span><strong>{percent(result.gap.coverage)}</strong></div>
        <div><span>候选</span><strong>{result.candidates.length}</strong></div>
        <div><span>缺口</span><strong>{result.gap.missing.length}</strong></div>
      </div>

      {result.gap.missing.length > 0 && <div className="discover-gap">
        <h3>还没被满足的能力</h3>
        <p>{result.gap.missing.join('、')}</p>
        {result.gap.authorFromScratch && <p className="discover-warning">没有足够接近的现成模组；下一步是自研或先降低需求，而不是继续换关键词。</p>}
        {result.gap.nearMiss.length > 0 && <>
          <h4>最接近的候选（缺口 = 改造输入）</h4>
          <ul>
            {result.gap.nearMiss.map((candidate) => <li key={`${candidate.registry}:${candidate.projectId}`}>
              <a href={candidate.registry === 'modrinth' ? `https://modrinth.com/mod/${candidate.slug}` : `https://www.curseforge.com/minecraft/mc-mods/${candidate.slug}`} target="_blank" rel="noreferrer">{candidate.title}</a>
              <span>{percent(candidate.coverage)}</span>
              <small>缺：{candidate.missing.join('、') || '—'}</small>
            </li>)}
          </ul>
        </>}
      </div>}

      <div className="discover-results">
        <h3>候选（按相关度、下载量、兼容性排序）</h3>
        {result.candidates.length === 0 && <p className="muted">这次检索没有返回候选。检查目标版本、关键词或网络状态；限流会以警告而不是空结果呈现。</p>}
        {result.candidates.map((candidate) => <article className="discover-candidate" key={`${candidate.registry}:${candidate.projectId}`}>
          <div className="row">
            <strong><a href={registryUrl(candidate)} target="_blank" rel="noreferrer">{candidate.title}</a></strong>
            <span className="badge">{candidate.registry}</span>
            <span className="badge">相关度 {percent(candidate.score)}</span>
            <span className="badge">覆盖 {percent(candidate.coverage)}</span>
            {!candidate.license.redistributable && <span className="badge badge-missing" title="字节不能再分发，只能写下载引用或本地安装">不可再分发</span>}
            <button
              disabled={readOnly || !workspacePath || Boolean(busy) || Boolean(adding)}
              title={workspacePath ? '解析目标版本并写入 pack.json' : '先在整合包面板建立 pack.json'}
              onClick={() => void addCandidate(candidate)}
            >{adding === candidate.projectId ? '加入中…' : '加入整合包'}</button>
          </div>
          <p>{candidate.description || '没有描述'}</p>
          <p className="muted">下载量 {candidate.downloads.toLocaleString()} · 更新于 {candidate.updatedAt.slice(0, 10)} · 许可 {candidate.license.id}</p>
          {candidate.missing.length > 0 && <p className="muted">未覆盖：{candidate.missing.join('、')}</p>}
          <details><summary>评分证据</summary><ul>{candidate.evidence.map((evidence) => <li key={`${evidence.kind}:${evidence.detail}`}>{evidence.kind} · {evidence.detail}（{percent(evidence.weight)}）</li>)}</ul></details>
        </article>)}
      </div>
      <details className="discover-queries"><summary>本次发送的检索词</summary><p>{result.queries.join(' · ')}</p></details>
    </>}
  </section>
}
