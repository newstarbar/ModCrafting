// ======== ModCrafting Tool Definitions ========
// Built-in tools for the Fabric mod development environment

import { type Tool, type ToolContext, type Previewer } from './tools'
import type { FileDiff } from './events'
import { isPanelBridgeRegistered, runBuildViaPanel, startGameViaPanel, getLastBuildLogText } from '../utils/panel-bridge'
import { buildRecipeContent, buildShapelessRecipeContent, parseRecipeIngredients, recipePath, type RecipeKind, type RecipeKey } from './recipe-utils'
import { buildFabricDocsSearchSummary, buildFabricJavadocLookupUrl, buildVanillaWikiQuerySummary } from './fabric-knowledge'
import { buildDataAssetFiles, classifyFabricLog, validateFabricModJsonContent } from './fabric-utils'

async function resolveMcVersion(args: Record<string, unknown>): Promise<string> {
  if (typeof args.mcVersion === 'string' && args.mcVersion.trim()) return args.mcVersion.trim()
  try {
    const versions = await window.api.getFabricVersions()
    return versions.minecraft_version || '1.21.4'
  } catch {
    return '1.21.4'
  }
}

async function runWithCommandStream(
  ctx: ToolContext,
  run: () => Promise<{ output: string; exitCode: number | null }>
): Promise<{ output: string; exitCode: number | null }> {
  const unsub = ctx.onProgress
    ? window.api.onCommandOutput((text) => ctx.onProgress!(text))
    : null
  try {
    return await run()
  } finally {
    unsub?.()
  }
}

// ── read_file ──
export const readFileTool: Tool & Previewer = {
  name: 'read_file',
  description: '读取文件内容（含行号）。支持分页：offset 起始行（1-based），limit 最大行数。默认读前 200 行。',
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '项目根目录下的相对路径' },
      offset: { type: 'number', description: '起始行号（1-based），默认 1' },
      limit: { type: 'number', description: '最大行数，默认 200，设 0 表示全量' }
    },
    required: ['path']
  },
  readOnly: () => true,
  async execute(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
    if (!ctx.projectPath) return 'No project open'
    const filePath = `${ctx.projectPath}/${args.path}`
    try {
      const res = await window.api.readFile(filePath)
      if (!res.success) return `Error: ${res.error}`
      const content = res.content || ''
      if (!content) return '(空文件)'

      const lines = content.split('\n')
      const total = lines.length
      const offset = Math.max(1, Number(args.offset) || 1)
      const limit = args.limit !== undefined ? Number(args.limit) : 200
      const effectiveLimit = limit === 0 ? total : Math.min(limit, total)
      const end = Math.min(offset + effectiveLimit - 1, total)
      const page = lines.slice(offset - 1, end)

      const numbered = page.map((line, i) => `${offset + i} | ${line}`).join('\n')
      const header = `文件: ${args.path}（共 ${total} 行，显示 ${offset}-${end} 行）`
      const footer = end < total ? `\n（剩余 ${total - end} 行。用 offset=${end + 1} 继续读取）` : ''
      return `${header}\n${numbered}${footer}`
    } catch (err) {
      return `Error reading file: ${err}`
    }
  },
  preview: () => null
}

// ── write_file ──
function computeLineDiff(oldContent: string, newContent: string): { added: number; removed: number; firstAdded?: string; firstRemoved?: string } {
  const oldLines = oldContent.split('\n')
  const newLines = newContent.split('\n')
  const oldSet = new Set(oldLines)
  const newSet = new Set(newLines)

  const addedLines = newLines.filter((l) => !oldSet.has(l))
  const removedLines = oldLines.filter((l) => !newSet.has(l))

  return {
    added: addedLines.length,
    removed: removedLines.length,
    firstAdded: addedLines.length > 0 ? addedLines[0].slice(0, 80) : undefined,
    firstRemoved: removedLines.length > 0 ? removedLines[0].slice(0, 80) : undefined
  }
}

export const writeFileTool: Tool & Previewer = {
  name: 'write_file',
  description: '写入文件（全量覆盖）。自动创建中间目录。覆盖已有文件时显示旧内容 + diff 统计。新建文件用此工具，修改已有文件优先用 edit_file。',
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative path from project root' },
      content: { type: 'string', description: 'Full file content to write' }
    },
    required: ['path', 'content']
  },
  readOnly: () => false,
  async execute(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
    if (!ctx.projectPath) return 'No project open'
    const filePath = `${ctx.projectPath}/${args.path}`
    const content = String(args.content || '')

    // Read old file content for diff computation
    let oldContent = ''
    let fileExisted = false
    try {
      const old = await window.api.readFile(filePath)
      if (old.success && old.content !== undefined) {
        oldContent = old.content
        fileExisted = true
      }
    } catch {
      // File doesn't exist yet (new file) — that's fine
    }

    try {
      const res = await window.api.writeFile(filePath, content)
      if (res.success) {
        logger.file(`Written: ${args.path}`, `${content.length} bytes`)

        const diff = computeLineDiff(oldContent, content)
        const diffPayload = JSON.stringify({
          path: String(args.path || ''),
          ...diff
        })

        let overwriteNote = ''
        if (fileExisted && oldContent.trim()) {
          const MAX_SHOW = 2000
          const shown = oldContent.length > MAX_SHOW
            ? oldContent.slice(0, MAX_SHOW) + `\n...(截断，原文件共 ${oldContent.length} 字节)`
            : oldContent
          overwriteNote =
            `\n注意: 覆盖已有文件（${oldContent.length} 字节）。被覆盖的旧内容：\n\`\`\`\n${shown}\n\`\`\`\n` +
            `新增 ${diff.added} 行，删除 ${diff.removed} 行。检查是否误删了所需条目。\n`
        }

        return `已写入: ${args.path} (${content.length} bytes)${overwriteNote}\n<!-- FILE_DIFF ${diffPayload} -->`
      }
      return `Error: ${res.error}`
    } catch (err) {
      return `Error writing file: ${err}`
    }
  },
  preview(args: Record<string, unknown>): FileDiff | null {
    const path = String(args.path || '')
    const content = String(args.content || '')
    const lines = content.split('\n')
    return {
      path,
      added: lines.length,
      removed: 0,
      content
    }
  }
}

// ── edit_file ──
export const editFileTool: Tool & Previewer = {
  name: 'edit_file',
  description: '精确替换文件中的文本（只替换第一处匹配）。old_string 必须精确匹配（含缩进/空格），找不到会返回错误。修改已有文件优先用此工具，新建文件用 write_file。',
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '项目根目录下的相对路径' },
      old_string: { type: 'string', description: '要替换的原始文本（精确匹配，只替换第一处）' },
      new_string: { type: 'string', description: '替换后的新文本' }
    },
    required: ['path', 'old_string', 'new_string']
  },
  readOnly: () => false,
  async execute(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
    if (!ctx.projectPath) return 'No project open'
    const filePath = `${ctx.projectPath}/${args.path}`
    const oldStr = String(args.old_string || '')
    const newStr = String(args.new_string || '')

    if (!oldStr) return 'Error: old_string 不能为空'

    // Read current file
    let content: string
    try {
      const res = await window.api.readFile(filePath)
      if (!res.success) return `Error: ${res.error}`
      content = res.content || ''
    } catch (err) {
      return `Error reading file: ${err}`
    }

    // Find first match
    const idx = content.indexOf(oldStr)
    if (idx === -1) {
      // Build diagnostic: show file context around keywords from oldString
      const oldLower = oldStr.toLowerCase()
      const lines = content.split('\n')
      const keywords = oldLower.split(/\s+/).filter((w: string) => w.length > 3)
      const contextLines: string[] = []
      for (let i = 0; i < lines.length; i++) {
        if (keywords.some((kw: string) => lines[i].toLowerCase().includes(kw))) {
          const start = Math.max(0, i - 2)
          const end = Math.min(lines.length, i + 3)
          contextLines.push(`... 第 ${start + 1}-${end} 行:`)
          for (let j = start; j < end; j++) {
            contextLines.push(`${j + 1} | ${lines[j]}`)
          }
          if (contextLines.length >= 25) break
        }
      }
      if (contextLines.length > 0) {
        return `未找到 old_string。文件 ${args.path}（${lines.length} 行）中相关区域:\n${contextLines.join('\n')}\n\n请调整 old_string 精确匹配实际文件内容。注意缩进和空格必须完全一致。`
      }
      return `未找到 old_string。文件 ${args.path} 共 ${lines.length} 行。请用 read_file 查看后重试。`
    }

    // Check for duplicate matches
    const secondIdx = content.indexOf(oldStr, idx + 1)
    if (secondIdx !== -1) {
      // Find which line each match is on
      const before = content.substring(0, idx)
      const lineNum = before.split('\n').length
      const lineNum2 = content.substring(0, secondIdx).split('\n').length
      const ctxStart = Math.max(0, idx - 40)
      const ctxEnd = Math.min(content.length, idx + oldStr.length + 40)
      const ctx = content.substring(ctxStart, ctxEnd)
      return `old_string 匹配了多处（第 ${lineNum} 行和第 ${lineNum2} 行）。请提供更多上下文使匹配唯一。\n第 ${lineNum} 行附近:\n${ctx}`
    }

    // Replace
    const newContent = content.substring(0, idx) + newStr + content.substring(idx + oldStr.length)
    try {
      await window.api.writeFile(filePath, newContent)

      // Compute diff
      const oldLines = oldStr.split('\n')
      const newLines = newStr.split('\n')
      const added = Math.max(0, newLines.length - oldLines.length)
      const removed = Math.max(0, oldLines.length - newLines.length)
      const before = content.substring(0, idx)
      const lineNum = before.split('\n').length
      const preview = newStr.length > 100 ? newStr.slice(0, 100) + '...' : newStr

      let msg = `已${args.path}: 第 ${lineNum} 行已替换`
      if (added > 0 && removed > 0) msg += `（修改 ${removed + added} 行）`
      else if (added > 0) msg += `（+${added} 行）`
      else if (removed > 0) msg += `（-${removed} 行）`
      msg += `\n新内容: ${preview}`

      return msg
    } catch (err) {
      return `写入失败: ${err}`
    }
  },
  preview(args: Record<string, unknown>): FileDiff | null {
    const path = String(args.path || '')
    return { path, added: 0, removed: 0 }
  }
}

// ── create_recipe ──
export const createRecipeTool: Tool & Previewer = {
  name: 'create_recipe',
  description: 'Create a Minecraft shapeless crafting recipe JSON. Prefer this for recipe/合成 tasks instead of hand-writing JSON.',
  schema: {
    type: 'object',
    properties: {
      namespace: { type: 'string', description: 'Recipe namespace / mod id, e.g. my-mod' },
      name: { type: 'string', description: 'Recipe file name without .json, e.g. dirt_to_diamond' },
      ingredients: {
        type: 'array',
        description: 'Ingredients. Use repeated strings or objects with { item, count }.',
        items: {
          anyOf: [
            { type: 'string' },
            {
              type: 'object',
              properties: {
                item: { type: 'string' },
                count: { type: 'number' }
              },
              required: ['item']
            }
          ]
        }
      },
      result: { type: 'string', description: 'Result item id, e.g. minecraft:diamond' },
      count: { type: 'number', description: 'Result count, default 1' }
    },
    required: ['namespace', 'name', 'ingredients', 'result']
  },
  readOnly: () => false,
  async execute(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
    if (!ctx.projectPath) return 'No project open'
    const namespace = String(args.namespace || '')
    const name = String(args.name || '')
    const ingredients = parseRecipeIngredients(args.ingredients)
    const result = String(args.result || '')
    const count = Number(args.count ?? 1)
    if (!namespace || !name || ingredients.length === 0 || !result) {
      return 'Error creating recipe: namespace, name, ingredients and result are required'
    }
    const mcVersion = await resolveMcVersion(args)
    const path = recipePath(namespace, name, mcVersion)
    const content = buildShapelessRecipeContent({
      ingredients,
      result: { item: result, count: Number.isFinite(count) ? count : 1 },
      mcVersion
    })
    try {
      const res = await window.api.writeFile(`${ctx.projectPath}/${path}`, content)
      if (res.success) {
        logger.file(`Recipe written: ${path}`, `${content.length} bytes`)
        return `已生成配方: ${path} (${content.length} bytes)`
      }
      return `Error creating recipe: ${res.error}`
    } catch (err) {
      return `Error creating recipe: ${err}`
    }
  },
  preview(args: Record<string, unknown>): FileDiff | null {
    const namespace = String(args.namespace || '')
    const name = String(args.name || '')
    const ingredients = parseRecipeIngredients(args.ingredients)
    const result = String(args.result || '')
    if (!namespace || !name || ingredients.length === 0 || !result) return null
    const content = buildShapelessRecipeContent({
      ingredients,
      result: { item: result, count: Number(args.count ?? 1) || 1 },
      mcVersion: '1.21.4'
    })
    return {
      path: recipePath(namespace, name, '1.21.4'),
      added: content.split('\n').length,
      removed: 0,
      content
    }
  }
}

// ── fabric_docs_search ──
export const fabricDocsSearchTool: Tool = {
  name: 'fabric_docs_search',
  description: '搜索 Fabric 知识库：优先查本地 Yarn 参考表（类名/方法签名/Mixin 模式），再联网抓取文档摘要。只读。写代码前用此工具确认类名和字段名是否正确。',
  schema: {
    type: 'object',
    properties: {
      keyword: { type: 'string', description: 'Search keyword, e.g. 方块实体 or BlockEntity' },
      mcVersion: { type: 'string', description: 'Minecraft version, default current project version' },
      lang: { type: 'string', enum: ['zh_cn', 'en_us'], description: 'Language preference' },
      limit: { type: 'number', description: 'Max source count, default 5' }
    },
    required: ['keyword']
  },
  readOnly: () => true,
  async execute(_ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
    return buildFabricDocsSearchSummary({
      keyword: String(args.keyword || ''),
      mcVersion: args.mcVersion ? String(args.mcVersion) : undefined,
      lang: args.lang === 'en_us' ? 'en_us' : 'zh_cn',
      limit: Number(args.limit ?? 5)
    })
  }
}

// ── fabric_javadoc_lookup ──
export const fabricJavadocLookupTool: Tool = {
  name: 'fabric_javadoc_lookup',
  description: 'Build a Fabric API JavaDoc search URL for a class, method, event, or registry API. Read-only.',
  schema: {
    type: 'object',
    properties: {
      keyword: { type: 'string', description: 'Class, method, event, or registry keyword' },
      fabricApiVersion: { type: 'string', description: 'Fabric API version, e.g. 0.116.0+1.21.4' }
    },
    required: ['keyword']
  },
  readOnly: () => true,
  async execute(_ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
    const version = String(args.fabricApiVersion || (await window.api.getFabricVersions()).fabric_version)
    const keyword = String(args.keyword || '')
    return `Fabric API JavaDoc 查询（只读）
关键词：${keyword}
URL：${buildFabricJavadocLookupUrl(version, keyword)}
提示：写代码前用该页面确认类名、方法签名、事件参数和模块依赖。`
  }
}

// ── vanilla_mc_wiki_query ──
export const vanillaMcWikiQueryTool: Tool = {
  name: 'vanilla_mc_wiki_query',
  description: 'Return official Minecraft Wiki query entry points for vanilla blocks, items, entities, loot, and mechanics. Read-only.',
  schema: {
    type: 'object',
    properties: {
      keyword: { type: 'string', description: 'Vanilla concept keyword, e.g. 钻石矿石 or Zombie' },
      lang: { type: 'string', enum: ['zh_cn', 'en_us'], description: 'Language preference' }
    },
    required: ['keyword']
  },
  readOnly: () => true,
  async execute(_ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
    return buildVanillaWikiQuerySummary(String(args.keyword || ''), args.lang === 'en_us' ? 'en_us' : 'zh_cn')
  }
}

// ── fabric_meta_version_check ──
export const fabricMetaVersionCheckTool: Tool = {
  name: 'fabric_meta_version_check',
  description: 'Query Fabric Meta for compatible Loader, Fabric API, and Yarn versions for a Minecraft version. Read-only.',
  schema: {
    type: 'object',
    properties: {
      mcVersion: { type: 'string', description: 'Minecraft version, e.g. 1.21.4' }
    },
    required: ['mcVersion']
  },
  readOnly: () => true,
  async execute(_ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
    const mcVersion = String(args.mcVersion || '')
    if (!mcVersion) return 'Error: mcVersion is required'
    try {
      const [loaders, apis, yarns] = await Promise.all([
        fetch(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mcVersion)}`).then((r) => r.json()).catch(() => []),
        fetch(`https://meta.fabricmc.net/v2/versions/fabric-api/${encodeURIComponent(mcVersion)}`).then((r) => r.json()).catch(() => []),
        fetch(`https://meta.fabricmc.net/v2/versions/yarn/${encodeURIComponent(mcVersion)}`).then((r) => r.json()).catch(() => [])
      ])
      const loader = Array.isArray(loaders) ? loaders[0]?.loader?.version : undefined
      const fabricApi = Array.isArray(apis) ? apis[0]?.version : undefined
      const yarn = Array.isArray(yarns) ? yarns[0]?.version : undefined
      return JSON.stringify({
        minecraft_version: mcVersion,
        loader_version: loader || 'unknown',
        fabric_version: fabricApi || 'unknown',
        yarn_mappings: yarn || 'unknown',
        java: '1.20.5+ 建议 Java 21；当前 ModCrafting 默认 Java 21',
        source: 'https://meta.fabricmc.net/'
      }, null, 2)
    } catch (err) {
      return `Error querying Fabric Meta: ${err}`
    }
  }
}

// ── fabric_mod_json_validate ──
export const fabricModJsonValidateTool: Tool = {
  name: 'fabric_mod_json_validate',
  description: 'Validate fabric.mod.json entrypoints, depends, mixins, icon path, and Java constraints. Read-only.',
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to fabric.mod.json, default src/main/resources/fabric.mod.json' }
    }
  },
  readOnly: () => true,
  async execute(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
    if (!ctx.projectPath) return 'No project open'
    const relPath = String(args.path || 'src/main/resources/fabric.mod.json')
    const res = await window.api.readFile(`${ctx.projectPath}/${relPath}`)
    if (!res.success || !res.content) return `Error reading ${relPath}: ${res.error || 'empty file'}`
    const result = validateFabricModJsonContent(res.content)
    return JSON.stringify(result, null, 2)
  }
}

// ── fabric_recipe_generate ──
export const fabricRecipeGenerateTool: Tool & Previewer = {
  name: 'fabric_recipe_generate',
  description: 'Generate Minecraft recipe JSON for shaped, shapeless, smelting, blasting, or stonecutting recipes.',
  schema: {
    type: 'object',
    properties: {
      namespace: { type: 'string', description: 'Recipe namespace / mod id' },
      name: { type: 'string', description: 'Recipe file name without .json' },
      type: { type: 'string', enum: ['shapeless', 'shaped', 'smelting', 'blasting', 'stonecutting'] },
      ingredients: { type: 'array', description: 'Shapeless ingredients' },
      pattern: { type: 'array', items: { type: 'string' }, description: 'Shaped recipe pattern' },
      keys: { type: 'object', description: 'Shaped recipe key map' },
      ingredient: { type: 'object', description: 'Single ingredient for furnace/stonecutting recipes' },
      result: { type: 'string', description: 'Result item id' },
      count: { type: 'number', description: 'Result count' },
      experience: { type: 'number' },
      cookingTime: { type: 'number' }
    },
    required: ['namespace', 'name', 'type', 'result']
  },
  readOnly: () => false,
  async execute(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
    if (!ctx.projectPath) return 'No project open'
    const namespace = String(args.namespace || '')
    const name = String(args.name || '')
    const result = String(args.result || '')
    const type = String(args.type || 'shapeless') as RecipeKind
    if (!namespace || !name || !result) return 'Error creating recipe: namespace, name and result are required'
    const mcVersion = await resolveMcVersion(args)
    const content = buildRecipeContent({
      type,
      ingredients: parseRecipeIngredients(args.ingredients),
      pattern: Array.isArray(args.pattern) ? args.pattern.map(String) : undefined,
      keys: args.keys && typeof args.keys === 'object' ? args.keys as Record<string, RecipeKey> : undefined,
      ingredient: args.ingredient && typeof args.ingredient === 'object' ? args.ingredient as RecipeKey : undefined,
      result: { item: result, count: Number(args.count ?? 1) },
      experience: Number(args.experience ?? 0),
      cookingTime: Number(args.cookingTime ?? 0) || undefined,
      mcVersion
    })
    const path = recipePath(namespace, name, mcVersion)
    const res = await window.api.writeFile(`${ctx.projectPath}/${path}`, content)
    if (!res.success) return `Error creating recipe: ${res.error}`
    logger.file(`Recipe written: ${path}`, `${content.length} bytes`)
    return `已生成配方 written: ${path} (${content.length} bytes)`
  },
  preview(args: Record<string, unknown>): FileDiff | null {
    const namespace = String(args.namespace || '')
    const name = String(args.name || '')
    const result = String(args.result || '')
    if (!namespace || !name || !result) return null
    const content = buildRecipeContent({
      type: String(args.type || 'shapeless') as RecipeKind,
      ingredients: parseRecipeIngredients(args.ingredients),
      pattern: Array.isArray(args.pattern) ? args.pattern.map(String) : undefined,
      keys: args.keys && typeof args.keys === 'object' ? args.keys as Record<string, RecipeKey> : undefined,
      ingredient: args.ingredient && typeof args.ingredient === 'object' ? args.ingredient as RecipeKey : undefined,
      result: { item: result, count: Number(args.count ?? 1) },
      mcVersion: '1.21.4'
    })
    return { path: recipePath(namespace, name, '1.21.4'), added: content.split('\n').length, removed: 0, content }
  }
}

// ── list_directory ──
export const listDirectoryTool: Tool = {
  name: 'list_directory',
  description: 'List files and directories. Path is relative to project root. Empty string lists root.',
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative path (default: root)' }
    }
  },
  readOnly: () => true,
  async execute(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
    if (!ctx.projectPath) return 'No project open'
    const dirPath = args.path ? `${ctx.projectPath}/${args.path}` : ctx.projectPath
    try {
      const entries = await window.api.listDirectory(dirPath)
      const lines = entries.map((e: { name: string; isDirectory: boolean }) =>
        e.isDirectory ? `${e.name}/` : e.name
      )
      return lines.join('\n') || '(empty directory)'
    } catch (err) {
      return `Error listing directory: ${err}`
    }
  }
}

// ── run_command ──
export const runCommandTool: Tool = {
  name: 'run_command',
  description: 'Run a shell command in the project directory. Use for building, testing, or git operations.',
  schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute' }
    },
    required: ['command']
  },
  readOnly: () => false,
  async execute(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
    if (!ctx.projectPath) return 'No project open'
    try {
      const command = String(args.command || '')
      const prep = await window.api.prepareBuild(ctx.projectPath)
      const fullCmd = prep.ok ? prep.cmdPrefix + command : command
      const res = await runWithCommandStream(ctx, () =>
        window.api.runCommandStream(fullCmd, ctx.projectPath!)
      )
      const output = res.output || '(no output)'
      const exitInfo = res.exitCode !== null ? `\n[exit code: ${res.exitCode}]` : ''
      if (!prep.ok && prep.error) return `环境准备失败: ${prep.error}\n${output}${exitInfo}`
      return output + exitInfo
    } catch (err) {
      return `Error running command: ${err}`
    }
  }
}

// ── read_error_log ──

function stripHtmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
}

function buildLogTail(text: string, maxChars = 8000): string {
  const normalized = text.trim()
  if (normalized.length <= maxChars) return normalized
  return normalized.slice(-maxChars)
}
export const readErrorLogTool: Tool = {
  name: 'read_error_log',
  description: 'Read build error logs or crash reports to help debug issues.',
  schema: {
    type: 'object',
    properties: {
      logType: {
        type: 'string',
        enum: ['last-build', 'last-crash', 'latest-log', 'mixin-error', 'resource-error', 'datagen-error'],
        description: 'Type of log to read'
      }
    },
    required: ['logType']
  },
  readOnly: () => true,
  async execute(_ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
    const logType = String(args.logType || 'last-build')
    // Try to read from known log locations
    try {
      if (logType === 'last-crash' && _ctx.projectPath) {
        const crashReports = `${_ctx.projectPath}/run/crash-reports`
        const entries = await window.api.listDirectory(crashReports)
        if (entries.length > 0) {
          const latest = entries.sort((a: { name: string }, b: { name: string }) => b.name.localeCompare(a.name))[0]
          const res = await window.api.readFile(latest.path)
          if (res.success) return res.content.slice(0, 4000)
        }
      }
      if (logType === 'last-build' && _ctx.projectPath) {
        if (isPanelBridgeRegistered()) {
          const panelLog = getLastBuildLogText().trim()
          if (panelLog) return buildLogTail(panelLog)
        }
        const candidates = [
          `${_ctx.projectPath}/run/logs/latest.log`,
          `${_ctx.projectPath}/build/reports/problems/problems-report.html`,
          `${_ctx.projectPath}/build/reports/tests/test/index.html`
        ]
        for (const p of candidates) {
          if (await window.api.exists(p)) {
            const res = await window.api.readFile(p)
            if (!res.success || !res.content) continue
            const content = p.endsWith('.html') ? stripHtmlToText(res.content) : res.content
            if (content.trim()) return buildLogTail(content)
          }
        }
      }
      if (_ctx.projectPath && ['latest-log', 'mixin-error', 'resource-error', 'datagen-error'].includes(logType)) {
        const candidates = [
          `${_ctx.projectPath}/run/logs/latest.log`,
          `${_ctx.projectPath}/build/reports/problems/problems-report.html`
        ]
        for (const p of candidates) {
          if (await window.api.exists(p)) {
            const res = await window.api.readFile(p)
            if (res.success && res.content) {
              const classification = classifyFabricLog(res.content)
              return `${JSON.stringify(classification, null, 2)}\n\n${res.content.slice(0, 4000)}`
            }
          }
        }
      }
      return `[${logType}]: No log file found. Run a build first, or check the terminal panel.`
    } catch {
      return `[${logType}]: No log file found.`
    }
  }
}

// ── trigger_build ──
export const triggerBuildTool: Tool = {
  name: 'trigger_build',
  description: 'Trigger a Gradle task in the project directory.',
  schema: {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        enum: ['build', 'runClient', 'runDatagen', 'runServer', 'test'],
        description: 'Gradle task to run'
      }
    },
    required: ['task']
  },
  readOnly: () => false,
  async execute(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
    if (!ctx.projectPath) return 'No project open'
    const task = String(args.task || 'build')

    if (task === 'runClient') {
      try {
        if (isPanelBridgeRegistered()) {
          const res = await startGameViaPanel()
          if (!res.ok) {
            return `Error starting game: ${res.error || 'unknown error'}`
          }
          return `已在右侧游戏面板启动并进入游戏（实例 ${res.instanceId}）。[MC_PHASE:playing]`
        }
        const res = await window.api.mcStartOrCreate(ctx.projectPath)
        if (!res.success) {
          return `Error starting game: ${res.error || 'unknown error'}`
        }
        return `已启动游戏实例（${res.id || 'mc'}）。请在右侧「游戏」面板查看进度。[MC_PHASE:playing]`
      } catch (err) {
        return `Error starting game: ${err}`
      }
    }

    try {
      if (task === 'build' && isPanelBridgeRegistered()) {
        const res = await runBuildViaPanel()
        const exitInfo = res.exitCode !== 0 ? `\n[退出码: ${res.exitCode}]` : '\n[退出码: 0]'
        if (res.failed) {
          const tail = buildLogTail(getLastBuildLogText())
          if (tail) {
            return `构建失败。\n\n--- 构建输出（末尾）---\n${tail}${exitInfo}`
          }
          return `构建失败，详情见右侧高级面板。${exitInfo}`
        }
        return `构建已在右侧高级面板完成。${exitInfo}`
      }

      const res = await runWithCommandStream(ctx, () =>
        window.api.runGradleTask(ctx.projectPath!, task)
      )
      const output = res.output || `Task "${task}" completed (exit: ${res.exitCode})`
      const exitInfo = res.exitCode !== 0 ? `\n[退出码: ${res.exitCode}]` : ''
      const fallbackNote = res.usedOnlineFallback ? '\n[已联网补全依赖缓存]' : ''
      return output + exitInfo + fallbackNote
    } catch (err) {
      return `Error running build: ${err}`
    }
  }
}

function javaPackagePath(packagePath: string): string {
  return packagePath.replace(/\./g, '/').replace(/[^a-zA-Z0-9_/$]/g, '')
}

function mainRegistrationClass(packageName: string, modId: string): string {
  return `package ${packageName};

import net.minecraft.item.Item;
import net.minecraft.registry.Registries;
import net.minecraft.registry.Registry;
import net.minecraft.registry.RegistryKey;
import net.minecraft.registry.RegistryKeys;
import net.minecraft.util.Identifier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class ModItems {
    private static final Logger LOGGER = LoggerFactory.getLogger("${modId}");
    public static final Item GENERATED_ITEM = register("generated_item", new Item.Settings());

    private static Item register(String name, Item.Settings settings) {
        Identifier id = Identifier.of("${modId}", name);
        RegistryKey<Item> key = RegistryKey.of(RegistryKeys.ITEM, id);
        return Registry.register(Registries.ITEM, key, new Item(settings.registryKey(key)));
    }

    public static void registerModItems() {
        LOGGER.info("Registering items for ${modId}");
    }
}
`
}

// ── fabric_content_register ──
export const fabricContentRegisterTool: Tool = {
  name: 'fabric_content_register',
  description: 'Generate a Fabric content registration helper class skeleton for items/blocks/block entities.',
  schema: {
    type: 'object',
    properties: {
      packagePath: { type: 'string', description: 'Java package, e.g. com.example.mymod' },
      modId: { type: 'string', description: 'Mod id namespace' },
      kind: { type: 'string', enum: ['item', 'block', 'block_entity'], description: 'Content kind' }
    },
    required: ['packagePath', 'modId', 'kind']
  },
  readOnly: () => false,
  async execute(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
    if (!ctx.projectPath) return 'No project open'
    const packagePath = String(args.packagePath || '')
    const modId = String(args.modId || '')
    if (!packagePath || !modId) return 'Error: packagePath and modId are required'
    const rel = `src/main/java/${javaPackagePath(packagePath)}/ModItems.java`
    const content = mainRegistrationClass(packagePath, modId)
    const res = await window.api.writeFile(`${ctx.projectPath}/${rel}`, content)
    if (!res.success) return `Error writing ${rel}: ${res.error}`
    logger.file(`Fabric content helper written: ${rel}`, `${content.length} bytes`)
    return `已生成: 内容注册辅助类 → ${rel}`
  }
}

// ── fabric_data_assets_generate ──
export const fabricDataAssetsGenerateTool: Tool = {
  name: 'fabric_data_assets_generate',
  description: 'Generate Fabric asset/data JSON files for item or block content: lang, models, blockstates, loot tables.',
  schema: {
    type: 'object',
    properties: {
      namespace: { type: 'string', description: 'Mod id namespace' },
      name: { type: 'string', description: 'Content id path' },
      kind: { type: 'string', enum: ['item', 'block'], description: 'Asset kind' },
      displayName: { type: 'string', description: 'Chinese display name' }
    },
    required: ['namespace', 'name', 'kind']
  },
  readOnly: () => false,
  async execute(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
    if (!ctx.projectPath) return 'No project open'
    const namespace = String(args.namespace || '')
    const name = String(args.name || '')
    const kind = args.kind === 'block' ? 'block' : 'item'
    if (!namespace || !name) return 'Error: namespace and name are required'
    const mcVersion = await resolveMcVersion(args)
    const files = buildDataAssetFiles({
      namespace,
      name,
      kind,
      displayName: args.displayName ? String(args.displayName) : undefined,
      mcVersion
    })
    for (const file of files) {
      const res = await window.api.writeFile(`${ctx.projectPath}/${file.path}`, file.content)
      if (!res.success) return `Error writing ${file.path}: ${res.error}`
    }
    return `已生成: 资源文件${files.map((file) => `\n- ${file.path}`).join('')}`
  }
}

// ── fabric_mixin_scaffold ──
export const fabricMixinScaffoldTool: Tool = {
  name: 'fabric_mixin_scaffold',
  description: 'Generate Fabric mixin config and a minimal mixin class. Use only when Fabric API cannot solve the task.',
  schema: {
    type: 'object',
    properties: {
      modId: { type: 'string', description: 'Mod id namespace' },
      mixinPackage: { type: 'string', description: 'Mixin Java package' },
      mixinClass: { type: 'string', description: 'Fully qualified mixin class name' },
      targetClass: { type: 'string', description: 'Target Yarn class name, e.g. net.minecraft.entity.LivingEntity' }
    },
    required: ['modId', 'mixinPackage', 'mixinClass', 'targetClass']
  },
  readOnly: () => false,
  async execute(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
    if (!ctx.projectPath) return 'No project open'
    const modId = String(args.modId || '')
    const mixinPackage = String(args.mixinPackage || '')
    const mixinClass = String(args.mixinClass || '')
    const targetClass = String(args.targetClass || '')
    if (!modId || !mixinPackage || !mixinClass || !targetClass) {
      return 'Error: modId, mixinPackage, mixinClass and targetClass are required'
    }
    const simpleName = mixinClass.split('.').pop() || 'GeneratedMixin'
    const configPath = `src/main/resources/${modId}.mixins.json`
    const classPath = `src/main/java/${javaPackagePath(mixinClass)}.java`
    const config = JSON.stringify({
      required: true,
      package: mixinPackage,
      compatibilityLevel: 'JAVA_21',
      mixins: [simpleName],
      injectors: { defaultRequire: 1 }
    }, null, 2) + '\n'
    const content = `package ${mixinPackage};

import org.spongepowered.asm.mixin.Mixin;

@Mixin(${targetClass}.class)
public class ${simpleName} {
    // Prefer Fabric API events when possible. Add targeted injections only after verifying Yarn signatures.
}
`
    for (const file of [
      { path: configPath, content: config },
      { path: classPath, content }
    ]) {
      const res = await window.api.writeFile(`${ctx.projectPath}/${file.path}`, file.content)
      if (!res.success) return `Error writing ${file.path}: ${res.error}`
    }
    return `已生成: Mixin 脚手架\n- ${configPath}\n- ${classPath}\n注意: 此为模板代码，需手动填写注入逻辑。`
  }
}

// ── fabric_log_debugger ──
export const fabricLogDebuggerTool: Tool = {
  name: 'fabric_log_debugger',
  description: 'Classify Fabric/Loom/Mixin/resource/client-server log errors and return focused repair advice. Read-only.',
  schema: {
    type: 'object',
    properties: {
      log: { type: 'string', description: 'Log text to classify. If empty, reads latest build log.' }
    }
  },
  readOnly: () => true,
  async execute(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
    let log = String(args.log || '')
    if (!log && ctx.projectPath) {
      const candidates = [
        `${ctx.projectPath}/run/logs/latest.log`,
        `${ctx.projectPath}/build/reports/problems/problems-report.html`
      ]
      for (const p of candidates) {
        if (await window.api.exists(p)) {
          const res = await window.api.readFile(p)
          if (res.success && res.content) {
            log = res.content
            break
          }
        }
      }
    }
    const result = classifyFabricLog(log)
    return JSON.stringify(result, null, 2)
  }
}

// ── complete_step ──
export const completeStepTool: Tool = {
  name: 'complete_step',
  description: 'Mark a plan step as completed. Call this when you finish implementing a step from the plan.',
  schema: {
    type: 'object',
    properties: {
      stepId: {
        type: 'string',
        description: 'The step ID (number or description prefix) to mark complete'
      }
    },
    required: ['stepId']
  },
  readOnly: () => true,
  async execute(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
    const stepId = String(args.stepId || '')
    if (ctx.planTracker) {
      const result = ctx.planTracker.advance(stepId)
      if (result.ok) {
        ctx.onPlanStateChange?.(ctx.planTracker.snapshot())
        return result.message
      }
      return `Error: ${result.message}`
    }
    return `[STEP_DONE:${stepId}]`
  }
}

// ── fabric_mixin_register ──
async function findMixinConfig(projectPath: string): Promise<{ name: string; content: string } | null> {
  try {
    const resDir = `${projectPath}/src/main/resources`
    const entries = await window.api.listDirectory(resDir)
    for (const e of entries) {
      if (e.name.endsWith('.mixins.json')) {
        const result = await window.api.readFile(e.path)
        if (result.success && result.content) {
          return { name: e.name, content: result.content }
        }
      }
    }
  } catch { /* ignore */ }
  return null
}

export const fabricMixinRegisterTool: Tool = {
  name: 'fabric_mixin_register',
  description:
    '向已有的 Mixin 配置文件中安全地追加 Mixin 类条目。自动查找 mixins.json、读取、追加指定 Mixin 条目、写回。避免手动编辑 JSON 时误删已有条目。',
  schema: {
    type: 'object',
    properties: {
      mixinClass: {
        type: 'string',
        description: 'Mixin 类名（简单名，非全限定名），如 "PlayerEntityMixin"'
      },
      target: {
        type: 'string',
        enum: ['common', 'client', 'server'],
        description: '注册到哪个数组：common→mixins, client→client, server→server。默认 common'
      }
    },
    required: ['mixinClass']
  },
  readOnly: () => false,
  async execute(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
    if (!ctx.projectPath) return 'No project open'
    const mixinClass = String(args.mixinClass || '').trim()
    const target = (String(args.target || 'common')) as 'common' | 'client' | 'server'
    if (!mixinClass) return 'Error: mixinClass is required'

    const existing = await findMixinConfig(ctx.projectPath)
    if (!existing) {
      return 'Error: 未找到 *.mixins.json 配置文件。请先创建 Mixin 配置，或使用 fabric_mixin_scaffold 生成。'
    }

    let config: Record<string, unknown>
    try {
      config = JSON.parse(existing.content)
    } catch {
      return `Error: 无法解析 ${existing.name}，请检查 JSON 格式`
    }

    const key = target === 'client' ? 'client' : target === 'server' ? 'server' : 'mixins'
    const arr: string[] = Array.isArray(config[key]) ? (config[key] as string[]) : []
    if (arr.includes(mixinClass)) {
      return `${mixinClass} 已存在于 ${existing.name} 的 ${key} 数组中，无需重复注册。`
    }

    arr.push(mixinClass)
    config[key] = arr

    const newContent = JSON.stringify(config, null, 2) + '\n'
    const configPath = `src/main/resources/${existing.name}`
    const res = await window.api.writeFile(`${ctx.projectPath}/${configPath}`, newContent)
    if (!res.success) return `Error: ${res.error}`

    const existingList = arr.length > 1
      ? `，现有条目：${arr.join(', ')}`
      : ''
    return (
      `已在 ${existing.name} 的 ${key} 数组中注册 ${mixinClass}${existingList}`
    )
  }
}

// ── ask_clarification ──
export const askClarificationTool: Tool = {
  name: 'ask_clarification',
  description:
    '向用户提问以澄清需求。当你遇到以下情况时必须使用，禁止猜测：\n' +
    '1. 不确定文件路径（如不知道 mixin 配置文件是 example.mixins.json 还是 my-mod.mixins.json）\n' +
    '2. 不确定包名、类名、mod id、版本号等标识符\n' +
    '3. 需要从多个可行方案中选择（如用 @Inject 还是 @ModifyVariable）\n' +
    '4. 用户需求有歧义，允许多种实现方式\n' +
    '调用后自动暂停执行，等待用户回答后继续。不会导致步骤失败。',
  schema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: '要问用户的问题，用中文，说明为什么需要确认' },
      options: {
        type: 'array',
        items: { type: 'string' },
        description: '可选的答案选项，供用户快速选择（最多 4 个）'
      }
    },
    required: ['question']
  },
  readOnly: () => true,
  async execute(_ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
    const question = String(args.question || '')
    const options = Array.isArray(args.options) ? (args.options as string[]) : []
    const optionsText = options.length > 0
      ? '\n\n选项：\n' + options.map((o, i) => `${i + 1}. ${o}`).join('\n')
      : ''
    return `[CLARIFICATION_NEEDED]\n问题：${question}${optionsText}`
  }
}

// Register all built-in tools
import { Registry } from './tools'
import { logger } from '../utils/logger'

export function registerModCraftingTools(registry: Registry, options?: { disabledTools?: string[] }): void {
  const disabled = new Set(options?.disabledTools || [])
  const tools = [
    readFileTool,
    writeFileTool,
    editFileTool,
    fabricDocsSearchTool,
    fabricJavadocLookupTool,
    vanillaMcWikiQueryTool,
    fabricMetaVersionCheckTool,
    fabricModJsonValidateTool,
    createRecipeTool,
    fabricRecipeGenerateTool,
    fabricContentRegisterTool,
    fabricDataAssetsGenerateTool,
    fabricMixinScaffoldTool,
    fabricLogDebuggerTool,
    fabricMixinRegisterTool,
    listDirectoryTool,
    runCommandTool,
    readErrorLogTool,
    triggerBuildTool,
    askClarificationTool,
    completeStepTool
  ]
  for (const tool of tools) {
    if (!disabled.has(tool.name)) registry.add(tool)
  }
  logger.agent('Tools registered', registry.names())
}
