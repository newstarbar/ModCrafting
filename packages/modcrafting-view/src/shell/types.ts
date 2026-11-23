/**
 * Workbench shell contracts.
 *
 * A panel is described by metadata plus a component. `scope` decides which
 * navigation level it belongs to: a mod pack has pack-level panels (the book,
 * the mod list) that make no sense for a single mod, and vice versa. Before this
 * existed every panel was a flat entry in one array, which is why the sidebar
 * could not express the difference.
 */

import type { PanelId } from '../../../modcrafting-core/src/panels.ts'

export type PanelScope = 'global' | 'mod' | 'modpack'

export interface PanelMeta {
  readonly label: string
  /** Single glyph, matching the existing sidebar style (no icon font, no images). */
  readonly icon: string
  readonly scope: PanelScope
  /** Panels that need a readable project show a guidance page when there is none. */
  readonly requiresProject: boolean
  /** One line shown in the empty state, so a blank panel is never a dead end. */
  readonly hint?: string
}

/** Everything a panel may read from the shell. Kept small on purpose. */
export interface PanelContext {
  readonly sessionId: string
  readonly panelId: PanelId
  /** Absolute path of the active project, when one is open and valid. */
  readonly projectPath: string
  readonly modId: string
  /** Workspace root; for a single-mod project this equals `projectPath`. */
  readonly workspacePath: string
  readonly activeMemberId: string | undefined
  readonly readOnly: boolean
}
