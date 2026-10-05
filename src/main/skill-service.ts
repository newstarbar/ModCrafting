import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { getRuntimeRoot } from './build-env'
import { loadAgentConfig } from './agent-config'
import { createMdTreeStore, type MdTreeStore } from './md-tree-store'
import { isSkillId, listSkillsFromTree, loadSkillFromTree, skillRelPath } from './skill-catalog'
import type { SkillDescriptor, SkillReadResult, SkillWriteResult } from '../shared/skills'

export type { SkillDescriptor, SkillReadResult, SkillWriteResult }
export { isSkillId, parseSkillMarkdown, listSkillsFromTree, loadSkillFromTree } from './skill-catalog'

function bundledSkillsRoot(): string {
  // 与 agent-knowledge 相同的三层解析：安装目录 runtime → 打包 resourcesPath → 开发态 resources
  const runtimePath = path.join(getRuntimeRoot(), 'skills')
  if (fs.existsSync(runtimePath)) return runtimePath
  if (app.isPackaged) return path.join(process.resourcesPath, 'skills')
  return path.join(app.getAppPath(), 'resources', 'skills')
}

function store(): MdTreeStore {
  return createMdTreeStore({
    bundledRoot: bundledSkillsRoot(),
    overrideRoot: path.join(app.getPath('userData'), 'skills')
  })
}

export function listSkills(): SkillDescriptor[] {
  return listSkillsFromTree(store(), loadAgentConfig().disabledSkills || [])
}

export function readSkill(id: string): SkillReadResult {
  return loadSkillFromTree(store(), id, loadAgentConfig().disabledSkills || [])
}

export function saveSkill(id: string, content: string): SkillWriteResult {
  if (!isSkillId(id)) return { success: false, error: `非法技能 id：${id}` }
  if (typeof content !== 'string' || !content.trim()) return { success: false, error: '技能内容为空' }
  return store().save(skillRelPath(id), content)
}

/** Removes the user copy so the bundled skill shows through again. */
export function deleteSkillOverride(id: string): SkillWriteResult {
  if (!isSkillId(id)) return { success: false, error: `非法技能 id：${id}` }
  return store().deleteOverride(skillRelPath(id))
}
