import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'

/** Capture our isolated local test page using the browser's official DevTools API. */
export async function captureWorkbench(executable, url, directory, {
  width = 1440,
  height = 1100,
  name = 'workbench',
  expectMobileNav = false,
  /** Override when capturing a panel other than the content editor. */
  readyExpression = "document.body?.innerText.includes('工作台已连接') && Boolean(document.querySelector('[aria-label=内容参数工作区]'))",
  /** Extra CDP steps after the page is ready and before the screenshot. */
  prepare
} = {}) {
  const child = spawn(executable, ['--headless=new', '--no-first-run', '--disable-extensions', '--remote-debugging-port=0', `--user-data-dir=${path.join(directory, `edge-profile-${name}`)}`, `--window-size=${width},${height}`, 'about:blank'], { windowsHide: true, env: { ...process.env, TEMP: directory, TMP: directory }, stdio: ['ignore', 'ignore', 'pipe'] })
  let socket, sequence = 0
  const pending = new Map()
  const exited = new Promise(resolve => child.once('close', resolve))
  try {
    const endpoint = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Browser debugging endpoint unavailable')), 15000)
      let output = ''
      child.stderr.on('data', part => { output += part; const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (match) { clearTimeout(timer); resolve(match[1]) } })
      child.once('error', error => { clearTimeout(timer); reject(error) })
    })
    const origin = new URL(endpoint); const pages = await (await fetch(`http://${origin.host}/json/list`)).json()
    socket = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl)
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
    socket.addEventListener('message', event => { const message = JSON.parse(event.data); const request = pending.get(message.id); if (request) { pending.delete(message.id); message.error ? request.reject(Error(message.error.message)) : request.resolve(message.result) } })
    const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })) })
    await send('Page.enable'); await send('Page.navigate', { url })
    const deadline = Date.now() + 15000
    while (true) {
      const ready = await send('Runtime.evaluate', { expression: readyExpression, returnByValue: true })
      if (ready.result.value) break
      if (Date.now() > deadline) throw Error('Workbench content was not rendered')
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    if (prepare) await prepare(send)
    const layout = await send('Runtime.evaluate', { expression: '({width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,overflow:document.documentElement.scrollWidth>innerWidth})', returnByValue: true })
    if (layout.result.value.overflow) throw Error(`Workbench overflows at ${layout.result.value.width}px viewport (${layout.result.value.scrollWidth}px content)`)
    if (expectMobileNav) {
      const mobile = await send('Runtime.evaluate', { expression: "getComputedStyle(document.querySelector('.mobile-nav')).display !== 'none'", returnByValue: true })
      if (!mobile.result.value) throw Error(`Mobile navigation is hidden at ${width}px viewport`)
    }
    await send('Runtime.evaluate', { expression: "document.documentElement.style.scrollBehavior='auto';document.getElementById('editor-content')?.scrollIntoView({behavior:'instant'})" })
    const captured = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
    await writeFile(path.join(directory, `${name}.png`), Buffer.from(captured.data, 'base64'))
    const dom = await send('Runtime.evaluate', { expression: 'document.documentElement.outerHTML', returnByValue: true })
    await send('Browser.close')
    return dom.result.value
  } finally {
    socket?.close()
    const timer = setTimeout(() => child.kill(), 3000)
    await exited; clearTimeout(timer)
  }
}
