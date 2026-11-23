/**
 * L3: bytecode patches.
 *
 * No bytecode engine ships with this release. Pretending to patch a jar with a
 * home-grown class rewriter would produce a file that either fails verification
 * or silently changes something else, so this level stops at a *plan*: the
 * requested class/method changes, the verified source hash, and the licence
 * decision. The plan is honest about `applied: false`; the caller can take it to
 * an external tool or choose the L2 companion route instead.
 *
 * The gate still applies before a plan is written: L3 requires modification
 * permission and per-use consent (enforced by `trust.ts` in the action layer).
 */

export interface BytecodePatch {
  className: string
  method: string
  description: string
}

export function buildBytecodePlan(input: {
  transformId: string
  entryId: string
  source: { fileName: string; sha1?: string; sha512?: string }
  patches: readonly BytecodePatch[]
  decision: { allowed: boolean; exportable: boolean; reasons: string[]; message: string; code?: string }
  generatedAt: string
}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    level: 'L3',
    transformId: input.transformId,
    entryId: input.entryId,
    createdAt: input.generatedAt,
    engine: 'not-shipped',
    applied: false,
    source: input.source,
    decision: input.decision,
    patches: input.patches.map((patch) => ({ ...patch })),
    notes: [
      '这份计划不会改写源 jar，也不代表补丁已经生效。',
      '当前版本不内置字节码引擎；优先改用 L2 伴生 Mod，或把计划交给受信任的外部工具。',
      '即使外部工具完成补丁，产物仍受许可证约束：不可再分发时只能留在本地。'
    ]
  }
}
