/**
 * The licence and consent gate that sits in front of every transform level.
 *
 * The rules follow the product boundary:
 *  - L1/L2 never modify the third-party jar, so they are available locally for
 *    any licence. Their *output* is exportable only when the source licence
 *    allows redistribution; otherwise it stays a local artifact.
 *  - L3/L4 change or analyse third-party code, so they require a licence that
 *    permits modification and an explicit, per-use consent flag.
 *  - Every decision, including a refusal, is appended to an audit log. A refusal
 *    that is not recorded is indistinguishable from a tool that silently did
 *    nothing, which is exactly the failure mode this module exists to prevent.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { isModificationAllowedLicense } from '../license-policy.ts'
import type { PackLicense } from '../../workspace-model.ts'

export const TRANSFORM_LEVELS = ['L1', 'L2', 'L3', 'L4'] as const
export type TransformLevel = (typeof TRANSFORM_LEVELS)[number]

export const TRANSFORM_AUDIT_FILE = '.modcrafting/transform-audit.jsonl'
export const TRANSFORM_DECISION_CODES = [
  'TRANSFORM_LICENSE_BLOCKED',
  'TRANSFORM_CONSENT_REQUIRED'
] as const

export interface TransformDecision {
  allowed: boolean
  exportable: boolean
  reasons: string[]
  code?: string
  message: string
}

export interface TransformAuditRecord {
  schemaVersion: 1
  at: string
  action: 'apply' | 'rollback' | 'refuse'
  level: TransformLevel
  entryId?: string
  transformId?: string
  decision: { allowed: boolean; exportable: boolean; code?: string; message: string }
  source?: { fileName: string; sha1?: string; sha512?: string }
  detail?: string
}

export function evaluateTransform(input: { level: TransformLevel; license: PackLicense; consent?: boolean }): TransformDecision {
  const reasons: string[] = []
  const exportable = input.license.redistributable
  if (!exportable) {
    reasons.push(`许可证 ${input.license.id} 不允许再分发：改造产物只能留在本地，不能导出或发布。`)
  }

  if (input.level === 'L1' || input.level === 'L2') {
    return {
      allowed: true,
      exportable,
      reasons,
      message: input.level === 'L1'
        ? 'L1 资源/数据覆盖不修改第三方 jar，默认允许本地生成。'
        : 'L2 伴生 Mod 不修改第三方 jar，默认允许本地生成。'
    }
  }

  if (!isModificationAllowedLicense(input.license.id)) {
    return {
      allowed: false,
      exportable: false,
      reasons,
      code: 'TRANSFORM_LICENSE_BLOCKED',
      message: `许可证 ${input.license.id} 不允许修改原作品，L3/L4 被拒绝。请改用 L2 伴生 Mod，或联系作者取得书面许可。`
    }
  }
  if (input.consent !== true) {
    return {
      allowed: false,
      exportable: false,
      reasons,
      code: 'TRANSFORM_CONSENT_REQUIRED',
      message: `${input.level} 会读取或改写第三方代码，需要用户对这一次操作明确确认（consent=true）。`
    }
  }

  return {
    allowed: true,
    exportable: input.level === 'L4' ? false : exportable,
    reasons,
    message: input.level === 'L3'
      ? '许可证与本次确认都满足；L3 只生成补丁计划，不声称已改写字节。'
      : '许可证与本次确认都满足；L4 只做结构分析，产物永不可导出。'
  }
}

export function auditPath(root: string): string {
  return path.join(path.resolve(root), ...TRANSFORM_AUDIT_FILE.split('/'))
}

export function appendTransformAudit(root: string, record: TransformAuditRecord): string {
  const file = auditPath(root)
  mkdirSync(path.dirname(file), { recursive: true })
  appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8')
  return file
}

export function readTransformAudit(root: string): TransformAuditRecord[] {
  const file = auditPath(root)
  if (!existsSync(file)) return []
  const records: TransformAuditRecord[] = []
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const value = JSON.parse(line) as Partial<TransformAuditRecord>
      if (value.schemaVersion !== 1 || typeof value.at !== 'string' || !value.action || !value.level || !value.decision) continue
      records.push(value as TransformAuditRecord)
    } catch {
      // A truncated final line (process killed mid-write) must not hide the rest
      // of the audit. The malformed line is dropped, not invented.
    }
  }
  return records
}
