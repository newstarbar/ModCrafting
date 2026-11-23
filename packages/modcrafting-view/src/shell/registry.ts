/**
 * Panel registry: the single place that says which panels exist and what they
 * are called.
 *
 * The id list itself lives in `core/src/panels.ts`, because the MCP session tool
 * and `open_workbench` validate against it too. This file only attaches labels
 * and layout hints, and `Record<PanelId, PanelMeta>` makes a missing entry a
 * compile error rather than a blank tab at runtime.
 */

import { PANEL_IDS, isPanelId, type PanelId } from '../../../modcrafting-core/src/panels.ts'
import type { PanelMeta } from './types.ts'

/** Declaration order drives the sidebar, so it is the shared list, not a copy. */
export const PANEL_ORDER: readonly PanelId[] = PANEL_IDS

export const PANEL_META: Record<PanelId, PanelMeta> = {
  overview: { label: '概览', icon: '⌂', scope: 'global', requiresProject: false },
  content: { label: '内容', icon: '◇', scope: 'mod', requiresProject: true, hint: '先打开一个有效的模组工程，再编辑物品、方块与实体。' },
  textures: { label: '贴图', icon: '▩', scope: 'mod', requiresProject: true, hint: 'AI 贴图工作区需要一个有效工程来定位资源目录。' },
  paint: { label: '纹理画板', icon: '▧', scope: 'mod', requiresProject: true, hint: 'GUI 纹理保存在工程的 assets 下，请先打开工程。' },
  recipe: { label: '配方', icon: '▦', scope: 'mod', requiresProject: true, hint: '配方目录随 Minecraft 版本变化，需要一个声明了目标的工程。' },
  gui: { label: '界面', icon: '▣', scope: 'mod', requiresProject: true, hint: '界面工作区生成 Java 源码，需要有效工程。' },
  model: { label: '模型', icon: '⬡', scope: 'mod', requiresProject: true, hint: '体素模型编译为工程内的模型 JSON 与图集。' },
  build: { label: '构建', icon: '⚒', scope: 'mod', requiresProject: true, hint: '构建使用工程自带的 Gradle Wrapper。' },
  game: { label: '游戏', icon: '▶', scope: 'mod', requiresProject: true, hint: '启动测试游戏需要有效工程与 JDK 21。' },
  tests: { label: '测试', icon: '✓', scope: 'mod', requiresProject: true, hint: '游戏内验证要等测试世界准备完成。' },
  reports: { label: '报告', icon: '▤', scope: 'global', requiresProject: false },
  quest: {
    label: '任务书',
    icon: '⚑',
    scope: 'modpack',
    requiresProject: false,
    hint: '读取整合包的 config/ftbquests/quests。没有任务书时，请先安装 FTB Quests 并在游戏里创建第一个章节。'
  }
}

export function panelLabel(id: string): string {
  return isPanelId(id) ? PANEL_META[id].label : id
}

export function panelEntries(): Array<{ id: PanelId; meta: PanelMeta }> {
  return PANEL_ORDER.map((id) => ({ id, meta: PANEL_META[id] }))
}

/** Panels that make sense for the current workspace kind. */
export function visiblePanels(kind: 'mod' | 'modpack' | undefined): Array<{ id: PanelId; meta: PanelMeta }> {
  const usable = kind ?? 'mod'
  return panelEntries().filter((entry) => entry.meta.scope === 'global' || entry.meta.scope === usable)
}
