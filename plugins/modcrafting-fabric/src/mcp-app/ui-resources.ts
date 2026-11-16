/**
 * MCP Apps (ui://) descriptors shared by the server and the widget bundle.
 *
 * Scope note: these cards are read-only snapshots. Full editing lives in the loopback workbench,
 * because a widget that called back into the server would trigger a host permission dialog for
 * every refresh.
 */
export const UI_MIME = 'text/html;profile=mcp-app'
export const WIDGET_MAX_BYTES = 256 * 1024

export type UiPreset = 'session' | 'project' | 'media'

/** Tools whose structuredContent renders well as a card, and which card they use. */
export const UI_TOOLS: Record<string, UiPreset> = {
  modcrafting_session: 'session',
  fabric_job_status: 'session',
  minecraft_runtime_status: 'session',
  minecraft_test_status: 'session',
  modcrafting_environment_status: 'project',
  fabric_project_inspect: 'project',
  fabric_validate: 'project',
  fabric_texture_workspace: 'media',
  fabric_gui_texture_workspace: 'media',
  minecraft_screenshot: 'media'
}

export const uriOf = (preset: UiPreset) => `ui://modcrafting/${preset}.html`

export function uiMetaFor(tool: string): { ui: { resourceUri: string } } | undefined {
  const preset = UI_TOOLS[tool]
  return preset ? { ui: { resourceUri: uriOf(preset) } } : undefined
}

const CSS = `
:root{color-scheme:light dark;--bg:#ffffff;--fg:#1c2b16;--muted:#5d6b57;--line:#dfe5d8;--accent:#4d7c2a;--warn:#9a6200;--bad:#a3282c;--chip:#f1f5ea}
@media (prefers-color-scheme:dark){:root{--bg:#171a15;--fg:#eef2e8;--muted:#a3ada0;--line:#2c332a;--accent:#9ec56f;--warn:#e2b25c;--bad:#f08a8d;--chip:#232a20}}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:var(--bg);color:var(--fg)}
body{font:13px/1.55 -apple-system,"Segoe UI",system-ui,"PingFang SC","Microsoft YaHei",sans-serif;padding:12px 14px}
h1{margin:0 0 2px;font-size:14px;font-weight:600}
.sub{color:var(--muted);font-size:12px;margin-bottom:10px}
.row{display:flex;gap:8px;align-items:baseline;padding:3px 0}
.row>span:first-child{color:var(--muted);min-width:76px;flex:none}
.row>span:last-child{word-break:break-all}
.chip{display:inline-block;padding:1px 8px;border-radius:999px;background:var(--chip);font-size:12px}
.pass{color:var(--accent);font-weight:600}
.fail{color:var(--bad);font-weight:600}
.unknown{color:var(--warn);font-weight:600}
table{width:100%;border-collapse:collapse;margin-top:8px;font-size:12px}
th,td{text-align:left;padding:4px 6px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:500}
ul{margin:8px 0 0;padding-left:18px}
li{margin:2px 0}
.notice{margin-top:10px;color:var(--muted);font-size:12px}
img{max-width:100%;image-rendering:pixelated;border:1px solid var(--line);border-radius:6px;margin-top:8px;background:#0002}
.empty{color:var(--muted)}
code{font-family:ui-monospace,Consolas,monospace;font-size:12px}
`

/** Self-contained document: no <script src>, no <link>, no network fetch. */
export function widgetHtml(preset: UiPreset, script: string) {
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>ModCrafting</title><style>${CSS}</style></head>`
    + `<body data-preset="${preset}"><div id="root"><p class="empty">等待 ModCrafting 工具结果…</p></div>`
    + `<script>${script.replace(/<\/(script)/gi, '<\\/$1')}</script></body></html>`
  if (Buffer.byteLength(html) > WIDGET_MAX_BYTES) throw new Error('WIDGET_TOO_LARGE: the MCP Apps host stops inlining HTML above 256KB')
  return html
}
