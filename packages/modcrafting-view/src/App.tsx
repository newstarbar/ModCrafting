import React, { useEffect, useState } from 'react'
import type { CoreEnvironmentStatus, CoreRuntimeState, FabricProject, GameRuntimeStatus, JobSnapshot, BridgeResult, TaskSession } from '../../modcrafting-core/src/contracts.ts'
import { DEFAULT_TEST_PROFILE, gameTestTemplate, type TestProfile } from '../../modcrafting-core/src/domain.ts'
import { action, request, state, initialProject, initialView, currentSession, selectSession } from './client.ts'
import { IconFolder, IconWrench, IconGamepad, IconPlay, IconSquare as IconStop } from './Icon.tsx'
import { RecipeEditor } from './RecipeEditor.tsx'
import { ContentEditor } from './ContentEditor.tsx'
import { GuiEditor } from './GuiEditor.tsx'
import { TextureStudio } from './TextureStudio.tsx'
import { ModelEditor } from './ModelEditor.tsx'

type Module = 'overview' | 'content' | 'textures' | 'recipe' | 'gui' | 'model' | 'build' | 'game' | 'tests' | 'reports'
const modules: Array<{ id: Module; label: string; icon: string }> = [
  { id: 'overview', label: '概览', icon: '⌂' }, { id: 'content', label: '内容', icon: '◇' }, { id: 'textures', label: '贴图', icon: '▩' }, { id: 'recipe', label: '配方', icon: '▦' },
  { id: 'gui', label: '界面', icon: '▣' }, { id: 'model', label: '模型', icon: '⬡' }, { id: 'build', label: '构建', icon: '⚒' }, { id: 'game', label: '游戏', icon: '▶' },
  { id: 'tests', label: '测试', icon: '✓' }, { id: 'reports', label: '报告', icon: '▤' }
]
const labels: Record<string, string> = { build: '构建', minecraft: 'Minecraft', minecraft_prepare: '准备测试世界', game_test: '游戏测试', running: '进行中', completed: '已完成', failed: '失败', stopped: '已停止', interrupted: '服务重启时中断', present: '已准备', missing: '尚未准备', invalid: '需要更新或修复', PASS: '通过', FAIL: '未通过', INCONCLUSIVE: '暂时无法验证' }
const empty: CoreRuntimeState = { contractVersion: 1, jobs: [], instances: [] }
function Badge({ value }: { value: string }) { return <span title={value} className={`badge badge-${value}`}>{labels[value] || value}</span> }
function download(value: unknown, name: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }))
  const link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
}
function Job({ job, onStop, onReport }: { job: JobSnapshot; onStop: () => void; onReport: () => void }) {
  const verdict = typeof job.result?.verdict === 'string' ? job.result.verdict : ''
  return <article className="job"><div className="row"><strong>{labels[job.kind] || job.kind}</strong><Badge value={job.status} />{verdict && <Badge value={verdict} />}<time>{new Date(job.startedAt).toLocaleTimeString()}</time>
    {job.status === 'running' && <button onClick={onStop}><IconStop size="sm" />停止</button>}{typeof job.result?.reportPath === 'string' && <button onClick={onReport}>查看报告</button>}</div>
    {(job.error || job.code) && <details className="error"><summary>发生了什么？</summary><p>{job.code} · {job.error}</p></details>}
    {job.result?.preparation && <p className="muted">准备阶段：{String((job.result.preparation as Record<string, unknown>).phase || '详情见结果')}</p>}
    {!!job.output.length && <details><summary>诊断日志 · 最近 {job.output.length} 行</summary><pre>{job.output.join('\n')}</pre></details>}
    {!!job.result && <details><summary>执行结果</summary><pre>{JSON.stringify(job.result, null, 2)}</pre></details>}
  </article>
}

export function App() {
  const [sessionId, setSessionId] = useState(currentSession())
  const [path, setPath] = useState(initialProject || sessionStorage.getItem('modcrafting-view-project') || '')
  const [project, setProject] = useState<FabricProject>()
  const [environment, setEnvironment] = useState<CoreEnvironmentStatus>()
  const [runtime, setRuntime] = useState(empty)
  const [instanceId, setInstanceId] = useState('')
  const [game, setGame] = useState<GameRuntimeStatus>()
  const [task, setTask] = useState('build')
  const [profile, setProfile] = useState<TestProfile>(structuredClone(DEFAULT_TEST_PROFILE))
  const [saveProjectDefault, setSaveProjectDefault] = useState(false)
  const [spec, setSpec] = useState(() => JSON.stringify(gameTestTemplate('player_interaction'), null, 2))
  const [snapshot, setSnapshot] = useState<BridgeResult>()
  const [image, setImage] = useState('')
  const [report, setReport] = useState<unknown>()
  const [error, setError] = useState('')
  const [connection, setConnection] = useState('连接中')
  const [pending, setPending] = useState('')
  const [notice, setNotice] = useState('')
  const [followAgent, setFollowAgent] = useState(() => sessionStorage.getItem(`modcrafting-follow:${currentSession()}`) !== 'false')
  const [activeModule, setActiveModule] = useState<Module>(() => (modules.some(value => value.id === initialView) ? initialView : 'overview') as Module)

  const currentTask = runtime.sessions?.find(value => value.sessionId === sessionId)
  const sessionJobs = runtime.jobs.filter(value => value.sessionId === sessionId || !value.sessionId)
  const selected = runtime.instances.find(value => value.instanceId === instanceId && value.sessionId === sessionId)
  const runningGame = selected && sessionJobs.some(value => value.id === selected.jobId && value.status === 'running')
  const worldName = snapshot?.data.worldName

  async function refresh() {
    const value = await state(); setRuntime(value); setConnection('工作台已连接')
    setInstanceId(current => current && value.instances.some(row => row.instanceId === current) ? current : value.instances.at(-1)?.instanceId || '')
    const session = value.sessions?.find(row => row.sessionId === sessionId)
    if (followAgent && session?.recommendedModules[0] && modules.some(row => row.id === session.recommendedModules[0])) setActiveModule(session.recommendedModules[0] as Module)
  }
  useEffect(() => {
    let active = true, busy = false
    const poll = async () => { if (busy) return; busy = true; try { const value = await state(); if (!active) return; setRuntime(value); setConnection('工作台已连接'); const session = value.sessions?.find(row => row.sessionId === sessionId); if (followAgent && session?.recommendedModules[0] && modules.some(row => row.id === session.recommendedModules[0])) setActiveModule(session.recommendedModules[0] as Module); setInstanceId(current => current && value.instances.some(row => row.instanceId === current) ? current : value.instances.at(-1)?.instanceId || '') } catch (cause) { if (active) setConnection(`连接中断：${String(cause)}`) } finally { busy = false } }
    void poll(); const timer = setInterval(poll, 1800)
    return () => { active = false; clearInterval(timer) }
  }, [sessionId, followAgent])

  useEffect(() => {
    setProject(undefined); setEnvironment(undefined); setGame(undefined); setSnapshot(undefined); setImage(''); setReport(undefined); setInstanceId('')
    const session = runtime.sessions?.find(value => value.sessionId === sessionId)
    if (session?.projectPath) { setPath(session.projectPath); sessionStorage.setItem('modcrafting-view-project', session.projectPath) }
    setActiveModule(session?.status === 'ended' ? 'reports' : (session?.recommendedModules[0] as Module) || 'overview')
    setFollowAgent(sessionStorage.getItem(`modcrafting-follow:${sessionId}`) !== 'false')
    if (session?.projectPath && session.status !== 'ended') void loadProfile(session.projectPath)
  }, [sessionId])

  useEffect(() => {
    if (!currentTask?.projectPath) return
    setPath(currentTask.projectPath); sessionStorage.setItem('modcrafting-view-project', currentTask.projectPath)
    if (currentTask.status !== 'ended' && project?.path !== currentTask.projectPath) void loadProfile(currentTask.projectPath)
  }, [currentTask?.sessionId, currentTask?.projectPath, currentTask?.status])

  useEffect(() => {
    setGame(undefined); setSnapshot(undefined); setImage('')
    if (!instanceId || currentTask?.status === 'ended') return
    let active = true, busy = false
    const poll = async () => { if (busy) return; busy = true; try { const value = await action<GameRuntimeStatus>({ operation: 'runtime', ...(instanceId ? { instanceId } : {}) }); if (active) setGame(value) } catch { if (active) setGame(undefined) } finally { busy = false } }
    void poll(); const timer = setInterval(poll, 2500)
    return () => { active = false; clearInterval(timer) }
  }, [instanceId, sessionId, currentTask?.status])

  async function run(name: string, work: () => Promise<void>) {
    setPending(name); setError(''); setNotice('')
    try { await work(); await refresh() } catch (cause) { if (!(cause instanceof DOMException && cause.name === 'AbortError')) setError(String(cause)) } finally { setPending('') }
  }
  async function open() {
    const value = await action<{ project: FabricProject }>({ operation: 'project', projectPath: path.trim() })
    setProject(value.project); sessionStorage.setItem('modcrafting-view-project', value.project.path)
    setEnvironment(await action({ operation: 'environment', projectPath: value.project.path }))
    if (value.project.valid) await loadProfile(value.project.path)
  }
  async function loadProfile(projectPath?: string) {
    const value = await action<{ profile: TestProfile }>({ operation: 'profile_read', ...(projectPath ? { projectPath } : {}) })
    setProfile(value.profile)
  }
  useEffect(() => { if (path.trim() && currentTask && currentTask.status !== 'ended') void run('恢复工程', open) }, [currentTask?.sessionId, currentTask?.status])

  async function switchSession(next: string) {
    if (!next || next === sessionId) return
    setPending('切换会话')
    try { const readOnly = await selectSession(next); setSessionId(next); setError(''); setNotice(readOnly ? '已切换到已结束任务，只能查看历史报告。' : '已切换到所选任务会话。') }
    catch (cause) { setError(String(cause)) }
    finally { setPending('') }
  }
  function navigate(module: Module) { setActiveModule(module); setFollowAgent(false); sessionStorage.setItem(`modcrafting-follow:${sessionId}`, 'false') }
  function follow() { setFollowAgent(true); sessionStorage.setItem(`modcrafting-follow:${sessionId}`, 'true'); const recommendation = currentTask?.recommendedModules[0] as Module | undefined; setActiveModule(recommendation && modules.some(row => row.id === recommendation) ? recommendation : 'overview') }
  const connected = connection === '工作台已连接', readOnly = currentTask?.status === 'ended', disabled = Boolean(pending) || !connected || readOnly

  function overview() { return <>
    {!project && <section className="panel"><h2>先选择工程</h2><p className="muted">描述任务后，Agent 可以为当前会话创建或关联工程；已有工程可从下面打开。</p></section>}
    <section className="panel"><h2><IconFolder />工程与环境</h2>
      <form className="row project-form" onSubmit={event => { event.preventDefault(); void run('检查工程', open) }}><label className="grow">Fabric 工程路径<input value={path} onChange={event => setPath(event.target.value)} placeholder="输入工程文件夹绝对路径" /></label><button className="primary" disabled={disabled || !path.trim()}>打开工程</button></form>
      {project && <div className="project-info"><strong>{project.modId || '未识别 mod ID'}</strong><Badge value={project.valid ? 'PASS' : 'FAIL'} /><span>{project.minecraftVersion}</span><code>{project.path}</code>{project.errors.map(value => <p className="error" key={value}>{value}</p>)}</div>}
      <div className="row"><button disabled={disabled} onClick={() => void run('检查环境', async () => setEnvironment(await action({ operation: 'environment', projectPath: project?.path })))}>刷新环境</button><button disabled={disabled} onClick={() => void run('准备资料', async () => { const value = await action<{ ok: boolean }>({ operation: 'prepare', projectPath: project?.path }); setNotice(value.ok ? '离线知识资料已准备好。游戏测试组件随插件提供。' : '部分资料未准备好，请查看环境信息。'); setEnvironment(await action({ operation: 'environment', projectPath: project?.path })) })}>准备离线资料</button></div>
      {environment && <details className="environment-details"><summary>环境详情</summary><div className="checks"><div><span>系统 JDK 21</span><Badge value={environment.java.ok ? 'PASS' : 'FAIL'} /><small>{environment.java.version || environment.java.error}</small></div><div><span>工程 Wrapper</span><Badge value={environment.gradleWrapper ? 'PASS' : 'FAIL'} /></div><div><span>游戏测试桥</span><Badge value={game?.bridgeReady ? 'PASS' : 'INCONCLUSIVE'} /><small>{game?.bridgeReady ? '已连接；仍需等世界准备完成' : '等待 Minecraft 启动'}</small></div></div>{environment.remediation.map(value => <p className="error" key={value}>{value}</p>)}<details><summary>资源目录</summary><code>{environment.paths.dataRoot}</code>{environment.assets.map(value => <div className="row asset" key={value.name}><strong>{value.name}</strong><Badge value={value.status} /><code>{value.path}</code></div>)}</details></details>}
    </section>
    <section className="panel"><h2>当前任务</h2><p>{currentTask?.phase || '等待 Agent 更新任务状态'}</p><p className="muted">推荐工作区：{currentTask?.recommendedModules.map(id => modules.find(row => row.id === id)?.label || id).join('、') || '概览'}</p><div className="row"><button onClick={() => navigate('content')}>编辑内容</button><button onClick={() => navigate('game')}>准备游戏</button><button onClick={() => navigate('reports')}>查看本会话报告</button></div></section>
  </> }

  function buildView() { return <>
    <section className="panel"><h2><IconWrench />构建模组</h2><p className="muted">使用工程自带 Wrapper。相同工程的构建会排队，避免两个会话同时改写 build 目录。</p><div className="row"><label className="grow">Gradle 任务<input value={task} onChange={event => setTask(event.target.value)} /></label><button className="primary" disabled={disabled || !project?.valid} onClick={() => void run('启动构建', async () => { await action({ operation: 'build', projectPath: project!.path, task }) })}><IconPlay size="sm" />开始构建</button></div></section>
    <section className="panel"><h2>构建任务</h2>{sessionJobs.filter(job => job.kind === 'build').toReversed().map(job => <Job key={job.id} job={job} onStop={() => void run('停止任务', async () => { await action({ operation: 'stop', jobId: job.id }) })} onReport={() => {}} />)}</section>
  </> }

  function gameView() { return <>
    <section className="panel"><h2><IconGamepad />测试游戏</h2><p>启动会使用当前会话的独立游戏目录，并自动处理首次启动提示，准备专用测试世界。游戏桥接连上后，仍需等“可以开始测试”。</p>
      <div className="row"><button className="primary" disabled={disabled || !project?.valid || Boolean(runningGame)} onClick={() => void run('准备测试游戏', async () => { const value = await action<{ instanceId: string; preparationJobId: string }>({ operation: 'run', projectPath: project!.path }); setInstanceId(value.instanceId); setNotice(`已启动准备作业 ${value.preparationJobId}`) })}><IconPlay size="sm" />启动并准备测试世界</button><button disabled={disabled || !selected || !runningGame} onClick={() => void run('停止游戏', async () => { await action({ operation: 'stop', jobId: selected!.jobId }) })}><IconStop size="sm" />停止当前游戏</button></div>
      {game && <div className="preparation-card"><div className="row"><strong>准备进度</strong><Badge value={game.canRunTests ? 'PASS' : game.preparation.phase === 'failed' ? 'FAIL' : 'running'} /><span>{game.preparation.phase}</span></div>{game.preparation.blockedReason && <p className="error">{game.preparation.blockedReason}</p>}{game.preparation.screen && <p className="muted">当前界面：{String(game.preparation.screen.simpleName || game.preparation.screen.kind || '读取中')}</p>}{game.message && !game.canRunTests && <p className="muted">{game.message}</p>}<p>{game.canRunTests ? '专用测试世界已就绪，可以进入“测试”运行场景。' : '准备过程中不需要重复启动客户端。'}</p></div>}
    </section>
    <section className="panel profile-panel"><h2>本会话的游戏设置</h2><p className="muted">修改后下次启动生效，不会改动正在运行的游戏。测试地图和复制存档都保存在当前会话目录。</p>
      <div className="profile-grid"><label>游戏语言<select value={profile.language} onChange={event => setProfile(old => ({ ...old, language: event.target.value as TestProfile['language'] }))}><option value="zh_cn">简体中文</option><option value="en_us">English</option></select></label>
        <label>窗口分辨率<select value={`${profile.window.width}x${profile.window.height}`} onChange={event => { const [width, height] = event.target.value.split('x').map(Number); setProfile(old => ({ ...old, window: { width, height } })) }}>{['1280x720', '1600x900', '1920x1080'].map(value => <option key={value}>{value}</option>)}</select></label>
        <label>视距（区块）<input type="number" min={2} max={32} value={profile.renderDistance} onChange={event => setProfile(old => ({ ...old, renderDistance: Number(event.target.value) }))} /></label><label>最高帧率<input type="number" min={30} max={240} value={profile.maxFps} onChange={event => setProfile(old => ({ ...old, maxFps: Number(event.target.value) }))} /></label>
        <label>主音量（%）<input type="number" min={0} max={100} value={profile.volumePercent} onChange={event => setProfile(old => ({ ...old, volumePercent: Number(event.target.value) }))} /></label>
        <label>地图来源<select value={profile.map.source} onChange={event => setProfile(old => ({ ...old, map: { ...old.map, source: event.target.value as TestProfile['map']['source'] } }))}><option value="generated">新建测试地图</option><option value="save_copy">复制现有存档（原存档只读）</option></select></label>
        <label>地图地形<select disabled={profile.map.source === 'save_copy'} value={profile.map.terrain} onChange={event => setProfile(old => ({ ...old, map: { ...old.map, terrain: event.target.value as TestProfile['map']['terrain'] } }))}><option value="flat">平地</option><option value="normal">普通地形</option></select></label>
        <label>地图种子<input disabled={profile.map.source === 'save_copy'} value={profile.map.seed} onChange={event => setProfile(old => ({ ...old, map: { ...old.map, seed: event.target.value } }))} /></label>
        {profile.map.source === 'save_copy' && <label className="wide">要复制的存档目录<input value={profile.map.sourcePath || ''} onChange={event => setProfile(old => ({ ...old, map: { ...old.map, sourcePath: event.target.value } }))} placeholder="包含 level.dat 的存档目录" /></label>}
        <label>游戏模式<select value={profile.gameMode} onChange={event => setProfile(old => ({ ...old, gameMode: event.target.value as TestProfile['gameMode'] }))}><option value="creative">创造</option><option value="survival">生存</option><option value="adventure">冒险</option></select></label>
        <label>难度<select value={profile.difficulty} onChange={event => setProfile(old => ({ ...old, difficulty: event.target.value as TestProfile['difficulty'] }))}>{[['peaceful', '和平'], ['easy', '简单'], ['normal', '普通'], ['hard', '困难']].map(([id, title]) => <option key={id} value={id}>{title}</option>)}</select></label>
      </div>
      <label className="check"><input type="checkbox" checked={profile.allowCommands} onChange={event => setProfile(old => ({ ...old, allowCommands: event.target.checked }))} />允许测试命令</label>
      <label className="check"><input type="checkbox" checked={saveProjectDefault} onChange={event => setSaveProjectDefault(event.target.checked)} />保存为此工程默认配置</label>
      <button disabled={disabled} onClick={() => void run('保存测试设置', async () => { const value = await action<{ savedAsProjectDefault: boolean }>({ operation: 'profile_write', projectPath: project?.path, profile, saveAsProjectDefault: saveProjectDefault }); setNotice(value.savedAsProjectDefault ? '已保存本会话设置，并更新工程默认配置。' : '已保存本会话设置；下次启动时生效。') })}>保存设置</button>
      {selected && <details><summary>实例信息</summary><p>{selected.projectPath}</p><code>{selected.gameDirectory}</code><p>实例 ID：{selected.instanceId}</p></details>}
    </section>
  </> }

  function testsView() { return <>
    <section className="panel"><h2>游戏内验证</h2><p>先等游戏准备状态变为“可开始测试”。如果准备失败，页面会显示停在哪一步、游戏画面和处理建议。</p><div className="row"><Badge value={game?.canRunTests ? 'PASS' : game?.preparation.phase === 'failed' ? 'FAIL' : 'INCONCLUSIVE'} /><span>{game?.canRunTests ? '可以开始测试' : game?.message || '测试环境尚未就绪'}</span><button disabled={disabled || !game?.canRunTests} onClick={() => void run('获取游戏快照', async () => { setSnapshot(await action({ operation: 'snapshot', ...(instanceId ? { instanceId } : {}) })) })}>刷新快照</button><button disabled={disabled || !game?.bridgeReady} onClick={() => void run('获取游戏截图', async () => { const value = await action<{ image: string }>({ operation: 'screenshot', ...(instanceId ? { instanceId } : {}) }); setImage(value.image) })}>截图</button></div>
      {snapshot && <details><summary>快照 · {String(worldName || '读取中')}</summary><pre>{JSON.stringify(snapshot.data, null, 2)}</pre></details>}{image && <figure><img src={image} alt="Minecraft 当前游戏画面" /><figcaption>截图用于辅助查看，不单独代表测试通过。</figcaption></figure>}
      <div className="row"><button disabled={disabled} onClick={() => void run('读取测试模板', async () => { const value = await action<{ spec: unknown }>({ operation: 'template', featureType: 'player_interaction' }); setSpec(JSON.stringify(value.spec, null, 2)) })}>恢复有效模板</button><button disabled={disabled || !game?.canRunTests} onClick={() => void run('运行游戏测试', async () => { await action({ operation: 'test', ...(instanceId ? { instanceId } : {}), spec: JSON.parse(spec) }) })}>运行测试</button></div>
      <label className="spec">测试场景<textarea value={spec} onChange={event => setSpec(event.target.value)} spellCheck={false} rows={15} /></label>
    </section>
    <section className="panel"><h2>本会话测试任务</h2>{sessionJobs.filter(job => job.kind === 'minecraft_prepare' || job.kind === 'game_test').toReversed().map(job => <Job key={job.id} job={job} onStop={() => void run('停止任务', async () => { await action({ operation: 'stop', jobId: job.id }) })} onReport={() => void run('读取报告', async () => setReport(await request(`/api/report/${encodeURIComponent(job.id)}`))) } />)}</section>
  </> }

  function reportsView() { return <section className="panel"><h2>当前会话报告</h2><p className="muted">只显示这个任务会话的测试结果与诊断记录。</p>{sessionJobs.filter(job => job.kind === 'game_test').toReversed().map(job => <Job key={job.id} job={job} onStop={() => void run('停止任务', async () => { await action({ operation: 'stop', jobId: job.id }) })} onReport={() => void run('读取报告', async () => setReport(await request(`/api/report/${encodeURIComponent(job.id)}`))) } />)}{!sessionJobs.some(job => job.kind === 'game_test') && <p className="muted">这个会话还没有测试报告。</p>}{report !== undefined && <div className="report"><div className="row"><h3>测试报告</h3><button onClick={() => download(report, 'modcrafting-game-test.json')}>下载 JSON</button><button onClick={() => setReport(undefined)}>收起</button></div><pre>{JSON.stringify(report, null, 2)}</pre></div>}</section> }

  function jobsView() { return <section className="panel"><h2>本会话构建</h2>{sessionJobs.filter(job => job.kind === 'build').toReversed().map(job => <Job key={job.id} job={job} onStop={() => void run('停止任务', async () => { await action({ operation: 'stop', jobId: job.id }) })} onReport={() => {}} />)}</section> }
  const moduleContent = (() => {
    if (activeModule === 'overview') return overview()
    if (activeModule === 'content') return project?.valid ? <ContentEditor key={`${sessionId}:content:${project.path}`} projectPath={project.path} modId={project.modId!} /> : <section className="panel"><h2>内容工作区</h2><p>请先关联一个有效工程。</p></section>
    if (activeModule === 'textures') return project?.valid ? <TextureStudio key={`${sessionId}:textures:${project.path}`} projectPath={project.path} modId={project.modId!} /> : <section className="panel"><h2>贴图工作区</h2><p>请先关联一个有效工程。</p></section>
    if (activeModule === 'recipe') return project?.valid ? <RecipeEditor key={`${sessionId}:recipe:${project.path}`} projectPath={project.path} modId={project.modId!} /> : <section className="panel"><h2>配方工作区</h2><p>请先关联一个有效工程。</p></section>
    if (activeModule === 'gui') return project?.valid ? <GuiEditor key={`${sessionId}:gui:${project.path}`} projectPath={project.path} modId={project.modId!} /> : <section className="panel"><h2>界面工作区</h2><p>请先关联一个有效工程。</p></section>
    if (activeModule === 'model') return project?.valid ? <ModelEditor key={`${sessionId}:model:${project.path}`} projectPath={project.path} modId={project.modId!} /> : <section className="panel"><h2>模型工作区</h2><p>请先关联一个有效工程。</p></section>
    if (activeModule === 'build') return buildView()
    if (activeModule === 'game') return gameView()
    if (activeModule === 'tests') return testsView()
    return reportsView()
  })()

  return <>
    <header className="workbench-header"><div className="brand"><span className="brand-mark">M</span><div><strong>ModCrafting</strong><span>Fabric 工作台</span></div></div>
      <div className="task-bar"><label>任务会话<select aria-label="任务会话" value={sessionId} onChange={event => void switchSession(event.target.value)}>{(runtime.sessions || []).map((value: TaskSession) => <option key={value.sessionId} value={value.sessionId}>{value.name}{value.status === 'ended' ? ' · 已结束' : ''} · {value.phase}</option>)}</select></label><div><strong>{currentTask?.name || '当前任务'}</strong><small>{project?.modId || currentTask?.projectPath || '未关联工程'} · {sessionId.slice(0, 8)}</small></div></div>
      <div className="header-state"><span className={connected ? 'connected' : 'error'} role="status">● {readOnly ? '已结束 · 只读' : connection}</span><button disabled={readOnly} aria-pressed={followAgent} onClick={followAgent ? () => { setFollowAgent(false); sessionStorage.setItem(`modcrafting-follow:${sessionId}`, 'false') } : follow}>{followAgent ? '跟随 Agent：开' : '跟随 Agent：关'}</button></div>
    </header>
    {error && <div role="alert" className="message error top-message">{error}<button onClick={() => setError('')}>收起</button></div>}
    {(pending || notice) && <div role="status" className="message top-message">{pending ? `${pending}…` : notice}</div>}
    <div className="workbench-shell"><aside className="workbench-sidebar" aria-label="工作区导航"><p className="eyebrow">工作区</p>{modules.map(row => <button key={row.id} aria-current={activeModule === row.id ? 'page' : undefined} onClick={() => navigate(row.id)}><span aria-hidden>{row.icon}</span>{row.label}{currentTask?.recommendedModules.includes(row.id) && <i title="Agent 当前推荐" />}</button>)}<details><summary>更多工具</summary><p className="muted">知识库和 Fabric 工具由聊天 Agent 按任务调用。日志收在页面底部的诊断区。</p></details></aside>
      <main className="workbench-main"><div className="module-heading"><div><p className="eyebrow">{project?.minecraftVersion ? `FABRIC ${project.minecraftVersion}` : 'MODCRAFTING FABRIC'}</p><h1>{modules.find(row => row.id === activeModule)?.label}</h1></div><div><strong>{currentTask?.phase || '等待任务阶段'}</strong><small>Agent 推荐：{currentTask?.recommendedModules.map(id => modules.find(row => row.id === id)?.label || id).join('、') || '概览'}</small></div></div>
        {moduleContent}
        <details className="panel diagnostics"><summary>诊断与日志 · {sessionJobs.length} 个会话任务</summary>{sessionJobs.toReversed().map(job => <Job key={job.id} job={job} onStop={() => void run('停止任务', async () => { await action({ operation: 'stop', jobId: job.id }) })} onReport={() => void run('读取报告', async () => setReport(await request(`/api/report/${encodeURIComponent(job.id)}`))) } />)}</details>
      </main>
    </div>
    <nav className="mobile-nav" aria-label="工作区导航"><label>当前模块<select value={activeModule} onChange={event => navigate(event.target.value as Module)}>{modules.map(value => <option key={value.id} value={value.id}>{value.label}</option>)}</select></label></nav>
    <footer>ModCrafting Core · 关闭页面不会停止本会话作业 · 报告按会话隔离</footer>
  </>
}
