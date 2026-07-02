export interface ParsedPlanStep {
  id: string
  description: string
}

const OPS_STEP_PATTERN = /gradlew|gradle\s|runClient|trigger_build|run_command|编译|构建|运行|build/i

/** Parse numbered plan lines from AI markdown text */
export function parsePlanSteps(text: string): ParsedPlanStep[] {
  const steps: ParsedPlanStep[] = []
  const lines = text.split('\n')
  let idCounter = 0
  for (const line of lines) {
    const trimmed = line.replace(/^[\s*\-]+/, '').trim()
    const match = trimmed.match(/^(\d+)[.\、\s]+(.+)$/)
    if (match) {
      idCounter++
      steps.push({
        id: String(idCounter),
        description: match[2].trim()
      })
    }
  }
  return steps
}

/** True when every parsed step is build/run ops (no file authoring). */
export function isOpsOnlyPlan(steps: ParsedPlanStep[]): boolean {
  if (steps.length === 0) return false
  return steps.every((s) => OPS_STEP_PATTERN.test(s.description))
}

export function planHasActionableSteps(text: string): boolean {
  return parsePlanSteps(text).length >= 1
}
