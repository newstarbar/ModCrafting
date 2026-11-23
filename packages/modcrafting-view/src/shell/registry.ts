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
import type { PanelMeta, PanelScope } from './types.ts'

/** Declaration order drives the sidebar, so it is the shared list, not a copy. */
export const PANEL_ORDER: readonly PanelId[] = PANEL_IDS

/** Navigation groups, outermost first. A scope with no panels renders nothing. */
export const SCOPE_ORDER: readonly PanelScope[] = ['global', 'mod', 'modpack', 'instance']

export const SCOPE_LABELS: Record<PanelScope, string> = {
  global: '通用',
  mod: '单模组',
  modpack: '整合包',
  instance: '实例'
}

export const PANEL_META: Record<PanelId, PanelMeta> = {
  overview: { label: '概览', icon: '⌂', scope: 'global', requiresProject: false },
  content: { label: '内容', icon: '◇', scope: 'mod', requiresProject: true, hint: '先打开一个有效的模组工程，再编辑物品、方块与实体。' },
  textures: { label: '贴图', icon: '▩', scope: 'mod', requiresProject: true, hint: 'AI 贴图工作区需要一个有效工程来定位资源目录。' },
  paint: { label: '纹理画板', icon: '▧', scope: 'mod', requiresProject: true, hint: 'GUI 纹理保存在工程的 assets 下，请先打开工程。' },
  recipe: { label: '配方', icon: '▦', scope: 'mod', requiresProject: true, hint: '配方目录随 Minecraft 版本变化，需要一个声明了目标的工程。' },
  gui: { label: '界面', icon: '▣', scope: 'mod', requiresProject: true, hint: '界面工作区生成 Java 源码，需要有效工程。' },
  model: { label: '模型', icon: '⬡', scope: 'mod', requiresProject: true, hint: '体素模型编译为工程内的模型 JSON 与图集。' },
  build: { label: '构建', icon: '⚒', scope: 'mod', requiresProject: true, hint: '构建使用工程自带的 Gradle Wrapper。' },
  game: { label: '游戏', icon: '▶', scope: 'instance', requiresProject: true, hint: '启动测试游戏需要有效工程与 JDK 21；每次启动都属于一个独立实例。' },
  tests: { label: '测试', icon: '✓', scope: 'instance', requiresProject: true, hint: '游戏内验证要等测试世界准备完成，结果归属于当前实例。' },
  reports: { label: '报告', icon: '▤', scope: 'global', requiresProject: false },
  quest: {
    label: '任务书',
    icon: '⚑',
    scope: 'modpack',
    requiresProject: false,
    hint: '读取整合包的 config/ftbquests/quests。没有任务书时，请先安装 FTB Quests 并在游戏里创建第一个章节。'
  },
  pack: {
    label: '整合包',
    icon: '◫',
    scope: 'modpack',
    requiresProject: false,
    hint: '创建或读取 pack.json，加入条目，求解依赖并导出 .mrpack 或 Prism 实例。'
  },
  discover: {
    label: '发现模组',
    icon: '⌕',
    scope: 'modpack',
    requiresProject: false,
    hint: '描述整合包想做什么，工具会同时检索 Modrinth 与 CurseForge，并给出覆盖度与缺口。'
  },
  baseline: {
    label: '通用底座',
    icon: '▤',
    scope: 'modpack',
    requiresProject: false,
    hint: '选择性能、画面与操作底座；每一项都会按目标加载器与版本现查可用性。'
  },
  bridge: {
    label: '桥接',
    icon: '⇄',
    scope: 'modpack',
    requiresProject: false,
    hint: '为两个互不认识的模组生成可编译的 Fabric 桥接工程；适配器是唯一需要补完的地方。'
  },
  transform: {
    label: '改造',
    icon: '⚗',
    scope: 'modpack',
    requiresProject: false,
    hint: 'L1 资源覆盖与 L2 伴生 Mod 默认可用；L3/L4 需要许可证允许修改，并对本次操作明确确认。不可再分发的产物只能留在本地。'
  }
}

export function panelLabel(id: string): string {
  return isPanelId(id) ? PANEL_META[id].label : id
}

export function panelEntries(): Array<{ id: PanelId; meta: PanelMeta }> {
  return PANEL_ORDER.map((id) => ({ id, meta: PANEL_META[id] }))
}

/**
 * Panels that make sense for the current workspace kind.
 *
 * A modpack contains authored member projects, so it sees the mod panels too.
 * A single-mod workspace has no pack-level book or pack list, so those stay out.
 */
export function visiblePanels(kind: 'mod' | 'modpack' | undefined): Array<{ id: PanelId; meta: PanelMeta }> {
  const usable = kind ?? 'mod'
  const included: readonly PanelScope[] = usable === 'modpack'
    ? ['global', 'mod', 'modpack', 'instance']
    : ['global', 'mod', 'instance']
  return panelEntries().filter((entry) => included.includes(entry.meta.scope))
}

/** The sidebar model: ordered, non-empty groups of visible panels. */
export function panelGroups(kind: 'mod' | 'modpack' | undefined): Array<{ scope: PanelScope; label: string; entries: Array<{ id: PanelId; meta: PanelMeta }> }> {
  const visible = visiblePanels(kind)
  return SCOPE_ORDER
    .map((scope) => ({
      scope,
      label: SCOPE_LABELS[scope],
      entries: visible.filter((entry) => entry.meta.scope === scope)
    }))
    .filter((group) => group.entries.length > 0)
}
