import { useState } from 'react'
import { PanelEmptyState } from '../../shell/PanelState.tsx'
import { action } from '../../client.ts'

interface BridgeResult {
  ok: true
  projectPath: string
  modId: string
  modName: string
  packageName: string
  entrypoint: string
  mixinConfig: string
  targetId: string
  loaderVersion: string
  sourceModId: string
  targetModId: string
  files: string[]
  notes: string[]
}

/**
 * A bridge is a code-generation step, not a config editor: the panel collects the
 * two peer mod ids and one destination, then shows exactly what was written. The
 * generated project is a normal Gradle project from then on — the agent or the
 * user continues it with the existing build/test panels.
 */
export function BridgePanel({ workspacePath, readOnly }: { workspacePath: string; readOnly: boolean }) {
  const [projectPath, setProjectPath] = useState('')
  const [modId, setModId] = useState('')
  const [modName, setModName] = useState('')
  const [sourceModId, setSourceModId] = useState('')
  const [sourceModName, setSourceModName] = useState('')
  const [targetModId, setTargetModId] = useState('')
  const [targetModName, setTargetModName] = useState('')
  const [result, setResult] = useState<BridgeResult>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const base = workspacePath.replace(/[\\/]+$/, '')
  const destination = projectPath.trim() || (modId.trim() ? `${base}/bridges/${modId.trim()}` : '')
  const validIds = /^[a-z][a-z0-9_-]{1,63}$/.test(modId.trim())
    && /^[a-z][a-z0-9_-]{1,63}$/.test(sourceModId.trim())
    && /^[a-z][a-z0-9_-]{1,63}$/.test(targetModId.trim())
    && sourceModId.trim() !== targetModId.trim()
  const disabled = readOnly || busy || !workspacePath || !destination || !validIds || !modName.trim()

  async function scaffold(): Promise<void> {
    setBusy(true); setError(''); setResult(undefined)
    try {
      setResult(await action<BridgeResult>({
        operation: 'bridge_scaffold',
        request: {
          workspacePath,
          projectPath: destination,
          modId: modId.trim(),
          modName: modName.trim(),
          sourceModId: sourceModId.trim(),
          ...(sourceModName.trim() ? { sourceModName: sourceModName.trim() } : {}),
          targetModId: targetModId.trim(),
          ...(targetModName.trim() ? { targetModName: targetModName.trim() } : {})
        }
      }))
    } catch (cause) {
      setError(String(cause))
    } finally {
      setBusy(false)
    }
  }

  if (!workspacePath) {
    return <PanelEmptyState
      icon="⇄"
      title="桥接模组"
      description="先绑定整合包目录。桥接工程会读取整合包的目标版本，并生成到包内或仓库内的新目录；它不会修改两个模组的 jar。"
      hint="桥接工程只生成 Fabric 源码；适配器是唯一需要补完的地方。"
    />
  }

  return <section className="panel bridge-workspace">
    <p className="eyebrow">BRIDGE SCAFFOLD</p>
    <h2>桥接模组</h2>
    <p className="muted">当两个模组的事件或注册表形状对不上时，桥接工程把适配点集中到一个 <code>BridgeAdapter</code>。生成物可编译；先补 <code>onRegister()</code>（注册表适配）和 <code>onServerStarting()</code>（事件适配），再按普通工程构建测试。</p>

    <div className="bridge-form">
      <label className="wide">工程目录<input value={projectPath} onChange={(event) => setProjectPath(event.target.value)} placeholder={destination || '留空则使用 <整合包>/bridges/<modId>'} /></label>
      <label>桥接 Mod ID<input value={modId} onChange={(event) => setModId(event.target.value)} placeholder="例如：create_ae2_bridge" /></label>
      <label>显示名称<input value={modName} onChange={(event) => setModName(event.target.value)} placeholder="例如：Create × AE2 桥接" /></label>
      <label>源模组 ID<input value={sourceModId} onChange={(event) => setSourceModId(event.target.value)} placeholder="提供事件/内容的一方" /></label>
      <label>源模组名称<input value={sourceModName} onChange={(event) => setSourceModName(event.target.value)} placeholder="可留空" /></label>
      <label>目标模组 ID<input value={targetModId} onChange={(event) => setTargetModId(event.target.value)} placeholder="需要接收适配的一方" /></label>
      <label>目标模组名称<input value={targetModName} onChange={(event) => setTargetModName(event.target.value)} placeholder="可留空" /></label>
    </div>
    <div className="row bridge-actions">
      <button className="primary" disabled={disabled} onClick={() => void scaffold()}>{busy ? '生成中…' : '生成桥接工程'}</button>
      <span className="muted">只写入新目录；已存在且非空的目录会被拒绝。</span>
    </div>
    {error && <p className="error">{error}</p>}

    {result && <div className="bridge-result">
      <h3>已生成 {result.modName}</h3>
      <p><code>{result.projectPath}</code></p>
      <div className="pack-summary">
        <div><span>目标</span><strong>{result.targetId}</strong></div>
        <div><span>入口点</span><strong>{result.entrypoint}</strong></div>
        <div><span>Mixin 配置</span><strong>{result.mixinConfig}</strong></div>
        <div><span>加载器</span><strong>{result.loaderVersion}</strong></div>
      </div>
      <p className="muted">源：{result.sourceModId} · 目标：{result.targetModId}</p>
      <details open><summary>生成的文件 · {result.files.length}</summary><ul>{result.files.map((file) => <li key={file}><code>{file}</code></li>)}</ul></details>
      <details><summary>下一步</summary><ul>{result.notes.map((note) => <li key={note}>{note}</li>)}</ul></details>
    </div>}
  </section>
}
