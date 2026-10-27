import { GAME_TEST_WORLD, pointerValue, validateGameTestSpec, type GameAction, type GameAssertion, type GameTestSpec, type GameTestVerdict } from './domain.ts'
import { acceptanceVerdict, createAcceptanceReport, type AcceptanceReport } from './acceptance.ts'

export const SUPPORTED_GAME_ASSERTIONS = ['inventory_contains', 'block_equals', 'entity_exists', 'entity_attribute', 'entity_name', 'entity_team', 'snapshot_value', 'snapshot_changed'] as const
export type GameTestCode = 'INVALID_SPEC' | 'CAPABILITY_UNAVAILABLE' | 'EVIDENCE_MISSING' | 'ENVIRONMENT_UNAVAILABLE' | 'CLEANUP_FAILED' | 'ASSERTION_FAILED' | 'OK'
/** Explains why a live test cannot produce trustworthy evidence, before any job or game action starts. */
export function unsupportedGameTestEvidence(spec: { assertions: Array<{ type: string; source?: string; tag?: string }> }): string[] {
  const reasons: string[] = []
  spec.assertions.forEach((assertion, index) => {
    if (assertion.type === 'hud_text') reasons.push(`assertions[${index}]: hud_text 需要 HUD 文本快照，当前测试组件无法提供`)
    if (assertion.type === 'command_result') reasons.push(`assertions[${index}]: command_result 需要服务器命令返回值，当前测试组件无法提供`)
    if (assertion.source && /Trace$/.test(assertion.source)) reasons.push(`assertions[${index}]: ${assertion.source} 是历史/渲染轨迹，不是当前操作后的新鲜证据`)
    if (assertion.type === 'entity_exists' && assertion.tag) reasons.push(`assertions[${index}]: entity_exists 的 tag 过滤需要服务端实体标签，客户端快照无法证明`)
  })
  return reasons
}
type Snapshot = Record<string, unknown>
type BridgeResult = { ok: boolean; data: Snapshot }
export interface GameTestAdapter {
  snapshot(spec: GameTestSpec): Promise<BridgeResult>
  action(action: GameAction): Promise<BridgeResult>
  cancelled?(): boolean
}
type Evidence = { assertion: GameAssertion; passed: boolean; code: GameTestCode; detail: string }
const record = (value: unknown): value is Snapshot => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const equal = (a: unknown, b: unknown): boolean => {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, index) => equal(value, b[index]))
  if (record(a) && record(b)) return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((key) => Object.hasOwn(b, key) && equal(a[key], b[key]))
  return a === b
}

export function evaluateGameAssertion(assertion: GameAssertion, before: Snapshot, after: Snapshot): Evidence {
  const evidence = (passed: boolean, detail: string, code?: GameTestCode): Evidence => ({ assertion, passed, code: code || (passed ? 'OK' : 'ASSERTION_FAILED'), detail })
  const missing = (detail: string) => evidence(false, detail, 'EVIDENCE_MISSING')
  if (assertion.type === 'hud_text' || assertion.type === 'command_result' || ('source' in assertion && /Trace$/.test(assertion.source))) return evidence(false, 'This plugin cannot prove fresh trace or command-result evidence', 'CAPABILITY_UNAVAILABLE')
  if (assertion.type === 'inventory_contains') {
    const inventory = after.inventory
    const keys = ['hotbar', 'main', 'armor', 'offhand']
    if (!record(inventory) || inventory.ok === false || keys.some((key) => !Array.isArray(inventory[key]))) return missing('Inventory snapshot is incomplete')
    const items = keys.flatMap((key) => inventory[key] as unknown[])
    if (items.some((item) => !record(item) || (item.empty !== true && (typeof item.id !== 'string' || !Number.isInteger(item.count) || Number(item.count) < 0)))) return missing('Inventory entries are invalid')
    const count = items.filter((item) => record(item) && item.empty !== true && item.id === assertion.itemId).reduce<number>((sum, item) => sum + Number((item as Snapshot).count), 0)
    return evidence(count >= (assertion.countAtLeast ?? 1), `Observed ${count} of ${assertion.itemId}`)
  }
  if (assertion.type === 'block_equals') {
    if (!Array.isArray(after.blocks)) return missing('Block snapshot is missing')
    const block = after.blocks.find((item) => record(item) && item.x === assertion.x && item.y === assertion.y && item.z === assertion.z)
    if (!record(block) || block.ok === false || typeof block.blockId !== 'string') return missing('Requested block was not observed')
    return evidence(block.blockId === assertion.blockId, `Observed block ${block.blockId}`)
  }
  if (assertion.type === 'entity_exists') {
    if (!Array.isArray(after.entities) || after.entities.some((item) => !record(item) || item.ok === false || typeof item.type !== 'string' || (assertion.tag && !Array.isArray(item.tags)))) return missing('Entity query evidence is missing or invalid')
    const found = after.entities.some((item) => (!assertion.entityType || item.type === assertion.entityType) && (!assertion.tag || item.tags.includes(assertion.tag)))
    if (!found && after.entities.length >= 64) return missing('Observer entity query may be truncated')
    return evidence(found === (assertion.exists ?? true), `Entity match=${found}; Observer radius=32, maximum=64`)
  }
  if (assertion.type === 'entity_attribute' || assertion.type === 'entity_name' || assertion.type === 'entity_team') {
    if (!Array.isArray(after.entities) || after.entities.some((item) => !record(item) || item.ok === false)) return missing('Entity query evidence is missing or invalid')
    const target = assertion.target
    const rows = (after.entities as Array<Record<string, unknown>>).filter((item) => (!target.entityType || item.type === target.entityType) && (!target.name || item.name === target.name) && (!target.team || item.team === target.team))
    if (!rows.length) return evidence(false, `No entity matched ${JSON.stringify(target)}`)
    const entity = rows[0]
    if (assertion.type === 'entity_attribute') {
      const value = entity[assertion.attribute]
      if (typeof value !== 'number' || !Number.isFinite(value)) return missing(`Entity attribute ${assertion.attribute} was not observed`)
      const passed = (assertion.equals === undefined || value === assertion.equals) && (assertion.atLeast === undefined || value >= assertion.atLeast) && (assertion.atMost === undefined || value <= assertion.atMost)
      return evidence(passed, `${assertion.attribute}=${value} for ${String(entity.type)}`)
    }
    if (assertion.type === 'entity_name') {
      if (typeof entity.name !== 'string') return missing('Entity name was not observed')
      const passed = assertion.equals !== undefined ? entity.name === assertion.equals : entity.name.includes(assertion.contains!)
      return evidence(passed, `Observed name "${entity.name}"`)
    }
    if (typeof entity.team !== 'string') return missing('Entity scoreboard team was not observed')
    return evidence(entity.team === assertion.team, `Observed team "${entity.team}"`)
  }
  if (assertion.type === 'snapshot_value' || assertion.type === 'snapshot_changed') {
    const afterSource = after[assertion.source]
    const beforeSource = before[assertion.source]
    if ((record(afterSource) && afterSource.ok === false) || (record(beforeSource) && beforeSource.ok === false)) return missing('Snapshot source query failed')
    const afterValue = pointerValue(afterSource, assertion.pointer)
    if (afterValue === undefined) return missing('Snapshot value was not observed')
    if (assertion.type === 'snapshot_value') return evidence(equal(afterValue, assertion.equals), `${assertion.source}${assertion.pointer}`)
    const beforeValue = pointerValue(beforeSource, assertion.pointer)
    if (beforeValue === undefined) return missing('Baseline value was not observed')
    const passed = (assertion.from === undefined || equal(beforeValue, assertion.from)) && (assertion.to === undefined ? !equal(beforeValue, afterValue) : equal(afterValue, assertion.to))
    return evidence(passed, `${assertion.source}${assertion.pointer} changed`)
  }
  return evidence(false, 'Unsupported assertion', 'CAPABILITY_UNAVAILABLE')
}

export async function executeGameTest(raw: unknown, adapter: GameTestAdapter, version: string, execution: AcceptanceReport['execution'] = 'live'): Promise<Record<string, unknown>> {
  const parsed = validateGameTestSpec(raw)
  const report = { verdict: 'INCONCLUSIVE' as GameTestVerdict, code: 'INVALID_SPEC' as GameTestCode, reason: '', scenarioId: parsed.ok ? parsed.spec.id : null, version, evidenceSource: 'Observer V2 /v2/snapshot', supportedAssertions: SUPPORTED_GAME_ASSERTIONS, evidence: [] as Evidence[], snapshots: [] as Array<{ requestId: unknown; observedAt: unknown }>, cleanup: { attempted: false, completed: 0, failed: false, reason: '' } }
  const finish = () => ({ ...report, acceptance: createAcceptanceReport({ producer: 'core', execution, scenarioId: report.scenarioId, engineVersion: version, minecraftVersion: '1.21.4', evidenceSource: report.evidenceSource, verdict: report.verdict, code: report.code, reason: report.reason, evidence: report.evidence, cleanup: report.cleanup, snapshots: report.snapshots }) })
  if ('error' in parsed) { report.reason = parsed.error; return finish() }
  const spec = parsed.spec
  let safeWorld = false
  const fail = (code: GameTestCode, reason: string): never => { throw Object.assign(new Error(reason), { testCode: code }) }
  const takeSnapshot = async () => {
    const value = await adapter.snapshot(spec)
    if (!value.ok || value.data.ok === false) fail('EVIDENCE_MISSING', 'Observer snapshot query failed')
    if (value.data.worldName !== GAME_TEST_WORLD) fail('ENVIRONMENT_UNAVAILABLE', `Requires ${GAME_TEST_WORLD}`)
    return value.data
  }
  const actions = async (values: GameAction[]) => {
    for (const action of values) {
      if (adapter.cancelled?.()) fail('ENVIRONMENT_UNAVAILABLE', 'Test was cancelled')
      const value = await adapter.action(action)
      if (!value.ok || value.data.ok === false) fail('EVIDENCE_MISSING', `Action ${action.type} failed`)
    }
  }
  try {
    await takeSnapshot(); safeWorld = true
    await actions(spec.setup)
    const before = await takeSnapshot()
    await actions(spec.actions)
    const after = await takeSnapshot()
    report.snapshots = [before, after].map(({ requestId, observedAt }) => ({ requestId, observedAt }))
    if (typeof before.requestId !== 'string' || !before.requestId || typeof after.requestId !== 'string' || !after.requestId || before.requestId === after.requestId || !Number.isFinite(before.observedAt) || !Number.isFinite(after.observedAt) || Number(after.observedAt) < Number(before.observedAt)) fail('EVIDENCE_MISSING', 'Fresh distinct before/after snapshots are required')
    report.evidence = spec.assertions.map((assertion) => execution === 'live' && assertion.type === 'entity_exists' && assertion.tag
      ? { assertion, passed: false, code: 'CAPABILITY_UNAVAILABLE' as const, detail: 'Observer V2 client snapshots cannot verify server command tags' }
      : evaluateGameAssertion(assertion, before, after))
    const unavailable = report.evidence.find((row) => !['OK', 'ASSERTION_FAILED'].includes(row.code))
    if (unavailable) fail(unavailable.code, unavailable.detail)
    if (spec.visualOnly) fail('CAPABILITY_UNAVAILABLE', 'Visual-only tests require manual acceptance')
    report.verdict = acceptanceVerdict(report.evidence)
    report.code = report.verdict === 'PASS' ? 'OK' : 'ASSERTION_FAILED'
    report.reason = report.verdict === 'PASS' ? 'All supported assertions have fresh observed evidence' : 'Observed values do not satisfy the assertions'
  } catch (error) {
    report.code = (error as { testCode?: GameTestCode }).testCode || 'ENVIRONMENT_UNAVAILABLE'
    report.reason = (error as Error).message || 'Observer/action unavailable'
  } finally {
    if (safeWorld) {
      report.cleanup.attempted = true
      try {
        // Recheck the dedicated world before any cleanup command; never act in a newly switched real world.
        if (spec.cleanup.length) await takeSnapshot()
        for (const action of spec.cleanup) {
          try {
            const value = await adapter.action(action)
            if (!value.ok || value.data.ok === false) throw new Error('cleanup action failed')
            report.cleanup.completed++
          } catch { report.cleanup.failed = true }
        }
      } catch { report.cleanup.failed = true }
      if (report.cleanup.failed) { report.verdict = 'INCONCLUSIVE'; report.code = 'CLEANUP_FAILED'; report.reason = 'Cleanup could not be completed safely' }
    } else report.cleanup.reason = 'Skipped: dedicated test world was not established'
  }
  if (adapter.cancelled?.() && report.code !== 'CLEANUP_FAILED') { report.verdict = 'INCONCLUSIVE'; report.code = 'ENVIRONMENT_UNAVAILABLE'; report.reason = 'Test was cancelled' }
  return finish()
}
