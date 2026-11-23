/**
 * One gate for "is this project a target I can author against".
 *
 * Before this existed the same line was copy-pasted into five workspaces and the
 * browser server, each hard-coding `!== '1.21.4'`. The gate keeps the authoring
 * workspaces single-loader (they emit Yarn/Fabric code) while letting the target
 * version come from the catalog instead of a literal.
 */
import type { FabricProject } from '../contracts.ts'
import { deriveResourceLayout, type ResourceLayout } from '../resources/layout.ts'
import { FABRIC_TARGET } from '../domain.ts'
import { getRegistry } from './registry.ts'
import { describeProjectTarget, type ProjectTarget } from './targets.ts'

export interface ProjectLayout {
  layout: ResourceLayout
  minecraft: string
  /** False when the version was missing or unparseable and we fell back to the pinned target. */
  exact: boolean
  warning?: string
}

/**
 * Reading paths for a project that may not declare a usable version.
 * Authoring tools must not refuse to work just because gradle.properties is
 * stale — they need a layout, plus an honest note about what they assumed.
 */
export function projectLayout(project: FabricProject): ProjectLayout {
  const raw = project.minecraftVersion?.trim()
  const fallback: ProjectLayout = {
    layout: deriveResourceLayout(FABRIC_TARGET.minecraft, getRegistry()),
    minecraft: FABRIC_TARGET.minecraft,
    exact: false,
    warning: '工程缺少可用的 minecraft_version，暂按 1.21.4 处理；请在 gradle.properties 声明目标版本'
  }
  if (!raw) return fallback
  try {
    const target = describeProjectTarget('fabric', raw)
    return { layout: target.layout, minecraft: raw, exact: true }
  } catch (cause) {
    return { ...fallback, warning: `${(cause as Error).message}；暂按 1.21.4 处理` }
  }
}

export interface ProjectGate {
  ok: boolean
  /** Always present so callers can fail without a narrowing dance. */
  message: string
  target?: ProjectTarget
}

export function gateFabricProject(project: FabricProject): ProjectGate {
  if (!project.valid || !project.modId) {
    return { ok: false, message: `需要有效的 Fabric 工程：${project.errors.join('; ') || '未知原因'}` }
  }
  const raw = project.minecraftVersion?.trim()
  if (!raw) {
    return { ok: false, message: '工程缺少 minecraft_version；先在 gradle.properties 里声明目标版本（例如 1.21.4 或 26.3）' }
  }
  try {
    return { ok: true, message: '', target: describeProjectTarget('fabric', raw) }
  } catch (cause) {
    const error = cause as { message?: string; remediation?: string }
    return { ok: false, message: [error.message, error.remediation].filter(Boolean).join('；') || `无法识别目标版本 ${raw}` }
  }
}
