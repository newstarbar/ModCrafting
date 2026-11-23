import React, { useEffect, useMemo, useState } from 'react'
import { questAction, questBook } from '../../client.ts'
import { NodeGraph, type GraphEdge, type GraphNode } from '../../graph/NodeGraph.tsx'
import { freeSlot } from '../../graph/layout.ts'
import { SplitPane } from '../../shell/SplitPane.tsx'
import { TreeView, type TreeNode } from '../../shell/TreeView.tsx'
import {
  QUEST_SHAPES,
  QUEST_SHAPE_LABELS,
  type ChapterSummary,
  type QuestBookDetail,
  type QuestOpInput,
  type QuestShape,
  type QuestSummary
} from './types.ts'

const STORAGE_KEY = 'modcrafting-quest-workspace'

/**
 * FTB Quests book editor.
 *
 * Three columns: chapter tree, dependency graph, inspector. Every edit becomes an
 * operation in a pending list; nothing touches the disk until "保存", which runs
 * preview → save so the revision check happens against the exact state the user
 * saw.
 */
export function QuestPanel({ workspacePath, memberId, readOnly }: {
  workspacePath: string
  memberId?: string
  readOnly: boolean
}) {
  const [input, setInput] = useState(workspacePath || sessionStorage.getItem(STORAGE_KEY) || '')
  const [path, setPath] = useState(workspacePath)
  const [book, setBook] = useState<QuestBookDetail>()
  const [chapterFile, setChapterFile] = useState('')
  const [questId, setQuestId] = useState('')
  const [ops, setOps] = useState<QuestOpInput[]>([])
  const [moved, setMoved] = useState<Record<string, { x: number; y: number }>>({})
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    if (workspacePath && workspacePath !== path) void load(workspacePath)
    // Loading on an explicit workspace change only; the path state follows it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspacePath])

  async function load(target = path) {
    const trimmed = target.trim()
    if (!trimmed) { setError('先填入整合包目录。'); return }
    setBusy(true); setError(''); setNotice('')
    try {
      const value = await questBook(trimmed, memberId)
      setBook(value.book)
      setPath(trimmed)
      sessionStorage.setItem(STORAGE_KEY, trimmed)
      setChapterFile((current) => value.book.chapters.some((chapter) => chapter.file === current) ? current : value.book.chapters[0]?.file ?? '')
      setQuestId('')
      setOps([]); setMoved({})
    } catch (cause) {
      setBook(undefined)
      setError(String(cause))
    } finally { setBusy(false) }
  }

  const chapter: ChapterSummary | undefined = book?.chapters.find((value) => value.file === chapterFile)
  const quest: QuestSummary | undefined = chapter?.quests.find((value) => value.id === questId)

  useEffect(() => {
    if (!quest) { setTitle(''); setDescription(''); return }
    setTitle(quest.title)
    setDescription(quest.description.join('\n'))
    // Re-seed the draft only when the selection or the loaded revision changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quest?.id, book?.revision])

  const treeNodes: TreeNode[] = useMemo(() => {
    if (!book) return []
    const grouped = new Map<string, ChapterSummary[]>()
    for (const chapter of book.chapters) {
      const list = grouped.get(chapter.groupId) ?? []
      list.push(chapter)
      grouped.set(chapter.groupId, list)
    }
    return [...grouped.entries()].map(([groupId, chapters]) => ({
      id: `group:${groupId}`,
      label: book.groups.find((group) => group.id === groupId)?.title || (groupId ? groupId : '未分组'),
      badge: String(chapters.length),
      children: chapters.map((chapter) => ({
        id: chapter.file,
        label: chapter.title,
        badge: chapter.problems.length ? `${chapter.problems.length} 问题` : String(chapter.quests.length),
        ...(chapter.problems.length ? { tone: 'error' as const } : {})
      }))
    }))
  }, [book])

  const nodes: GraphNode[] = useMemo(() => (chapter?.quests ?? []).map((quest) => ({
    id: quest.id,
    title: quest.title || quest.id.slice(-4),
    x: moved[quest.id]?.x ?? quest.x,
    y: moved[quest.id]?.y ?? quest.y,
    size: quest.size,
    tasks: quest.tasks.length,
    problem: chapter?.problems.find((problem) => problem.includes(quest.id))
  })), [chapter, moved])

  const edges: GraphEdge[] = useMemo(() => (chapter?.quests ?? []).flatMap((quest) =>
    quest.dependencies.map((dependency) => ({
      from: dependency,
      to: quest.id,
      missing: !chapter?.quests.some((candidate) => candidate.id === dependency)
    }))
  ), [chapter])

  const pending = ops.length

  function pushMove(id: string, x: number, y: number) {
    if (!chapter) return
    setMoved((current) => ({ ...current, [id]: { x, y } }))
    setOps((current) => [
      ...current.filter((operation) => !(operation.op === 'move' && operation.questId === id)),
      { op: 'move', chapter: chapter.file, questId: id, x, y }
    ])
  }

  function applyText() {
    if (!chapter || !quest || !book) return
    const lines = description.split('\n')
    while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop()
    setOps((current) => [
      ...current.filter((operation) => !(operation.op === 'set_text' && operation.questId === quest.id)),
      { op: 'set_text', locale: book.locale, questId: quest.id, title: title.trim(), description: lines }
    ])
    setNotice('标题与描述已加入待保存修改。')
  }

  function addQuest(x: number, y: number) {
    if (!chapter || readOnly) return
    const occupied = chapter.quests.map((quest) => moved[quest.id] ?? { x: quest.x, y: quest.y })
    // Use the requested slot unless a quest already sits there; then take the nearest
    // free one so the new node is never buried under an existing quest.
    const taken = occupied.some((point) => Math.abs(point.x - x) < 1 && Math.abs(point.y - y) < 1)
    const slot = taken ? freeSlot(occupied) : { x, y }
    setOps((current) => [...current, { op: 'add_quest', chapter: chapter.file, x: slot.x, y: slot.y }])
    setNotice('新任务已加入待保存修改；保存后才能在画布上选中它。')
  }

  async function save() {
    if (!book || ops.length === 0) return
    setBusy(true); setError(''); setNotice('')
    try {
      const previewed = await questAction<{ previewRevision: string }>({
        action: 'preview',
        workspacePath: path,
        ...(memberId ? { memberId } : {}),
        expectedRevision: book.revision,
        ops
      })
      await questAction({
        action: 'save',
        workspacePath: path,
        ...(memberId ? { memberId } : {}),
        expectedRevision: book.revision,
        previewRevision: previewed.previewRevision,
        ops
      })
      setNotice(`已保存 ${ops.length} 项修改。`)
      setOps([]); setMoved({})
      await load(path)
    } catch (cause) {
      setError(String(cause))
    } finally { setBusy(false) }
  }

  if (!book) {
    return <section className="panel quest-launch">
      <h2>任务书</h2>
      <p className="muted">读取整合包里的 <code>config/ftbquests/quests</code>。整合包需要安装 FTB Quests，并在游戏里至少打开过一次任务书。</p>
      <form className="row" onSubmit={(event) => { event.preventDefault(); void load(input) }}>
        <label className="grow">整合包目录<input value={input} onChange={(event) => setInput(event.target.value)} placeholder="整合包根目录的绝对路径" /></label>
        <button className="primary" type="submit" disabled={busy || !input.trim()}>{busy ? '读取中…' : '加载任务书'}</button>
      </form>
      {error && <p className="error">{error}</p>}
    </section>
  }

  const inspector = <div className="quest-inspector">
    {!quest ? <p className="muted">在画布上选择一个任务，或双击空白处新建。</p> : <>
      <h2>{quest.title || '未命名任务'}</h2>
      <p className="muted"><code>{quest.id}</code> · {quest.tasks.length} 个完成条件 · {quest.rewards.length} 个奖励</p>
      <label className="quest-field">标题<input value={title} disabled={readOnly} onChange={(event) => setTitle(event.target.value)} /></label>
      <label className="quest-field">描述（每行一段）<textarea rows={6} value={description} disabled={readOnly} onChange={(event) => setDescription(event.target.value)} /></label>
      <div className="row">
        <button type="button" disabled={readOnly} onClick={applyText}>加入修改</button>
        <button type="button" disabled={readOnly || !chapter} onClick={() => {
          if (!chapter) return
          setOps((current) => [...current, { op: 'remove_quest', chapter: chapter.file, questId: quest.id }])
          setQuestId('')
          setNotice('删除已加入待保存修改。')
        }}>删除任务</button>
      </div>

      <h3>依赖</h3>
      {quest.dependencies.length === 0 && <p className="muted">没有前置任务。</p>}
      <ul className="quest-deps">
        {quest.dependencies.map((dependency) => <li key={dependency}>
          <code>{chapter?.quests.find((candidate) => candidate.id === dependency)?.title || dependency}</code>
          <button type="button" disabled={readOnly} onClick={() => {
            if (!chapter) return
            setOps((current) => [...current, { op: 'remove_dependency', chapter: chapter.file, questId: quest.id, dependsOn: dependency }])
            setNotice('依赖移除已加入待保存修改。')
          }}>移除</button>
        </li>)}
      </ul>
      {chapter && chapter.quests.length > 1 && <label className="quest-field">添加前置
        <select disabled={readOnly} value="" onChange={(event) => {
          const dependsOn = event.target.value
          if (!dependsOn) return
          setOps((current) => [...current, { op: 'add_dependency', chapter: chapter.file, questId: quest.id, dependsOn }])
          setNotice('依赖添加已加入待保存修改。')
        }}>
          <option value="">选择同章节的任务…</option>
          {chapter.quests.filter((candidate) => candidate.id !== quest.id && !quest.dependencies.includes(candidate.id))
            .map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.title || candidate.id}</option>)}
        </select>
      </label>}

      <h3>外观</h3>
      <label className="quest-field">形状
        <select disabled={readOnly} value={quest.shape ?? 'square'} onChange={(event) => {
          if (!chapter) return
          setOps((current) => [...current, { op: 'set_shape', chapter: chapter.file, questId: quest.id, shape: event.target.value as QuestShape }])
        }}>
          {QUEST_SHAPES.map((shape) => <option key={shape} value={shape}>{QUEST_SHAPE_LABELS[shape]}</option>)}
        </select>
      </label>
      <label className="quest-field">大小
        <input type="range" min={0.5} max={3} step={0.25} disabled={readOnly} value={quest.size ?? 1}
          onChange={(event) => {
            if (!chapter) return
            setOps((current) => [...current.filter((operation) => !(operation.op === 'set_size' && operation.questId === quest.id)),
              { op: 'set_size', chapter: chapter.file, questId: quest.id, size: Number(event.target.value) }])
          }} />
      </label>

      {chapter && chapter.problems.length > 0 && <details className="quest-problems" open>
        <summary>{chapter.problems.length} 个依赖问题</summary>
        {chapter.problems.map((problem) => <p className="error" key={problem}>{problem}</p>)}
      </details>}
    </>}
  </div>

  return <div className="quest-workspace">
    <div className="quest-toolbar row">
      <div className="grow"><strong>{path}</strong><small className="muted">revision {book.revision.slice(0, 12)} · {book.chapters.length} 章 · {book.chapters.reduce((total, chapter) => total + chapter.quests.length, 0)} 任务</small></div>
      {book.warnings.length > 0 && <details className="quest-warning"><summary>{book.warnings.length} 个警告</summary>{book.warnings.map((warning) => <p key={warning}>{warning}</p>)}</details>}
      <button type="button" disabled={busy} onClick={() => void load(path)}>重新读取</button>
      <button type="button" className="primary" disabled={readOnly || busy || pending === 0} onClick={() => void save()}>
        {pending > 0 ? `保存 ${pending} 项` : '没有待保存修改'}
      </button>
      {pending > 0 && <button type="button" disabled={busy} onClick={() => { setOps([]); setMoved({}); setNotice('已丢弃未保存的修改。') }}>丢弃</button>}
    </div>
    {error && <p className="error">{error}</p>}
    {notice && !error && <p className="muted">{notice}</p>}

    <SplitPane
      storageKey="quest-tree"
      initialWidth={210}
      left={<div className="quest-tree">
        <p className="eyebrow">章节</p>
        <TreeView nodes={treeNodes} selectedId={chapterFile} onSelect={(id) => {
          if (id.startsWith('group:')) return
          setChapterFile(id)
          setQuestId('')
        }} empty="任务书里还没有章节。" />
      </div>}
      right={<SplitPane
        storageKey="quest-graph"
        initialWidth={520}
        left={<div className="quest-canvas">
          {chapter ? <>
            <div className="row quest-canvas-head">
              <strong>{chapter.title}</strong>
              <span className="muted">{chapter.quests.length} 任务</span>
              <button type="button" disabled={readOnly} onClick={() => addQuest(0, 0)}>新建任务</button>
            </div>
            <NodeGraph
              nodes={nodes}
              edges={edges}
              selectedId={questId}
              onSelect={setQuestId}
              onMove={pushMove}
              onAdd={readOnly ? undefined : addQuest}
              emptyHint={readOnly ? '这个章节还没有任务。' : '双击空白处新建任务；拖动节点调整位置。'}
            />
          </> : <p className="muted">左侧选择一个章节。</p>}
        </div>}
        right={inspector}
      />}
    />
  </div>
}
