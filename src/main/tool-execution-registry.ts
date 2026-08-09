/** Owns cancellable agent-side main-process work. Never use it for user terminals. */
const executions = new Map<string, AbortController>()

export function beginToolExecution(id?: string): AbortSignal | undefined {
  if (!id) return undefined
  const previous = executions.get(id)
  previous?.abort(new Error('execution id replaced'))
  const controller = new AbortController()
  executions.set(id, controller)
  return controller.signal
}

export function finishToolExecution(id?: string): void {
  if (id) executions.delete(id)
}

export function cancelToolExecution(id: string): boolean {
  const controller = executions.get(id)
  if (!controller) return false
  controller.abort(new Error('cancelled by renderer'))
  return true
}
