export interface ToolActivityEntry {
  id: string
  name: string
  args?: Record<string, unknown>
  status: 'running' | 'done' | 'error'
  output?: string
  durationMs?: number
  timestamp: number
}

type Listener = (entries: ToolActivityEntry[]) => void

const MAX_ENTRIES = 80
let entries: ToolActivityEntry[] = []
const listeners = new Set<Listener>()

function notify(): void {
  const snapshot = [...entries]
  for (const listener of listeners) listener(snapshot)
}

export function getToolActivityEntries(): ToolActivityEntry[] {
  return [...entries]
}

export function subscribeToolActivity(listener: Listener): () => void {
  listeners.add(listener)
  listener([...entries])
  return () => listeners.delete(listener)
}

export function recordToolDispatch(name: string, id: string, args?: Record<string, unknown>): void {
  entries = [
    {
      id,
      name,
      args,
      status: 'running',
      timestamp: Date.now()
    },
    ...entries.filter((e) => e.id !== id)
  ].slice(0, MAX_ENTRIES)
  notify()
}

export function recordToolResult(
  name: string,
  id: string,
  output: string,
  options?: { error?: boolean; durationMs?: number }
): void {
  const existing = entries.find((e) => e.id === id)
  const next: ToolActivityEntry = {
    id,
    name,
    args: existing?.args,
    status: options?.error ? 'error' : 'done',
    output,
    durationMs: options?.durationMs,
    timestamp: existing?.timestamp || Date.now()
  }
  entries = [next, ...entries.filter((e) => e.id !== id)].slice(0, MAX_ENTRIES)
  notify()
}

export function clearToolActivity(): void {
  entries = []
  notify()
}
