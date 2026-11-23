/**
 * FTB Quests semantic model: one SNBT file <-> one typed structure.
 *
 * The governing rule is **preserve what we do not understand**. A pack's chapter
 * file is written by FTB Quests, and its tasks/rewards/links carry fields this
 * project does not model (custom task types from add-ons, per-quest settings from
 * future FTB versions). Round-tripping a chapter must not drop them, so every
 * entity keeps an `extra` bag and the writer emits known fields first, then the
 * bag in sorted order.
 *
 * Text lives in `lang/<locale>.snbt`, not in the chapter file. Writing a title
 * into the chapter too would create two sources of truth, and FTB resolves text
 * from lang — so the duplicate would be silently overwritten on the next load.
 * `withQuestText` therefore only ever writes lang.
 *
 * Inline `title`/`description` that an older pack still carries are a different
 * case: they land in `extra` and are written back verbatim, because dropping them
 * would be data loss. The rule is "never *create* a second source", not "erase
 * whatever is already there".
 *
 * Pure module: no Node imports, so the browser can render a book with the same
 * code the server uses to validate it.
 */

import {
  isNbtCompound,
  nbtCompound,
  nbtDouble,
  nbtInt,
  nbtList,
  nbtLong,
  nbtString,
  nbtText,
  parseSnbtCompound,
  printSnbt,
  type NbtCompound,
  type NbtValue
} from './snbt.ts'

export const QUEST_BOOK_SCHEMA_VERSION = 1

/**
 * Keys the writer owns. Anything else in the file is preserved in `extra`.
 *
 * Only fields that `Chapter` actually models belong here: listing a key that has
 * no field would delete it on save, which is exactly the data loss this module
 * exists to prevent.
 */
const CHAPTER_KEYS = new Set(['id', 'group', 'order_index', 'icon', 'quests', 'quest_links', 'images'])
const QUEST_KEYS = new Set(['id', 'x', 'y', 'dependencies', 'shape', 'size', 'tasks', 'rewards'])
const TASK_KEYS = new Set(['id', 'type'])
const REWARD_KEYS = new Set(['id', 'type'])

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code })
}

function extraOf(value: NbtCompound, known: ReadonlySet<string>): Record<string, NbtValue> {
  const output: Record<string, NbtValue> = {}
  for (const [key, child] of Object.entries(value.v)) if (!known.has(key)) output[key] = child
  return output
}

function requireText(value: NbtValue | undefined, what: string): string {
  const text = nbtText(value)
  if (!text) fail('QUEST_INVALID', `${what} 缺少字符串字段`)
  return text
}

function optionalText(value: NbtValue | undefined): string | undefined {
  const text = nbtText(value)
  return text && text.length > 0 ? text : undefined
}

function requireNumber(value: NbtValue | undefined, what: string): number {
  const number = value?.t === 'double' || value?.t === 'float' ? value.v
    : value?.t === 'int' || value?.t === 'long' || value?.t === 'short' || value?.t === 'byte' ? value.v
      : undefined
  if (number === undefined) fail('QUEST_INVALID', `${what} 缺少数值字段`)
  return number
}

function numberOr(value: NbtValue | undefined, fallback: number): number {
  if (!value) return fallback
  switch (value.t) {
    case 'double': case 'float': case 'int': case 'long': case 'short': case 'byte': return value.v
    default: return fallback
  }
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export interface QuestTask {
  readonly id: string
  /** Free-form: FTB add-ons register their own task types. */
  readonly type: string
  /** Every field except `id`/`type`, so editing one item count keeps the rest. */
  readonly fields: Readonly<Record<string, NbtValue>>
}

export interface QuestReward {
  readonly id: string
  readonly type: string
  readonly fields: Readonly<Record<string, NbtValue>>
}

export interface Quest {
  readonly id: string
  readonly x: number
  readonly y: number
  readonly dependencies: readonly string[]
  readonly shape?: string
  readonly size?: number
  readonly tasks: readonly QuestTask[]
  readonly rewards: readonly QuestReward[]
  readonly extra: Readonly<Record<string, NbtValue>>
}

export interface Chapter {
  readonly id: string
  /** Empty string is FTB's "default group". */
  readonly groupId: string
  readonly orderIndex: number
  readonly icon?: NbtValue
  readonly quests: readonly Quest[]
  /** `quest_links` and `images` are not edited here; they round-trip verbatim. */
  readonly questLinks: readonly NbtValue[]
  readonly images: readonly NbtValue[]
  readonly extra: Readonly<Record<string, NbtValue>>
}

export interface ChapterGroup {
  readonly id: string
  readonly orderIndex: number
  readonly extra: Readonly<Record<string, NbtValue>>
}

/** `quest.<id>.title`, `quest.<id>.quest_desc`, `chapter.<id>.title`, ... */
export type LangValue = string | readonly string[]
export type LangEntries = Readonly<Record<string, LangValue>>

export const questKey = (id: string, field: string): string => `quest.${id}.${field}`
export const chapterKey = (id: string, field: string): string => `chapter.${id}.${field}`
export const chapterGroupKey = (id: string, field: string): string => `chapter_group.${id}.${field}`

/** FTB's field name for a quest's description list. */
export const QUEST_DESC_FIELD = 'quest_desc'
export const QUEST_TITLE_FIELD = 'title'
export const QUEST_SUBTITLE_FIELD = 'quest_subtitle'

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

function readTask(value: NbtValue, label: string): QuestTask {
  if (!isNbtCompound(value)) fail('QUEST_INVALID', `${label} 必须是复合标签`)
  const id = requireText(value.v.id, `${label}.id`)
  const type = requireText(value.v.type, `${label}.type`)
  return { id, type, fields: extraOf(value, TASK_KEYS) }
}

function readReward(value: NbtValue, label: string): QuestReward {
  if (!isNbtCompound(value)) fail('QUEST_INVALID', `${label} 必须是复合标签`)
  const id = requireText(value.v.id, `${label}.id`)
  const type = requireText(value.v.type, `${label}.type`)
  return { id, type, fields: extraOf(value, REWARD_KEYS) }
}

function readQuest(value: NbtValue, label: string): Quest {
  if (!isNbtCompound(value)) fail('QUEST_INVALID', `${label} 必须是复合标签`)
  const id = requireText(value.v.id, `${label}.id`)
  const dependencies = value.v.dependencies?.t === 'list'
    ? value.v.dependencies.v.map((item, index) => requireText(item, `${label}.dependencies[${index}]`))
    : []
  const tasks = value.v.tasks?.t === 'list'
    ? value.v.tasks.v.map((item, index) => readTask(item, `${label}.tasks[${index}]`))
    : []
  const rewards = value.v.rewards?.t === 'list'
    ? value.v.rewards.v.map((item, index) => readReward(item, `${label}.rewards[${index}]`))
    : []
  return {
    id,
    x: numberOr(value.v.x, 0),
    y: numberOr(value.v.y, 0),
    dependencies,
    tasks,
    rewards,
    ...(optionalText(value.v.shape) ? { shape: optionalText(value.v.shape)! } : {}),
    ...(value.v.size ? { size: numberOr(value.v.size, 1) } : {}),
    extra: extraOf(value, QUEST_KEYS)
  }
}

export function readChapter(snbt: string): Chapter {
  const value = parseSnbtCompound(snbt)
  const id = requireText(value.v.id, 'chapter.id')
  const quests = value.v.quests?.t === 'list'
    ? value.v.quests.v.map((item, index) => readQuest(item, `chapter.quests[${index}]`))
    : []
  const seen = new Set<string>()
  for (const quest of quests) {
    if (seen.has(quest.id)) fail('QUEST_INVALID', `同一个章节里有两个 quest id 为 ${quest.id}`)
    seen.add(quest.id)
  }
  return {
    id,
    groupId: optionalText(value.v.group) ?? '',
    orderIndex: numberOr(value.v.order_index, 0),
    quests,
    questLinks: value.v.quest_links?.t === 'list' ? [...value.v.quest_links.v] : [],
    images: value.v.images?.t === 'list' ? [...value.v.images.v] : [],
    ...(value.v.icon ? { icon: value.v.icon } : {}),
    extra: extraOf(value, CHAPTER_KEYS)
  }
}

export function readChapterGroups(snbt: string): ChapterGroup[] {
  const value = parseSnbtCompound(snbt)
  // FTB writes `{ chapter_groups: [ { id, ... } ] }`.
  const list = value.v.chapter_groups
  if (!list) return []
  if (list.t !== 'list') fail('QUEST_INVALID', 'chapter_groups.snbt 的 chapter_groups 必须是列表')
  return list.v.map((item, index) => {
    if (!isNbtCompound(item)) fail('QUEST_INVALID', `chapter_groups[${index}] 必须是复合标签`)
    return {
      id: requireText(item.v.id, `chapter_groups[${index}].id`),
      orderIndex: numberOr(item.v.order_index, 0),
      extra: extraOf(item, new Set(['id', 'order_index']))
    }
  })
}

export function readLang(snbt: string): LangEntries {
  const value = parseSnbtCompound(snbt)
  const output: Record<string, LangValue> = {}
  for (const [key, child] of Object.entries(value.v)) {
    if (child.t === 'string') output[key] = child.v
    else if (child.t === 'list') {
      const lines: string[] = []
      for (const item of child.v) {
        if (item.t !== 'string') fail('QUEST_INVALID', `lang 键「${key}」的列表里出现了非字符串`)
        lines.push(item.v)
      }
      output[key] = lines
    } else fail('QUEST_INVALID', `lang 键「${key}」的值必须是字符串或字符串列表`)
  }
  return output
}

// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------

function sortedKeys(value: Readonly<Record<string, NbtValue>>): string[] {
  return Object.keys(value).sort()
}

/** FTB emits compounds in key order; matching it keeps a diff to the lines we changed. */
function ordered(value: Record<string, NbtValue>): NbtCompound {
  const output: Record<string, NbtValue> = {}
  for (const key of Object.keys(value).sort()) output[key] = value[key]
  return nbtCompound(output)
}

function taskCompound(task: QuestTask): NbtCompound {
  const value: Record<string, NbtValue> = { id: nbtString(task.id), type: nbtString(task.type) }
  for (const [key, child] of Object.entries(task.fields)) if (!TASK_KEYS.has(key)) value[key] = child
  return ordered(value)
}

function rewardCompound(reward: QuestReward): NbtCompound {
  const value: Record<string, NbtValue> = { id: nbtString(reward.id), type: nbtString(reward.type) }
  for (const [key, child] of Object.entries(reward.fields)) if (!REWARD_KEYS.has(key)) value[key] = child
  return ordered(value)
}

function questCompound(quest: Quest): NbtCompound {
  const value: Record<string, NbtValue> = {
    id: nbtString(quest.id),
    x: nbtDouble(quest.x),
    y: nbtDouble(quest.y)
  }
  if (quest.dependencies.length > 0) value.dependencies = nbtList(quest.dependencies.map(nbtString))
  if (quest.shape) value.shape = nbtString(quest.shape)
  if (quest.size !== undefined) value.size = nbtDouble(quest.size)
  if (quest.tasks.length > 0) value.tasks = nbtList(quest.tasks.map(taskCompound))
  if (quest.rewards.length > 0) value.rewards = nbtList(quest.rewards.map(rewardCompound))
  for (const [key, child] of Object.entries(quest.extra)) if (!QUEST_KEYS.has(key)) value[key] = child
  return ordered(value)
}

/**
 * Chapters use a tighter inline budget than the SNBT default.
 *
 * A quest compound is a multi-line record in FTB's own output; keeping that shape
 * means editing one field shows up as a one-line diff instead of reflowing the
 * whole quest onto a single line.
 */
const CHAPTER_INLINE_BUDGET = 48

export function writeChapter(chapter: Chapter): string {
  const value: Record<string, NbtValue> = {
    id: nbtString(chapter.id),
    group: nbtString(chapter.groupId),
    order_index: nbtInt(chapter.orderIndex),
    quests: nbtList(chapter.quests.map(questCompound)),
    quest_links: nbtList([...chapter.questLinks]),
    images: nbtList([...chapter.images])
  }
  if (chapter.icon) value.icon = chapter.icon
  for (const [key, child] of Object.entries(chapter.extra)) if (!CHAPTER_KEYS.has(key)) value[key] = child
  return printSnbt(ordered(value), { maxInline: CHAPTER_INLINE_BUDGET })
}

export function writeChapterGroups(groups: readonly ChapterGroup[]): string {
  return printSnbt(nbtCompound({
    chapter_groups: nbtList(groups.map((group) => ordered({
      id: nbtString(group.id),
      order_index: nbtInt(group.orderIndex),
      ...Object.fromEntries(Object.entries(group.extra).filter(([key]) => key !== 'id' && key !== 'order_index'))
    })))
  }))
}

export function writeLang(entries: LangEntries): string {
  const value: Record<string, NbtValue> = {}
  for (const key of Object.keys(entries).sort()) {
    const entry = entries[key]
    value[key] = typeof entry === 'string' ? nbtString(entry) : nbtList(entry.map(nbtString))
  }
  return printSnbt(nbtCompound(value))
}

// ---------------------------------------------------------------------------
// Editing helpers
// ---------------------------------------------------------------------------

export function questById(chapter: Chapter, id: string): Quest | undefined {
  return chapter.quests.find((quest) => quest.id === id)
}

/** Every dependency edge in a chapter, with the target validated. */
export function dependencyEdges(chapter: Chapter): Array<{ from: string; to: string; missing: boolean }> {
  const ids = new Set(chapter.quests.map((quest) => quest.id))
  return chapter.quests.flatMap((quest) => quest.dependencies.map((dependency) => ({
    from: quest.id,
    to: dependency,
    missing: !ids.has(dependency)
  })))
}

/**
 * Dependencies that can never be satisfied: an unknown target, a self-loop, or a
 * cycle. FTB tolerates cycles at runtime but renders them as unreachable, which is
 * indistinguishable from a bug to a player.
 */
export function dependencyProblems(chapter: Chapter): string[] {
  const problems: string[] = []
  const ids = new Set(chapter.quests.map((quest) => quest.id))

  for (const edge of dependencyEdges(chapter)) {
    if (edge.from === edge.to) problems.push(`任务 ${edge.from} 依赖自己`)
    else if (edge.missing) problems.push(`任务 ${edge.from} 依赖了不存在的 ${edge.to}`)
  }

  const state = new Map<string, 'visiting' | 'done'>()
  const adjacency = new Map<string, string[]>()
  for (const quest of chapter.quests) adjacency.set(quest.id, [...quest.dependencies])
  const visit = (id: string, trail: string[]): void => {
    if (state.get(id) === 'done') return
    if (state.get(id) === 'visiting') {
      problems.push(`依赖成环：${[...trail, id].join(' → ')}`)
      return
    }
    state.set(id, 'visiting')
    for (const next of adjacency.get(id) ?? []) if (ids.has(next)) visit(next, [...trail, id])
    state.set(id, 'done')
  }
  for (const quest of chapter.quests) visit(quest.id, [])
  return [...new Set(problems)]
}

/** Replace a quest in place, keeping array order so the file diff stays small. */
export function replaceQuest(chapter: Chapter, quest: Quest): Chapter {
  const index = chapter.quests.findIndex((candidate) => candidate.id === quest.id)
  if (index < 0) fail('QUEST_NOT_FOUND', `章节 ${chapter.id} 里没有任务 ${quest.id}`)
  return { ...chapter, quests: chapter.quests.map((candidate, position) => (position === index ? quest : candidate)) }
}

export function removeQuest(chapter: Chapter, id: string): Chapter {
  const quests = chapter.quests.filter((quest) => quest.id !== id)
  if (quests.length === chapter.quests.length) fail('QUEST_NOT_FOUND', `章节 ${chapter.id} 里没有任务 ${id}`)
  // Dependencies pointing at a removed quest would make the rest unreachable.
  return {
    ...chapter,
    quests: quests.map((quest) => quest.dependencies.includes(id)
      ? { ...quest, dependencies: quest.dependencies.filter((dependency) => dependency !== id) }
      : quest)
  }
}

/** Text the UI needs, resolved from lang with the chapter file as a fallback. */
export function questTitle(lang: LangEntries, quest: Quest): string {
  const value = lang[questKey(quest.id, QUEST_TITLE_FIELD)]
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.join(' ')
  const inline = optionalText(quest.extra.title)
  return inline ?? quest.id
}

export function questDescription(lang: LangEntries, quest: Quest): string[] {
  const value = lang[questKey(quest.id, QUEST_DESC_FIELD)]
  if (Array.isArray(value)) return [...value]
  if (typeof value === 'string') return [value]
  const inline = quest.extra.description
  if (inline?.t === 'list') return inline.v.flatMap((item) => (item.t === 'string' ? [item.v] : []))
  if (inline?.t === 'string') return [inline.v]
  return []
}

export function chapterTitle(lang: LangEntries, chapter: Chapter): string {
  const value = lang[chapterKey(chapter.id, 'title')]
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.join(' ')
  const inline = optionalText(chapter.extra.title)
  return inline ?? chapter.id
}

export function chapterGroupTitle(lang: LangEntries, group: ChapterGroup): string {
  const value = lang[chapterGroupKey(group.id, 'title')]
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.join(' ')
  return group.id
}

/**
 * Write title/description into lang, returning a new map.
 *
 * `undefined` removes the key, which is how a cleared field becomes "fall back to
 * whatever the chapter file says" instead of an empty string showing up in game.
 */
export function withQuestText(lang: LangEntries, questId: string, text: { title?: string; description?: readonly string[] }): LangEntries {
  const output: Record<string, LangValue> = { ...lang }
  if (text.title !== undefined) {
    const key = questKey(questId, QUEST_TITLE_FIELD)
    if (text.title === '') delete output[key]
    else output[key] = text.title
  }
  if (text.description !== undefined) {
    const key = questKey(questId, QUEST_DESC_FIELD)
    if (text.description.length === 0) delete output[key]
    else output[key] = [...text.description]
  }
  return output
}

export function withChapterTitle(lang: LangEntries, chapterId: string, title: string): LangEntries {
  const output: Record<string, LangValue> = { ...lang }
  const key = chapterKey(chapterId, 'title')
  if (title === '') delete output[key]
  else output[key] = title
  return output
}

/** Remove every lang entry that belongs to one quest. Used when deleting a quest. */
export function withoutQuestText(lang: LangEntries, questId: string): LangEntries {
  const prefix = `quest.${questId}.`
  const output: Record<string, LangValue> = {}
  for (const [key, value] of Object.entries(lang)) if (!key.startsWith(prefix)) output[key] = value
  return output
}

/** A stable, human-readable id in FTB's style (16 uppercase hex characters). */
export function questIdFrom(seed: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  const high = hash.toString(16).toUpperCase().padStart(8, '0')
  let second = 0x9e3779b9
  for (let index = seed.length - 1; index >= 0; index -= 1) {
    second ^= seed.charCodeAt(index)
    second = Math.imul(second, 0x85ebca6b) >>> 0
  }
  return `${high}${second.toString(16).toUpperCase().padStart(8, '0')}`
}

/** Long ids are what FTB uses for reward table entries; keep the helper honest. */
export function isQuestId(value: string): boolean {
  return /^[0-9A-F]{1,16}$/i.test(value)
}

/** `nbtLong` is exported here only so quest files that use long counters stay typed. */
export const questLong = nbtLong
