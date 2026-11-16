/**
 * Host registry: one record per supported Agent, all facts in one place.
 *
 * Every path is a function so a redirected HOME/APPDATA (tests, CI) is honoured.
 * `verified` means "checked against the host's current documentation and a real
 * config file layout"; `partial` hosts only get writes when their parent
 * directory already exists, and the installer never guesses a deep path.
 */
import path from 'node:path'

export const SERVER_NAME = 'modcrafting-fabric'
export const SKILL_NAMES = ['modcrafting-start', 'fabric-mod-development', 'fabric-game-validation']

const posix = (ctx) => ctx.platform !== 'win32'

function firstExisting(candidates, fsExists) {
  for (const candidate of candidates) if (fsExists(candidate)) return candidate
  return candidates[0]
}

/** Standard stdio entry used by most hosts. */
function stdioEntry(ctx, extra = {}) {
  return { command: ctx.node, args: [ctx.script, ...ctx.flags], env: { MODCRAFTING_DATA: ctx.dataDir }, ...extra }
}

export const HOSTS = [
  {
    id: 'codex',
    aliases: ['codex-cli'],
    label: 'OpenAI Codex CLI',
    docsUrl: 'https://developers.openai.com/codex/',
    verified: 'yes',
    restartHint: '重启 Codex 会话（或用 /mcp 查看连接状态）',
    config: {
      kind: 'toml',
      paths: (ctx) => [path.join(ctx.home, '.codex', 'config.toml')],
      createParents: true,
      entry: (ctx) => ({ command: ctx.node, args: [ctx.script, ...ctx.flags], cwd: ctx.bundleDir, env: { MODCRAFTING_DATA: ctx.dataDir } })
    },
    skills: {
      global: (ctx) => [path.join(ctx.home, '.codex', 'skills'), path.join(ctx.home, '.agents', 'skills')],
      project: () => '.codex/skills'
    },
    plugin: { dir: '.codex-plugin', install: 'codex plugin marketplace add newstarbar/ModCrafting' },
    detect: { env: ['CODEX_HOME', 'CODEX_CI', 'CODEX_SANDBOX'], paths: (ctx) => [path.join(ctx.home, '.codex')] },
    quirks: ['写入 ~/.codex/config.toml 的 [mcp_servers.modcrafting-fabric] 块，保留其它内容']
  },
  {
    id: 'claude',
    aliases: ['claude-code'],
    label: 'Claude Code',
    docsUrl: 'https://code.claude.com/docs',
    verified: 'yes',
    restartHint: '重启 claude 会话；用 /mcp 确认已连接',
    config: {
      kind: 'json',
      paths: (ctx) => [path.join(ctx.home, '.claude.json')],
      rootKey: ['mcpServers'],
      createParents: true,
      entry: (ctx) => stdioEntry(ctx)
    },
    skills: { global: (ctx) => [path.join(ctx.home, '.claude', 'skills')], project: () => '.claude/skills' },
    plugin: { dir: '.claude-plugin', install: 'claude plugin marketplace add newstarbar/ModCrafting' },
    detect: { env: ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_PROJECT_DIR'], paths: (ctx) => [path.join(ctx.home, '.claude'), path.join(ctx.home, '.claude.json')] },
    quirks: ['~/.claude.json 同时保存会话状态，文件较大或刚被写入时改用 claude mcp add -s user']
  },
  {
    id: 'cursor',
    aliases: [],
    label: 'Cursor',
    docsUrl: 'https://cursor.com/docs',
    verified: 'yes',
    restartHint: '重启 Cursor（或 Settings → MCP 里重新加载）',
    config: {
      kind: 'json',
      paths: (ctx) => [path.join(ctx.home, '.cursor', 'mcp.json')],
      rootKey: ['mcpServers'],
      createParents: true,
      entry: (ctx) => stdioEntry(ctx, { type: 'stdio' })
    },
    skills: { global: (ctx) => [path.join(ctx.home, '.cursor', 'skills')], project: () => '.cursor/skills' },
    plugin: null,
    detect: { env: ['CURSOR_TRACE_ID', 'CURSOR_AGENT'], paths: (ctx) => [path.join(ctx.home, '.cursor')] },
    quirks: ['Cursor 要求条目显式声明 "type": "stdio"', 'GUI 启动，配置里写 node 绝对路径']
  },
  {
    id: 'devin',
    aliases: ['devin-cli'],
    label: 'Devin CLI',
    docsUrl: 'https://docs.devin.ai/cli',
    verified: 'yes',
    restartHint: '重启 devin 会话，或用 devin mcp list 检查',
    config: {
      kind: 'json',
      paths: (ctx) => [posix(ctx) ? path.join(ctx.configHome, 'devin', 'mcp_config.json') : path.join(ctx.appData, 'devin', 'mcp_config.json')],
      rootKey: ['mcpServers'],
      createParents: true,
      entry: (ctx) => stdioEntry(ctx, { type: 'stdio' })
    },
    skills: {
      global: (ctx) => [posix(ctx) ? path.join(ctx.configHome, 'devin', 'skills') : path.join(ctx.appData, 'devin', 'skills')],
      project: () => '.devin/skills'
    },
    plugin: null,
    detect: { env: ['DEVIN_API_KEY', 'DEVIN_SESSION_ID'], paths: (ctx) => [posix(ctx) ? path.join(ctx.configHome, 'devin') : path.join(ctx.appData, 'devin')] },
    quirks: ['Windows 下配置在 %APPDATA%\\devin，其它平台在 ~/.config/devin']
  },
  {
    id: 'devin-desktop',
    aliases: ['windsurf', 'devin-desktop-app'],
    label: 'Devin Desktop (Windsurf)',
    docsUrl: 'https://docs.devin.ai',
    verified: 'yes',
    restartHint: '完全退出并重新打开 Devin Desktop',
    config: {
      kind: 'json',
      paths: (ctx) => [path.join(ctx.home, '.codeium', 'windsurf', 'mcp_config.json')],
      rootKey: ['mcpServers'],
      createParents: true,
      entry: (ctx) => stdioEntry(ctx, { type: 'stdio' })
    },
    skills: { global: (ctx) => [path.join(ctx.home, '.codeium', 'windsurf', 'skills')], project: () => '.windsurf/skills' },
    plugin: null,
    detect: { env: ['WINDSURF_SESSION', 'CODEIUM_AGENT'], paths: (ctx) => [path.join(ctx.home, '.codeium', 'windsurf')] },
    quirks: []
  },
  {
    id: 'opencode',
    aliases: ['open-code'],
    label: 'OpenCode',
    docsUrl: 'https://opencode.ai/docs/mcp-servers/',
    verified: 'yes',
    restartHint: '重启 opencode（新会话会自动加载 MCP）',
    config: {
      kind: 'json',
      paths: (ctx) => [path.join(ctx.configHome, 'opencode', 'opencode.json')],
      rootKey: ['mcp'],
      createParents: true,
      entry: (ctx) => ({ type: 'local', command: [ctx.node, ctx.script, ...ctx.flags], enabled: true, environment: { MODCRAFTING_DATA: ctx.dataDir } })
    },
    skills: { global: (ctx) => [path.join(ctx.configHome, 'opencode', 'skills')], project: () => '.opencode/skills' },
    plugin: null,
    detect: { env: ['OPENCODE_CONFIG', 'OPENCODE_BIN'], paths: (ctx) => [path.join(ctx.configHome, 'opencode')] },
    quirks: ['OpenCode 的 command 是数组，环境变量键名是 environment']
  },
  {
    id: 'pi',
    aliases: [],
    label: 'Pi',
    docsUrl: 'https://pi.dev/docs/latest/configuration',
    verified: 'yes',
    restartHint: '重启 pi（/reload 也可重载配置）',
    config: {
      kind: 'json',
      paths: (ctx) => [path.join(ctx.home, '.pi', 'agent', 'mcp.json')],
      rootKey: ['mcpServers'],
      createParents: true,
      entry: (ctx) => stdioEntry(ctx)
    },
    skills: { global: (ctx) => [path.join(ctx.home, '.pi', 'agent', 'skills')], project: () => '.pi/skills' },
    plugin: null,
    detect: { env: ['PI_CODING_AGENT_DIR', 'PI_SESSION_ID'], paths: (ctx) => [path.join(ctx.home, '.pi')] },
    quirks: ['Pi 的核心不带 MCP，需要先安装适配器：pi install npm:pi-mcp-adapter']
  },
  {
    id: 'zcode',
    aliases: ['z-code', 'zai'],
    label: 'ZCode',
    docsUrl: 'https://zcode.z.ai/docs/mcp-services',
    verified: 'yes',
    restartHint: '重启 ZCode 会话',
    config: {
      kind: 'json',
      paths: (ctx) => [path.join(ctx.home, '.zcode', 'cli', 'config.json')],
      rootKey: ['mcp', 'servers'],
      createParents: true,
      entry: (ctx) => stdioEntry(ctx, { type: 'stdio' })
    },
    skills: { global: (ctx) => [path.join(ctx.home, '.zcode', 'skills'), path.join(ctx.home, '.agents', 'skills')], project: () => '.zcode/skills' },
    plugin: null,
    detect: { env: ['ZCODE_HOME', 'ZCODE_SESSION'], paths: (ctx) => [path.join(ctx.home, '.zcode')] },
    quirks: ['.zcode 里已有 MCP 配置时不会再读 ~/.agents/mcp.json']
  },
  {
    id: 'dsh',
    aliases: ['deepseek-harness', 'deepseek'],
    label: 'DeepSeek Harness (dsh)',
    docsUrl: 'https://github.com/deepseek-ai/deepseek-harness',
    verified: 'partial',
    restartHint: '必须完整重启 dsh web（插件与 MCP 只在启动时加载）',
    config: { kind: 'cli', binary: 'dsh', createParents: false },
    skills: { global: () => [], project: () => null },
    plugin: { dir: null, install: 'dsh plugin --profile web add github:newstarbar/ModCrafting' },
    detect: { env: ['DSH_HOME', 'DSH_PROFILE'], paths: (ctx) => [path.join(ctx.home, '.dsh')] },
    quirks: ['dsh 的扩展全部是插件，安装通过 dsh plugin / dsh mcp add 命令完成，不直写 profile 文件']
  },
  {
    id: 'qoder',
    aliases: [],
    label: 'Qoder',
    docsUrl: 'https://docs.qoder.com/cli/mcp-reference',
    verified: 'yes',
    restartHint: '重启 Qoder 或新建会话',
    config: {
      kind: 'json',
      paths: (ctx) => [path.join(ctx.home, '.qoder', 'settings.json')],
      rootKey: ['mcpServers'],
      createParents: true,
      entry: (ctx) => stdioEntry(ctx)
    },
    skills: { global: (ctx) => [path.join(ctx.home, '.qoder', 'skills')], project: () => '.qoder/skills' },
    plugin: { dir: '.qoder-plugin', install: '下载 Qoder Plugin ZIP 后通过扩展面板导入' },
    detect: { env: ['QODER_PLUGIN_ROOT', 'QODER_PLUGIN_DATA', 'QODER_HOME'], paths: (ctx) => [path.join(ctx.home, '.qoder')] },
    quirks: ['MCP 直写与 Qoder 插件二选一，同时存在会重复注册工具']
  },
  {
    id: 'trae',
    aliases: ['trae-cn'],
    label: 'Trae',
    docsUrl: 'https://docs.trae.ai/ide/add-mcp-servers',
    verified: 'partial',
    restartHint: '重启 Trae；项目级配置需在 设置 → MCP 打开「项目级 MCP」',
    config: {
      kind: 'json',
      paths: (ctx) => (posix(ctx)
        ? [path.join(ctx.home, '.trae', 'mcp.json'), path.join(ctx.home, '.trae-cn', 'mcp.json')]
        : [path.join(ctx.appData, 'Trae', 'User', 'mcp.json'), path.join(ctx.appData, 'Trae CN', 'User', 'mcp.json')]),
      rootKey: ['mcpServers'],
      createParents: false,
      entry: (ctx) => stdioEntry(ctx)
    },
    skills: {
      global: (ctx) => (posix(ctx) ? [path.join(ctx.home, '.trae', 'skills'), path.join(ctx.home, '.trae-cn', 'skills')] : [path.join(ctx.home, '.trae', 'skills')]),
      project: () => '.trae/skills'
    },
    plugin: null,
    detect: { env: ['TRAE_HOME', 'TRAE_SESSION'], paths: (ctx) => (posix(ctx) ? [path.join(ctx.home, '.trae'), path.join(ctx.home, '.trae-cn')] : [path.join(ctx.appData, 'Trae'), path.join(ctx.appData, 'Trae CN')]) },
    quirks: ['国际版与国内版（Trae CN）目录不同，只写已存在的那个']
  },
  {
    id: 'workbuddy',
    aliases: ['work-buddy'],
    label: 'WorkBuddy',
    docsUrl: 'https://www.workbuddy.cn/docs/workbuddy/Overview',
    verified: 'yes',
    restartHint: '重启 WorkBuddy（钩子与技能在启动时加载）',
    config: {
      kind: 'json',
      paths: (ctx) => [path.join(ctx.home, '.workbuddy', 'mcp.json')],
      rootKey: ['mcpServers'],
      createParents: true,
      entry: (ctx) => stdioEntry(ctx, { type: 'stdio' })
    },
    skills: { global: (ctx) => [path.join(ctx.home, '.workbuddy', 'skills'), path.join(ctx.home, '.agents', 'skills')], project: () => '.agents/skills' },
    plugin: { dir: '.codebuddy-plugin', install: 'codebuddy --plugin-dir <插件目录>' },
    detect: { env: ['WORKBUDDY_HOME', 'CODEBUDDY_PLUGIN_ROOT'], paths: (ctx) => [path.join(ctx.home, '.workbuddy')] },
    quirks: ['完整能力（钩子、命令、专家卡）走插件包；直写 MCP 只提供工具与技能']
  },
  {
    id: 'codebuddy',
    aliases: ['code-buddy'],
    label: 'CodeBuddy Code',
    docsUrl: 'http://www.codebuddy.cn/docs/cli/codebuddy-dir',
    verified: 'yes',
    restartHint: '重启 codebuddy 会话',
    config: {
      kind: 'json',
      paths: (ctx) => [path.join(ctx.home, '.codebuddy', '.mcp.json'), path.join(ctx.home, '.codebuddy', 'mcp.json')],
      rootKey: ['mcpServers'],
      createParents: true,
      entry: (ctx) => stdioEntry(ctx, { type: 'stdio' })
    },
    skills: { global: (ctx) => [path.join(ctx.home, '.codebuddy', 'skills')], project: () => '.codebuddy/skills' },
    plugin: { dir: '.codebuddy-plugin', install: 'codebuddy --plugin-dir <插件目录>' },
    detect: { env: ['CODEBUDDY_HOME', 'CODEBUDDY_CONFIG_DIR', 'CODEBUDDY_PLUGIN_ROOT'], paths: (ctx) => [path.join(ctx.home, '.codebuddy')] },
    quirks: ['官方已把全局 MCP 文件改为 ~/.codebuddy/.mcp.json，旧 mcp.json 仅作回退']
  },
  {
    id: 'copilot',
    aliases: ['github-copilot', 'copilot-cli'],
    label: 'GitHub Copilot CLI',
    docsUrl: 'https://docs.github.com/en/copilot/how-tos/use-copilot-agents/use-copilot-cli',
    verified: 'yes',
    restartHint: '重启 copilot 会话；用 /mcp 查看服务器',
    config: {
      kind: 'json',
      paths: (ctx) => [path.join(ctx.home, '.copilot', 'mcp-config.json')],
      rootKey: ['mcpServers'],
      createParents: true,
      entry: (ctx) => stdioEntry(ctx, { type: 'local', tools: ['*'] })
    },
    skills: { global: (ctx) => [path.join(ctx.home, '.copilot', 'skills'), path.join(ctx.home, '.agents', 'skills')], project: () => '.github/skills' },
    plugin: null,
    detect: { env: ['COPILOT_AGENT', 'GITHUB_COPILOT_CLI'], paths: (ctx) => [path.join(ctx.home, '.copilot')] },
    quirks: ['CLI 条目需要 "type": "local" 与 tools: ["*"]', 'VS Code 扩展读 .vscode/mcp.json（servers 键），不在本安装器范围']
  },
  {
    id: 'kimi',
    aliases: ['kimi-cli', 'kimi-code'],
    label: 'Kimi Code CLI',
    docsUrl: 'https://moonshotai.github.io/kimi-cli/zh/customization/mcp.html',
    verified: 'partial',
    restartHint: '重启 kimi，用 /mcp 查看连接',
    config: {
      kind: 'json',
      paths: (ctx) => {
        const root = ctx.env.KIMI_CODE_HOME
        const candidates = []
        if (root) candidates.push(path.join(root, 'mcp.json'))
        candidates.push(path.join(ctx.home, '.kimi-code', 'mcp.json'), path.join(ctx.home, '.kimi', 'mcp.json'))
        return candidates
      },
      rootKey: ['mcpServers'],
      createParents: false,
      entry: (ctx) => stdioEntry(ctx)
    },
    skills: { global: () => [], project: () => null },
    plugin: null,
    detect: { env: ['KIMI_CODE_HOME', 'KIMI_SESSION_ID'], paths: (ctx) => [path.join(ctx.home, '.kimi-code'), path.join(ctx.home, '.kimi')] },
    quirks: ['Kimi 的 skills 目录未验证，只写 MCP 配置']
  },
  {
    id: 'generic',
    aliases: [],
    label: '其它 MCP 客户端',
    docsUrl: 'https://modelcontextprotocol.io',
    verified: 'partial',
    restartHint: '重启你的客户端',
    config: { kind: 'json', paths: () => [], rootKey: ['mcpServers'], createParents: false, entry: (ctx) => stdioEntry(ctx) },
    skills: { global: () => [], project: () => null },
    plugin: null,
    detect: { env: [], paths: () => [] },
    quirks: ['必须用 --config-path 指定 JSON 配置文件']
  }
]

export const HOST_IDS = HOSTS.map((host) => host.id)

const INDEX = new Map()
for (const host of HOSTS) {
  INDEX.set(host.id, host)
  for (const alias of host.aliases) INDEX.set(alias, host)
}

export function resolveHost(value) {
  const host = INDEX.get(String(value ?? '').toLowerCase())
  if (!host) {
    throw Object.assign(new Error(`未知宿主：${value}。可用：${HOST_IDS.join('、')}`), { code: 'UNKNOWN_HOST' })
  }
  return host
}

/** First host whose config file or root directory exists. */
export function hostPaths(host, ctx) {
  return host.detect.paths(ctx)
}

export { firstExisting }
