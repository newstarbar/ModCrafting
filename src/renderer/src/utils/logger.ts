// Simple debug logger for ModCrafting
// All output goes to browser DevTools console (F12)

const DEBUG = true

const colors: Record<string, string> = {
  api: '#89b4fa',      // blue
  tool: '#a6e3a1',     // green
  stream: '#f9e2af',   // yellow
  agent: '#cba6f7',    // purple
  file: '#94e2d5',     // teal
  error: '#f38ba8',    // red
  ipc: '#fab387',      // orange
  mc: '#74c7ec',       // sky
  terminal: '#a6adc8'  // gray
}

function log(tag: string, msg: string, data?: unknown): void {
  if (!DEBUG) return
  const color = colors[tag] || '#cdd6f4'
  const style = `color:${color};font-weight:bold`
  if (data !== undefined) {
    console.log(`%c[${tag.toUpperCase()}] ${msg}`, style, data)
  } else {
    console.log(`%c[${tag.toUpperCase()}] ${msg}`, style)
  }
}

export const logger = {
  api: (msg: string, data?: unknown) => log('api', msg, data),
  tool: (msg: string, data?: unknown) => log('tool', msg, data),
  stream: (msg: string, data?: unknown) => log('stream', msg, data),
  agent: (msg: string, data?: unknown) => log('agent', msg, data),
  file: (msg: string, data?: unknown) => log('file', msg, data),
  error: (msg: string, data?: unknown) => log('error', msg, data),
  ipc: (msg: string, data?: unknown) => log('ipc', msg, data),
  mc: (msg: string, data?: unknown) => log('mc', msg, data),
  terminal: (msg: string, data?: unknown) => log('terminal', msg, data)
}
