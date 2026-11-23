/**
 * Quest book workspace: the file layer under `config/ftbquests/quests`.
 *
 * Same contract as the other authoring workspaces — `list` / `read` / `preview` /
 * `save` with an `expectedRevision` + `previewRevision` pair — because the rule
 * "drafts are never written without a revision check" applies to a quest book
 * exactly as it applies to a GUI layout.
 *
 * One extra dimension: a quest's text lives in `lang/<locale>.snbt` while its
 * position and dependencies live in `chapters/<name>.snbt`. A single logical edit
 * therefore spans two files, so the revision is computed over the *set* of files
 * and the save is committed as one transaction: either every touched file is
 * replaced or none is.
 */

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import {
  chapterTitle,
  chapterGroupTitle,
  dependencyProblems,
  questById,
  questDescription,
  questIdFrom,
  questTitle,
  readChapter,
  readChapterGroups,
  readLang,
  removeQuest,
  replaceQuest,
  withChapterTitle,
  withQuestText,
  withoutQuestText,
  writeChapter,
  writeChapterGroups,
  writeLang,
  type Chapter,
  type ChapterGroup,
  type LangEntries,
  type Quest
} from './quest-model.ts'
import { parseSnbt, snbtSignature } from './snbt.ts'
import { loadWorkspace, resolveTargetMod, type TargetModRef } from './workspace.ts'
import type { Workspace } from './workspace-model.ts'

export const QUEST_ROOT = 'config/ftbquests/quests'
const CHAPTERS_DIR = 'chapters'
const LANG_DIR = 'lang'
const REWARD_TABLES_DIR = 'reward_tables'
const GROUPS_FILE = 'chapter_groups.snbt'

const LOCALE_RE = /^[a-z]{2}_[a-z]{2}$/
const CHAPTER_FILE_RE = /^[A-Za-z0-9_-]{1,64}\.snbt$/
const QUEST_ID_RE = /^[0-9A-Fa-f]{1,16}$/

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code })
}

/** Reject a path that traverses a symlink or junction, matching the other workspaces. */
function safe(file: string): string {
  for (let current = path.resolve(file); ; current = path.dirname(current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) fail('QUEST_PATH_UNSAFE', '任务书路径不能经过链接或 junction')
    if (path.dirname(current) === current) return file
  }
}

function hashOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Revision of one file, computed over its *normalized* form.
 *
 * Formatting and key order are not data: if a pack is reformatted by another tool
 * the revision must not change, or every open editor would report a false conflict.
 */
function fileRevision(raw: string): string {
  // A file we cannot parse is compared byte-for-byte: it will surface as a parse
  // warning elsewhere, and pretending its formatting does not matter would hide
  // the change that broke it.
  try { return hashOf(snbtSignature(parseSnbt(raw))) }
  catch { return hashOf(raw.replace(/\r\n/g, '\n')) }
}

function bookRevision(fileRevisions: ReadonlyMap<string, string>): string {
  const lines = [...fileRevisions.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([file, revision]) => `${file}:${revision}`)
  return hashOf(lines.join('\n'))
}

interface LoadedBook {
  readonly root: string
  /** Absent for a pack with no member project: the book still lives at the pack root. */
  readonly target?: TargetModRef
  /** relPath -> raw text, for every file this workspace owns. */
  readonly files: Map<string, string>
  readonly fileRevisions: Map<string, string>
  readonly chapters: Map<string, Chapter>
  readonly groups: ChapterGroup[]
  readonly langs: Map<string, LangEntries>
  readonly locales: string[]
  readonly revision: string
  readonly warnings: string[]
}

function countFiles(directory: string, pattern: RegExp): string[] {
  if (!existsSync(directory) || !statSync(directory).isDirectory()) return []
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && pattern.test(entry.name))
    .map((entry) => entry.name)
    .sort()
}

/**
 * Locate the book.
 *
 * A pack's book lives at the pack root, and a pack need not contain an authored
 * project at all — "I downloaded a pack and want to edit its quests" is the normal
 * case. The member lookup is therefore best-effort: it only lets a member-local
 * book win when one exists.
 */
function locateQuestRoot(workspace: Workspace, memberId?: string): { root: string; target?: TargetModRef } {
  const candidates: Array<{ root: string; target?: TargetModRef }> = []
  if (workspace.members.length > 0) {
    try {
      const target = resolveTargetMod(workspace, memberId)
      candidates.push({ root: path.join(target.root, ...QUEST_ROOT.split('/')), target })
    } catch { /* a member that is not a project must not block reading the pack book */ }
  }
  candidates.push({ root: path.join(workspace.workspacePath, ...QUEST_ROOT.split('/')) })

  const found = candidates.find((candidate) => existsSync(candidate.root) && statSync(candidate.root).isDirectory())
  if (!found) {
    fail(
      'QUEST_BOOK_MISSING',
      `没有找到任务书目录（${candidates[0].root}）。整合包需要先安装 FTB Quests 并至少打开一次；如果任务书不是放在 config/ftbquests/quests，请把整个任务书目录移过去。`
    )
  }
  return { root: safe(found.root), ...(found.target ? { target: found.target } : {}) }
}

function readBook(workspace: Workspace, memberId?: string): LoadedBook {
  const { root, target } = locateQuestRoot(workspace, memberId)
  const files = new Map<string, string>()
  const warnings: string[] = []
  const chapters = new Map<string, Chapter>()
  const langs = new Map<string, LangEntries>()
  let groups: ChapterGroup[] = []

  for (const name of countFiles(path.join(root, CHAPTERS_DIR), CHAPTER_FILE_RE)) {
    const relPath = `${CHAPTERS_DIR}/${name}`
    const raw = readFileSync(path.join(root, CHAPTERS_DIR, name), 'utf8')
    files.set(relPath, raw)
    try { chapters.set(relPath, readChapter(raw)) }
    catch (cause) { warnings.push(`${relPath} 无法解析，已跳过：${(cause as Error).message}`) }
  }

  const groupsPath = path.join(root, GROUPS_FILE)
  if (existsSync(groupsPath)) {
    const raw = readFileSync(groupsPath, 'utf8')
    files.set(GROUPS_FILE, raw)
    try { groups = readChapterGroups(raw) }
    catch (cause) { warnings.push(`${GROUPS_FILE} 无法解析，已跳过：${(cause as Error).message}`) }
  }

  const locales: string[] = []
  for (const name of countFiles(path.join(root, LANG_DIR), /^[a-z]{2}_[a-z]{2}\.snbt$/)) {
    const locale = name.slice(0, -'.snbt'.length)
    const relPath = `${LANG_DIR}/${name}`
    const raw = readFileSync(path.join(root, LANG_DIR, name), 'utf8')
    files.set(relPath, raw)
    try { langs.set(locale, readLang(raw)); locales.push(locale) }
    catch (cause) { warnings.push(`${relPath} 无法解析，已跳过：${(cause as Error).message}`) }
  }

  for (const name of countFiles(path.join(root, REWARD_TABLES_DIR), CHAPTER_FILE_RE)) {
    const relPath = `${REWARD_TABLES_DIR}/${name}`
    files.set(relPath, readFileSync(path.join(root, REWARD_TABLES_DIR, name), 'utf8'))
  }

  if (!chapters.size && !groups.length && !files.size) {
    fail('QUEST_BOOK_EMPTY', `任务书目录是空的（${root}）。先在游戏里创建至少一个章节，再回来编辑。`)
  }

  const fileRevisions = new Map<string, string>()
  for (const [relPath, raw] of files) fileRevisions.set(relPath, fileRevision(raw))

  return { root, target, files, fileRevisions, chapters, groups, langs, locales, revision: bookRevision(fileRevisions), warnings }
}

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

const workspacePathSchema = z.string().min(1)
const memberIdSchema = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/).optional()
const localeSchema = z.string().regex(LOCALE_RE, '语言代码形如 zh_cn / en_us')
const questIdSchema = z.string().regex(QUEST_ID_RE, '任务 ID 是 1-16 位十六进制')
const chapterFileSchema = z.string().regex(/^(?:chapters\/)?[A-Za-z0-9_-]{1,64}\.snbt$/, '章节文件名形如 chapter_1.snbt')
const revisionSchema = z.string().regex(/^[a-f0-9]{64}$/)

export const questOpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('move'),
    chapter: chapterFileSchema,
    questId: questIdSchema,
    x: z.number().min(-10000).max(10000),
    y: z.number().min(-10000).max(10000)
  }).strict(),
  z.object({
    op: z.literal('set_text'),
    locale: localeSchema,
    questId: questIdSchema,
    title: z.string().max(500).optional(),
    description: z.array(z.string().max(2000)).max(60).optional()
  }).strict(),
  z.object({
    op: z.literal('set_chapter_title'),
    locale: localeSchema,
    chapter: chapterFileSchema,
    title: z.string().min(1).max(200)
  }).strict(),
  z.object({
    op: z.literal('add_quest'),
    chapter: chapterFileSchema,
    questId: questIdSchema.optional(),
    x: z.number().min(-10000).max(10000),
    y: z.number().min(-10000).max(10000),
    title: z.string().max(500).optional()
  }).strict(),
  z.object({
    op: z.literal('remove_quest'),
    chapter: chapterFileSchema,
    questId: questIdSchema
  }).strict(),
  z.object({
    op: z.literal('add_dependency'),
    chapter: chapterFileSchema,
    questId: questIdSchema,
    dependsOn: questIdSchema
  }).strict(),
  z.object({
    op: z.literal('remove_dependency'),
    chapter: chapterFileSchema,
    questId: questIdSchema,
    dependsOn: questIdSchema
  }).strict(),
  z.object({
    op: z.literal('set_shape'),
    chapter: chapterFileSchema,
    questId: questIdSchema,
    shape: z.enum(['square', 'hexagon', 'pentagon', 'diamond', 'circle', 'rsquare', 'gear'])
  }).strict(),
  z.object({
    op: z.literal('set_size'),
    chapter: chapterFileSchema,
    questId: questIdSchema,
    size: z.number().min(0.5).max(4)
  }).strict()
])
export type QuestOp = z.infer<typeof questOpSchema>

const operations = z.array(questOpSchema).min(1).max(200)

export const questRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list'), workspacePath: workspacePathSchema, memberId: memberIdSchema }).strict(),
  z.object({ action: z.literal('read'), workspacePath: workspacePathSchema, memberId: memberIdSchema, locale: localeSchema.optional() }).strict(),
  z.object({
    action: z.literal('preview'),
    workspacePath: workspacePathSchema,
    memberId: memberIdSchema,
    expectedRevision: revisionSchema.nullable(),
    ops: operations
  }).strict(),
  z.object({
    action: z.literal('save'),
    workspacePath: workspacePathSchema,
    memberId: memberIdSchema,
    expectedRevision: revisionSchema.nullable(),
    expectedFileRevisions: z.record(z.string(), revisionSchema).optional(),
    previewRevision: revisionSchema,
    ops: operations
  }).strict(),
  z.object({ action: z.literal('validate'), workspacePath: workspacePathSchema, memberId: memberIdSchema }).strict()
])
export type QuestRequest = z.infer<typeof questRequestSchema>

// ---------------------------------------------------------------------------
// Applying operations
// ---------------------------------------------------------------------------

interface BookState {
  chapters: Map<string, Chapter>
  groups: ChapterGroup[]
  langs: Map<string, LangEntries>
}

function stateOf(book: LoadedBook): BookState {
  return {
    chapters: new Map([...book.chapters.entries()].map(([file, chapter]) => [file, chapter])),
    groups: [...book.groups],
    langs: new Map(book.langs)
  }
}

/** Operations may name a chapter as `chapter_1.snbt` or `chapters/chapter_1.snbt`. */
function normalizeChapterFile(file: string): string {
  return file.startsWith(`${CHAPTERS_DIR}/`) ? file : `${CHAPTERS_DIR}/${file}`
}

function chapterAt(state: BookState, file: string): { key: string; chapter: Chapter } {
  const key = normalizeChapterFile(file)
  const chapter = state.chapters.get(key)
  if (!chapter) fail('QUEST_CHAPTER_NOT_FOUND', `没有章节文件 ${key}；现有：${[...state.chapters.keys()].join(', ') || '（空）'}`)
  return { key, chapter }
}

function questAt(state: BookState, file: string, questId: string): { key: string; chapter: Chapter; quest: Quest } {
  const { key, chapter } = chapterAt(state, file)
  const quest = questById(chapter, questId)
  if (!quest) fail('QUEST_NOT_FOUND', `章节 ${key} 里没有任务 ${questId}`)
  return { key, chapter, quest }
}

function ensureLocale(state: BookState, locale: string): LangEntries {
  return state.langs.get(locale) ?? {}
}

/** Apply operations in order, returning the mutated state. Throws on the first failure. */
function applyOps(state: BookState, ops: readonly QuestOp[]): BookState {
  for (const op of ops) {
    switch (op.op) {
      case 'move': {
        const { key, chapter, quest } = questAt(state, op.chapter, op.questId)
        state.chapters.set(key, replaceQuest(chapter, { ...quest, x: op.x, y: op.y }))
        break
      }
      case 'set_text': {
        const next = withQuestText(ensureLocale(state, op.locale), op.questId, {
          ...(op.title !== undefined ? { title: op.title } : {}),
          ...(op.description !== undefined ? { description: op.description } : {})
        })
        state.langs.set(op.locale, next)
        break
      }
      case 'set_chapter_title': {
        const { chapter } = chapterAt(state, op.chapter)
        state.langs.set(op.locale, withChapterTitle(ensureLocale(state, op.locale), chapter.id, op.title))
        break
      }
      case 'add_quest': {
        const { key, chapter } = chapterAt(state, op.chapter)
        const questId = op.questId ?? questIdFrom(`${chapter.id}:${op.x}:${op.y}:${chapter.quests.length}`)
        if (chapter.quests.some((quest) => quest.id === questId)) {
          fail('QUEST_EXISTS', `章节 ${key} 里已经有任务 ${questId}`)
        }
        const quest: Quest = { id: questId, x: op.x, y: op.y, dependencies: [], tasks: [], rewards: [], extra: {} }
        state.chapters.set(key, { ...chapter, quests: [...chapter.quests, quest] })
        break
      }
      case 'remove_quest': {
        const { key, chapter } = chapterAt(state, op.chapter)
        state.chapters.set(key, removeQuest(chapter, op.questId))
        for (const [locale, entries] of state.langs) state.langs.set(locale, withoutQuestText(entries, op.questId))
        break
      }
      case 'add_dependency': {
        const { key, chapter, quest } = questAt(state, op.chapter, op.questId)
        if (op.questId === op.dependsOn) fail('QUEST_DEPENDENCY_INVALID', '任务不能依赖自己')
        if (quest.dependencies.includes(op.dependsOn)) break
        if (!chapter.quests.some((candidate) => candidate.id === op.dependsOn)) {
          fail('QUEST_NOT_FOUND', `章节 ${key} 里没有任务 ${op.dependsOn}；跨章节依赖请先在同一个文件里建立`)
        }
        state.chapters.set(key, replaceQuest(chapter, { ...quest, dependencies: [...quest.dependencies, op.dependsOn] }))
        break
      }
      case 'remove_dependency': {
        const { key, chapter, quest } = questAt(state, op.chapter, op.questId)
        state.chapters.set(key, replaceQuest(chapter, {
          ...quest,
          dependencies: quest.dependencies.filter((dependency) => dependency !== op.dependsOn)
        }))
        break
      }
      case 'set_shape': {
        const { key, chapter, quest } = questAt(state, op.chapter, op.questId)
        state.chapters.set(key, replaceQuest(chapter, { ...quest, shape: op.shape }))
        break
      }
      case 'set_size': {
        const { key, chapter, quest } = questAt(state, op.chapter, op.questId)
        state.chapters.set(key, replaceQuest(chapter, { ...quest, size: op.size }))
        break
      }
    }
  }
  return state
}

/** Render state back to file text, touching only files whose bytes actually change. */
function render(state: BookState, previous: LoadedBook): Map<string, string> {
  const output = new Map<string, string>()
  for (const [file, chapter] of state.chapters) {
    const before = previous.chapters.get(file)
    if (before && sameChapter(before, chapter)) continue
    output.set(file, writeChapter(chapter))
  }
  const groupsText = writeChapterGroups(state.groups)
  if (!previous.files.has(GROUPS_FILE) || fileRevision(groupsText) !== previous.fileRevisions.get(GROUPS_FILE)) {
    output.set(GROUPS_FILE, groupsText)
  }
  for (const [locale, entries] of state.langs) {
    const file = `${LANG_DIR}/${locale}.snbt`
    const text = writeLang(entries)
    // A chapter edit must not rewrite a 200-question lang file it never touched.
    if (previous.files.has(file) && fileRevision(text) === previous.fileRevisions.get(file)) continue
    output.set(file, text)
  }
  return output
}

/** Structural equality through the writer, so formatting differences do not count. */
function sameChapter(left: Chapter, right: Chapter): boolean {
  return writeChapter(left) === writeChapter(right)
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

function inventory(book: LoadedBook, locale: string) {
  const lang = book.langs.get(locale) ?? {}
  return {
    revision: book.revision,
    root: book.root,
    target: book.target ? { memberId: book.target.memberId, minecraft: book.target.minecraftVersion, loader: book.target.loader } : null,
    locales: book.locales,
    locale,
    groups: book.groups.map((group) => ({ id: group.id, title: chapterGroupTitle(lang, group), orderIndex: group.orderIndex })),
    chapters: [...book.chapters.entries()].map(([file, chapter]) => ({
      file,
      id: chapter.id,
      title: chapterTitle(lang, chapter),
      groupId: chapter.groupId,
      orderIndex: chapter.orderIndex,
      questCount: chapter.quests.length,
      problems: dependencyProblems(chapter).length
    })).sort((left, right) => left.orderIndex - right.orderIndex || left.file.localeCompare(right.file)),
    warnings: book.warnings
  }
}

function detail(book: LoadedBook, locale: string) {
  const lang = book.langs.get(locale) ?? {}
  return {
    revision: book.revision,
    root: book.root,
    locales: book.locales,
    locale,
    groups: book.groups.map((group) => ({ id: group.id, title: chapterGroupTitle(lang, group), orderIndex: group.orderIndex })),
    chapters: [...book.chapters.entries()].map(([file, chapter]) => ({
      file,
      id: chapter.id,
      title: chapterTitle(lang, chapter),
      groupId: chapter.groupId,
      orderIndex: chapter.orderIndex,
      icon: chapter.icon,
      quests: chapter.quests.map((quest) => ({
        id: quest.id,
        x: quest.x,
        y: quest.y,
        shape: quest.shape,
        size: quest.size,
        dependencies: quest.dependencies,
        title: questTitle(lang, quest),
        description: questDescription(lang, quest),
        tasks: quest.tasks.map((task) => ({ id: task.id, type: task.type })),
        rewards: quest.rewards.map((reward) => ({ id: reward.id, type: reward.type }))
      })),
      problems: dependencyProblems(chapter)
    })),
    warnings: book.warnings
  }
}

function preview(book: LoadedBook, request: { expectedRevision?: string | null; ops: readonly QuestOp[] }) {
  if (request.expectedRevision != null && request.expectedRevision !== book.revision) {
    fail('QUEST_CONFLICT', `任务书已被修改（期望 revision ${request.expectedRevision.slice(0, 12)}，当前 ${book.revision.slice(0, 12)}）。重新 read 后再改。`)
  }
  const state = applyOps(stateOf(book), request.ops)
  const changed = render(state, book)
  const after = new Map(book.fileRevisions)
  for (const [file, text] of changed) after.set(file, fileRevision(text))
  return { changed, previewRevision: bookRevision(after) }
}

/** Commit every changed file or none: temp files first, then a rename per file. */
function commit(root: string, changed: ReadonlyMap<string, string>): string[] {
  const staged: Array<{ temporary: string; target: string }> = []
  try {
    for (const [relPath, text] of changed) {
      const target = safe(path.join(root, ...relPath.split('/')))
      mkdirSync(path.dirname(target), { recursive: true })
      const temporary = `${target}.${process.pid}.tmp`
      writeFileSync(temporary, text, 'utf8')
      staged.push({ temporary, target })
    }
  } catch (cause) {
    for (const { temporary } of staged) { try { unlinkSync(temporary) } catch { /* best effort */ } }
    throw cause
  }
  const written: string[] = []
  for (const { temporary, target } of staged) {
    renameSync(temporary, target)
    written.push(target)
  }
  return written
}

export function questWorkspace(workspacePath: string, raw: unknown) {
  const request = questRequestSchema.parse(raw)
  const workspace = loadWorkspace(workspacePath)

  if (request.action === 'list') {
    const book = readBook(workspace, request.memberId)
    return { ok: true, ...inventory(book, book.locales[0] ?? 'zh_cn') }
  }

  if (request.action === 'read') {
    const book = readBook(workspace, request.memberId)
    const locale = request.locale ?? (book.locales.includes('zh_cn') ? 'zh_cn' : book.locales[0])
    if (!locale) fail('QUEST_LOCALE_MISSING', '任务书没有任何语言文件；先在游戏里打开任务书以生成 lang/zh_cn.snbt。')
    return { ok: true, book: detail(book, locale) }
  }

  if (request.action === 'validate') {
    const book = readBook(workspace, request.memberId)
    const problems = [...book.chapters.entries()].flatMap(([file, chapter]) =>
      dependencyProblems(chapter).map((problem) => ({ file, problem })))
    return {
      ok: problems.length === 0,
      revision: book.revision,
      chapters: book.chapters.size,
      quests: [...book.chapters.values()].reduce((total, chapter) => total + chapter.quests.length, 0),
      problems,
      warnings: book.warnings,
      ...(problems.length > 0 ? { code: 'QUEST_GRAPH_INVALID', remediation: '修掉悬空依赖或环，或用 remove_dependency 断开。' } : {})
    }
  }

  const book = readBook(workspace, request.memberId)
  const planned = preview(book, request)

  if (request.action === 'preview') {
    return {
      ok: true,
      revision: book.revision,
      previewRevision: planned.previewRevision,
      files: [...planned.changed.entries()].map(([file, text]) => ({
        file,
        before: book.files.get(file) ?? null,
        after: text
      }))
    }
  }

  // save
  if (planned.previewRevision !== request.previewRevision) {
    fail('QUEST_PREVIEW_STALE', 'preview 之后任务书又被改动过；重新 preview 再保存。')
  }
  if (request.expectedFileRevisions) {
    const drifted = Object.entries(request.expectedFileRevisions)
      .filter(([file, revision]) => book.fileRevisions.get(file) !== revision)
      .map(([file]) => file)
    if (drifted.length > 0) {
      fail('QUEST_CONFLICT', `这些文件在编辑期间被外部改动：${drifted.join(', ')}。重新 read 后再改。`)
    }
  }
  if (planned.changed.size === 0) {
    return { ok: true, noop: true, revision: book.revision, written: [] }
  }

  const written = commit(book.root, planned.changed)
  const after = new Map(book.fileRevisions)
  for (const [file, text] of planned.changed) after.set(file, fileRevision(text))
  return {
    ok: true,
    revision: bookRevision(after),
    written: written.map((file) => path.relative(book.root, file).replaceAll('\\', '/')),
    locales: [...book.langs.keys()]
  }
}

/** Read-only helper for the browser: the whole book as one payload. */
export function readQuestBook(workspacePath: string, memberId?: string, locale?: string) {
  const workspace = loadWorkspace(workspacePath)
  const book = readBook(workspace, memberId)
  const chosen = locale ?? (book.locales.includes('zh_cn') ? 'zh_cn' : book.locales[0])
  if (!chosen) fail('QUEST_LOCALE_MISSING', '任务书没有任何语言文件。')
  return { ok: true, book: detail(book, chosen) }
}

/** Delete temporary files left by a crashed save. Exposed for tests and diagnostics. */
export function sweepQuestTemporaries(root: string): number {
  let removed = 0
  const visit = (directory: string): void => {
    if (!existsSync(directory) || !statSync(directory).isDirectory()) return
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(file)
      else if (/\.\d+\.tmp$/.test(entry.name)) { unlinkSync(file); removed += 1 }
    }
  }
  visit(root)
  return removed
}

/**
 * Diagnostics only. `questTitle` and friends stay in `quest-model.ts` so that
 * `export *` from the package index has exactly one owner per name.
 */
export { fileRevision as questFileRevision, bookRevision as questBookRevision }
