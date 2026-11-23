/**
 * Workbench panel ids: the single source of truth for "which tabs exist".
 *
 * This list used to be copy-pasted into three places — `App.tsx`'s `modules[]`,
 * the session tool's `currentModule` / `recommendedModules` enums, and
 * `open_workbench`'s `view` enum. Adding a tab meant editing all three, and a
 * missed edit silently made the panel unreachable for the Agent (it could not
 * recommend or deep-link what the schema rejected).
 *
 * Growth is deliberate, not speculative: an id belongs here only when a caller
 * can actually mount it. The browser registry asserts one definition per id, and
 * its harness fails if the two drift apart.
 */

import { z } from 'zod'

export const PANEL_IDS = [
  'overview',
  'content',
  'textures',
  'paint',
  'recipe',
  'gui',
  'model',
  'build',
  'game',
  'tests',
  'reports',
  /** FTB Quests book: chapter tree + dependency graph + per-quest inspector. */
  'quest',
  /** Pack manifest, lockfile, solver findings and export. */
  'pack',
  /** Community search: intent -> candidates -> coverage and gaps. */
  'discover',
  /** Shared quality-of-life base: group selection, availability, assembly. */
  'baseline',
  /** Generated Fabric bridge project between two mods. */
  'bridge',
  /** Licence-gated L1–L4 transform: overlay, companion, plan, analysis, audit. */
  'transform'
] as const

export type PanelId = (typeof PANEL_IDS)[number]

export const panelIdSchema = z.enum(PANEL_IDS)

export function isPanelId(value: unknown): value is PanelId {
  return typeof value === 'string' && (PANEL_IDS as readonly string[]).includes(value)
}
