/**
 * Wire shapes for the quest book panel.
 *
 * Mirrors what `readQuestBook` returns. Kept in the view layer because the server
 * only guarantees the JSON contract, not a TS import path: the core module is
 * Node-only and must not be pulled into the browser bundle.
 */

export interface QuestSummary {
  id: string
  x: number
  y: number
  shape?: string
  size?: number
  dependencies: string[]
  title: string
  description: string[]
  tasks: Array<{ id: string; type: string }>
  rewards: Array<{ id: string; type: string }>
}

export interface ChapterSummary {
  file: string
  id: string
  title: string
  groupId: string
  orderIndex: number
  icon?: unknown
  quests: QuestSummary[]
  problems: string[]
}

export interface QuestBookDetail {
  revision: string
  root: string
  locales: string[]
  locale: string
  groups: Array<{ id: string; title: string; orderIndex: number }>
  chapters: ChapterSummary[]
  warnings: string[]
}

export interface QuestBookResponse {
  ok: true
  book: QuestBookDetail
}

export type QuestShape = 'square' | 'hexagon' | 'pentagon' | 'diamond' | 'circle' | 'rsquare' | 'gear'

/** The subset of operations the panel emits. Order matters: it is applied as given. */
export type QuestOpInput =
  | { op: 'move'; chapter: string; questId: string; x: number; y: number }
  | { op: 'set_text'; locale: string; questId: string; title?: string; description?: string[] }
  | { op: 'add_quest'; chapter: string; questId?: string; x: number; y: number; title?: string }
  | { op: 'remove_quest'; chapter: string; questId: string }
  | { op: 'add_dependency'; chapter: string; questId: string; dependsOn: string }
  | { op: 'remove_dependency'; chapter: string; questId: string; dependsOn: string }
  | { op: 'set_shape'; chapter: string; questId: string; shape: QuestShape }
  | { op: 'set_size'; chapter: string; questId: string; size: number }
  | { op: 'set_chapter_title'; locale: string; chapter: string; title: string }

export const QUEST_SHAPES: QuestShape[] = ['square', 'hexagon', 'pentagon', 'diamond', 'circle', 'rsquare', 'gear']

export const QUEST_SHAPE_LABELS: Record<QuestShape, string> = {
  square: '方形',
  hexagon: '六边形',
  pentagon: '五边形',
  diamond: '菱形',
  circle: '圆形',
  rsquare: '圆角方形',
  gear: '齿轮'
}
