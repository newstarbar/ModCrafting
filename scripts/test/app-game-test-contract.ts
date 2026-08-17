export interface AppGameTestContract {
  /** A formal Suite stage must demonstrate that this turn actually changed
   * project source before it built and launched the client. */
  requiredProjectWrite?: boolean
  /** Build and launch tasks that must have succeeded in the same fresh event
   * window as the linked scenario PASS. */
  requiredBuildTasks?: Array<'build' | 'runClient'>
  requiredAssertions?: Array<Record<string, unknown>>
  requiredInputKeys?: Record<string, number>
  minimumWaitMs?: number
  requiredCommandPatterns?: string[]
  /** Number of independently recorded PASS runs required for the linked
   * scenario.  The complete-project regression uses two: one initial pass
   * and one full pass after restarting the game. */
  minimumPassCount?: number
  requiredCheckpoints?: string[]
  requiredActionTypes?: string[]
  requiredRelationOperators?: string[]
  requireIndependentReplay?: boolean
  requireIndependentProcess?: boolean
  requireIndependentWindowSize?: boolean
  requireApprovedLayout?: boolean
  requiredCombatAttribution?: boolean
  requiredWaitUntilConditions?: string[]
}

export interface AppGameTestContractResult {
  passed: boolean
  scenarioId?: string
  details: string[]
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function parseArgs(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return record(value)
  try { return record(JSON.parse(value)) } catch { return {} }
}

function structuralMatch(actual: unknown, expected: unknown): boolean {
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    const actualRecord = record(actual)
    return Object.entries(expected as Record<string, unknown>)
      .every(([key, value]) => structuralMatch(actualRecord[key], value))
  }
  return JSON.stringify(actual) === JSON.stringify(expected)
}

function auditCompiledArgs(args: Record<string, unknown>, contract: AppGameTestContract): string[] {
  const details: string[] = []
  if (typeof contract.minimumPassCount === 'number' && contract.minimumPassCount > 1) {
    const declaredPassCount = Number(args.requiredPassCount ?? args.required_pass_count ?? 1)
    if (!Number.isInteger(declaredPassCount) || declaredPassCount < contract.minimumPassCount) {
      details.push(`requiredPassCount ${declaredPassCount} < ${contract.minimumPassCount}`)
    }
  }
  const assertions = Array.isArray(args.assertions) ? args.assertions : []
  const used = new Set<number>()
  for (const expected of contract.requiredAssertions || []) {
    const index = assertions.findIndex((actual, candidate) => !used.has(candidate) && structuralMatch(actual, expected))
    if (index < 0) details.push(`missing assertion ${JSON.stringify(expected)}`)
    else used.add(index)
  }

  const actions = Array.isArray(args.actions) ? args.actions.map(record) : []
  const checkpoints = new Set(Array.isArray(args.checkpoints) ? args.checkpoints.map(String) : [])
  for (const required of contract.requiredCheckpoints || []) if (!checkpoints.has(required)) details.push(`missing checkpoint ${required}`)
  for (const required of contract.requiredActionTypes || []) if (!actions.some((action) => String(action.type) === required)) details.push(`missing action type ${required}`)
  const relationOperators = assertions.filter((assertion) => assertion.type === 'snapshot_relation').map((assertion) => String(assertion.operator))
  for (const required of contract.requiredRelationOperators || []) if (!relationOperators.includes(required)) details.push(`missing relation operator ${required}`)
  if (contract.requireApprovedLayout && (!String(args.approvedLayoutId || '') || !String(args.approvedLayoutFingerprint || ''))) details.push('missing approved HUD layout id/fingerprint')
  if (contract.requiredCombatAttribution && !assertions.some((assertion) => assertion.type === 'combat_event' && assertion.attackerIsPlayer === true && (typeof assertion.attackerUuid === 'string' && assertion.attackerUuid.trim() || typeof assertion.attackerCheckpoint === 'string' && assertion.attackerCheckpoint.trim()) && assertion.killed === true)) {
    details.push('missing player combat attribution bound to attackerUuid or attackerCheckpoint')
  }
  for (const required of contract.requiredWaitUntilConditions || []) {
    if (!actions.some((action) => action.type === 'wait_until' && String(action.condition) === required)) details.push(`missing wait_until condition ${required}`)
  }
  const observedKeys: Record<string, number> = {}
  for (const action of actions) {
    if (action.type !== 'input') continue
    const name = String(action.action || '').toLowerCase()
    if (name !== 'key' && name !== 'key_press') continue
    const key = String(record(action.args).key || action.key || '').toLowerCase()
    if (key) observedKeys[key] = (observedKeys[key] || 0) + 1
  }
  for (const [key, count] of Object.entries(contract.requiredInputKeys || {})) {
    if ((observedKeys[key.toLowerCase()] || 0) < count) details.push(`input key ${key} count < ${count}`)
  }

  if (typeof contract.minimumWaitMs === 'number') {
    const longest = actions.reduce((max, action) => action.type === 'wait' ? Math.max(max, Number(action.ms || 0)) : max, 0)
    if (longest < contract.minimumWaitMs) details.push(`longest wait ${longest}ms < ${contract.minimumWaitMs}ms`)
  }

  const commands = actions.filter((action) => action.type === 'command').map((action) => String(action.command || '')).join('\n')
  for (const pattern of contract.requiredCommandPatterns || []) {
    try {
      if (!new RegExp(pattern, 'i').test(commands)) details.push(`missing command pattern /${pattern}/i`)
    } catch {
      details.push(`invalid command pattern /${pattern}/i`)
    }
  }
  return details
}

/** Correlate a PASS mc_run_test result to the exact V2 scenario that compiled
 * it, then audit that scenario's structural coverage. */
export function evaluateAppGameTestContract(
  harnessEvents: Array<Record<string, unknown>>,
  contract: AppGameTestContract | undefined
): AppGameTestContractResult {
  if (!contract) return { passed: true, details: [] }
  const minimumPassCount = Number.isInteger(contract.minimumPassCount) && Number(contract.minimumPassCount) > 0
    ? Number(contract.minimumPassCount)
    : 1
  const passResults = harnessEvents.filter((event) => {
    const tool = record(event.tool)
    const validation = record(tool.validation)
    return event.kind === 'ToolResult' && tool.name === 'mc_run_test' && validation.verdict === 'PASS' && validation.diagnosticReplay !== true
  })
  const compilerResults = harnessEvents.filter((event) => {
    const tool = record(event.tool)
    return event.kind === 'ToolResult' && tool.name === 'mc_test_scenario' && typeof tool.output === 'string'
  })
  const planStates = harnessEvents.filter((event) => event.kind === 'PlanState')
  const attempted: string[] = []
  const stagePrerequisiteErrors: string[] = []

  const successfulToolResults = harnessEvents.filter((event) => {
    const tool = record(event.tool)
    return event.kind === 'ToolResult' && tool.outcome === 'succeeded' && !tool.error
  })
  const successfulEventIndex = (predicate: (event: Record<string, unknown>) => boolean): number => harnessEvents.findIndex((event) => predicate(event) && record(event.tool).outcome === 'succeeded' && !record(event.tool).error)
  const writeEventIndex = successfulEventIndex((event) => {
    const name = String(record(event.tool).name || '')
    return name === 'write_file' || name === 'edit_file' || name === 'delete_file'
  })
  if (contract.requiredProjectWrite) {
    const wroteProject = successfulToolResults.some((event) => {
      const name = String(record(event.tool).name || '')
      return name === 'write_file' || name === 'edit_file' || name === 'delete_file'
    })
    if (!wroteProject) stagePrerequisiteErrors.push('stage has no successful project source write')
  }
  let previousBuildIndex = -1
  for (const requiredTask of contract.requiredBuildTasks || []) {
    const buildPredicate = (event: Record<string, unknown>): boolean => {
      const tool = record(event.tool)
      if (String(tool.name || '') !== 'trigger_build') return false
      const args = parseArgs(tool.args)
      if (String(args.task || 'build') !== requiredTask) return false
      // `runClient` is only considered a launch when the host reached the
      // ready marker; a dispatched Gradle task or menu phase is insufficient.
      if (requiredTask === 'runClient') return /\[MC_PHASE:ready\]/i.test(String(tool.output || ''))
      return !/\bBUILD\s+(?:FAILED|FAILURE)\b|\[MC_PHASE:error\]/i.test(String(tool.output || ''))
    }
    const buildIndex = successfulEventIndex(buildPredicate)
    const built = buildIndex >= 0
    if (!built) stagePrerequisiteErrors.push(`missing successful trigger_build task ${requiredTask}`)
    else {
      if (contract.requiredProjectWrite && writeEventIndex >= 0 && buildIndex < writeEventIndex) stagePrerequisiteErrors.push(`trigger_build task ${requiredTask} occurred before the stage source write`)
      if (previousBuildIndex >= 0 && buildIndex < previousBuildIndex) stagePrerequisiteErrors.push(`trigger_build task order is invalid for ${requiredTask}`)
      previousBuildIndex = buildIndex
    }
  }

  const validPassesByScenario = new Map<string, number>()
  const replayEvidenceByScenario = new Map<string, Set<string>>()
  const processEvidenceByScenario = new Map<string, Set<string>>()
  const windowEvidenceByScenario = new Map<string, Set<string>>()
  const scenarioIdentityByScenario = new Map<string, Set<string>>()
  for (const pass of passResults) {
    const passTool = record(pass.tool)
    const scenarioId = String(parseArgs(passTool.args).scenarioId || '')
    if (!scenarioId) continue
    const compiled = compilerResults.find((event) => {
      const output = String(record(event.tool).output || '')
      return output.includes(`\"id\": \"${scenarioId}\"`) || output.includes(`\"id\":\"${scenarioId}\"`)
    })
    const plannedSpec = [...planStates].reverse().flatMap((event) => Array.isArray(event.planSteps) ? event.planSteps : [])
      .map(record)
      .map((step) => record(step.gameTest))
      .find((gameTest) => gameTest.id === scenarioId)
    if (!compiled && !plannedSpec) {
      attempted.push(`PASS scenario ${scenarioId} has no linked compiler evidence`)
      continue
    }
    const compiledArgs = compiled ? parseArgs(record(compiled.tool).args) : plannedSpec!
    const details = auditCompiledArgs(compiledArgs, contract)
    if (details.length === 0) {
      validPassesByScenario.set(scenarioId, (validPassesByScenario.get(scenarioId) || 0) + 1)
      const validation = record(passTool.validation)
      const identity = `${String(validation.scenarioRevision || '')}|${String(validation.scenarioFingerprint || '')}|${String(validation.acceptanceContractFingerprint || '')}`
      const identities = scenarioIdentityByScenario.get(scenarioId) || new Set<string>()
      identities.add(identity)
      scenarioIdentityByScenario.set(scenarioId, identities)
      const observer = String(validation.observerSessionId || '')
      const variant = String(validation.variantFingerprint || '')
      const evidenceKey = observer && variant ? observer + '|' + variant : ''
      const evidenceSet = replayEvidenceByScenario.get(scenarioId) || new Set<string>()
      if (evidenceKey) evidenceSet.add(evidenceKey)
      replayEvidenceByScenario.set(scenarioId, evidenceSet)
      const processId = String(validation.minecraftProcessId || validation.instanceId || '')
      const processSet = processEvidenceByScenario.get(scenarioId) || new Set<string>()
      if (processId) processSet.add(processId)
      processEvidenceByScenario.set(scenarioId, processSet)
      const windowFingerprint = String(validation.windowFingerprint || '')
      const windowSet = windowEvidenceByScenario.get(scenarioId) || new Set<string>()
      if (windowFingerprint) windowSet.add(windowFingerprint)
      windowEvidenceByScenario.set(scenarioId, windowSet)
      continue
    }
    attempted.push(...details.map((detail) => `${scenarioId}: ${detail}`))
  }
  for (const [scenarioId, passCount] of validPassesByScenario) {
    const independent = replayEvidenceByScenario.get(scenarioId)?.size || 0
    const independentProcesses = processEvidenceByScenario.get(scenarioId)?.size || 0
    const independentWindows = windowEvidenceByScenario.get(scenarioId)?.size || 0
    const identityCount = scenarioIdentityByScenario.get(scenarioId)?.size || 0
    const identityOk = identityCount <= 1
    if (stagePrerequisiteErrors.length === 0 && passCount >= minimumPassCount && identityOk && (!contract.requireIndependentReplay || independent >= minimumPassCount) && (!contract.requireIndependentProcess || independentProcesses >= minimumPassCount) && (!contract.requireIndependentWindowSize || independentWindows >= minimumPassCount)) return { passed: true, scenarioId, details: [] }
    if (!identityOk) attempted.push(`scenario ${scenarioId} revision/fingerprint changed across passes`)
    if (contract.requireIndependentReplay && independent < minimumPassCount) attempted.push(`scenario ${scenarioId} independent replay evidence ${independent} < required ${minimumPassCount}`)
    if (contract.requireIndependentProcess && independentProcesses < minimumPassCount) attempted.push(`scenario ${scenarioId} independent process evidence ${independentProcesses} < required ${minimumPassCount}`)
    if (contract.requireIndependentWindowSize && independentWindows < minimumPassCount) attempted.push(`scenario ${scenarioId} independent window evidence ${independentWindows} < required ${minimumPassCount}`)
    if (passCount < minimumPassCount) {
      attempted.push(`scenario ${scenarioId} PASS count ${passCount} < required ${minimumPassCount}`)
    }
  }
  if (minimumPassCount > 1 && validPassesByScenario.size === 0) {
    attempted.push(`no linked PASS scenario satisfies required count ${minimumPassCount}`)
  }
  return { passed: false, details: [...stagePrerequisiteErrors, ...(attempted.length ? attempted : ['no linked PASS game-test scenario'])] }
}
