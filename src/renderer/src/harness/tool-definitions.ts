// ======== ModCrafting Tool Definitions ========
// Built-in tools for the Fabric mod development environment

import { type Tool, type ToolContext, type Previewer } from './tools'
import type { FileDiff } from './events'
import { isPanelBridgeRegistered, runBuildViaPanel, startGameViaPanel } from '../utils/panel-bridge'
import { buildRecipeContent, buildShapelessRecipeContent, parseRecipeIngredients, recipePath, type RecipeKind, type RecipeKey } from './recipe-utils'
import { buildFabricDocsSearchSummary, buildFabricJavadocLookupUrl, buildVanillaWikiQuerySummary } from './fabric-knowledge'
import { buildDataAssetFiles, classifyFabricLog, validateFabricModJsonContent } from './fabric-utils'

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
  description: 'Read the content of a file. Path is relative to project root.',
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative path from project root' }
    },
    required: ['path']
  },
  readOnly: () => true,
  async execute(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
    if (!ctx.projectPath) return 'No project open'
    const filePath = `${ctx.projectPath}/${args.path}`
    try {
      const res = await window.api.readFile(filePath)
      if (res.success) return res.content || '(empty file)'
      return `Error: ${res.error}`
    } catch (err) {
      return `Error reading file: ${err}`
    }
  },
  preview: () => null
}

// ── write_file ──
export const writeFileTool: Tool & Previewer = {
  name: 'write_file',
  description: 'Write content to a file. Path is relative to project root. Creates directories automatically.',
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
    try {
      const res = await window.api.writeFile(filePath, content)
      if (res.success) {
        // Log file change
        logger.file(`Written: ${args.path}`, `${content.length} bytes`)
        return `✅ Written: ${args.path} (${content.length} bytes)`
      }
      return `Error: ${res.error}`
    } catch (err) {
      return `Error writing file: ${err}`
    }
  },
  preview(args: Record<string, unknown>): FileDiff | null {
    const path = String(args.path || '')
    const content = String(args.content || '')
    return {
      path,
      added: content.split('\n').length,
      removed: 0,
      content
    }
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
    const path = recipePath(namespace, name)
    const content = buildShapelessRecipeContent({
      ingredients,
      result: { item: result, count: Number.isFinite(count) ? count : 1 }
    })
    try {
      const res = await window.api.writeFile(`${ctx.projectPath}/${path}`, content)
      if (res.success) {
        logger.file(`Recipe written: ${path}`, `${content.length} bytes`)
        return `✅ Recipe written: ${path} (${content.length} bytes)`
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
      result: { item: result, count: Number(args.count ?? 1) || 1 }
    })
    return {
      path: recipePath(namespace, name),
      added: content.split('\n').length,
      removed: 0,
      content
    }
  }
}

// ── fabric_docs_search ──
export const fabricDocsSearchTool: Tool = {
  name: 'fabric_docs_search',
  description: 'Search built-in Fabric knowledge source index and return authoritative docs/MCP URLs. Read-only.',
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
    const content = buildRecipeContent({
      type,
      ingredients: parseRecipeIngredients(args.ingredients),
      pattern: Array.isArray(args.pattern) ? args.pattern.map(String) : undefined,
      keys: args.keys && typeof args.keys === 'object' ? args.keys as Record<string, RecipeKey> : undefined,
      ingredient: args.ingredient && typeof args.ingredient === 'object' ? args.ingredient as RecipeKey : undefined,
      result: { item: result, count: Number(args.count ?? 1) },
      experience: Number(args.experience ?? 0),
      cookingTime: Number(args.cookingTime ?? 0) || undefined
    })
    const path = recipePath(namespace, name)
    const res = await window.api.writeFile(`${ctx.projectPath}/${path}`, content)
    if (!res.success) return `Error creating recipe: ${res.error}`
    logger.file(`Recipe written: ${path}`, `${content.length} bytes`)
    return `✅ Recipe written: ${path} (${content.length} bytes)`
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
      result: { item: result, count: Number(args.count ?? 1) }
    })
    return { path: recipePath(namespace, name), added: content.split('\n').length, removed: 0, content }
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
        const candidates = [
          `${_ctx.projectPath}/build/reports/problems/problems-report.html`,
          `${_ctx.projectPath}/build/reports/tests/test/index.html`,
          `${_ctx.projectPath}/run/logs/latest.log`
        ]
        for (const p of candidates) {
          if (await window.api.exists(p)) {
            const res = await window.api.readFile(p)
            if (res.success && res.content) return res.content.slice(0, 4000)
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
    return `✅ Fabric content registration helper written: ${rel}`
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
    const files = buildDataAssetFiles({
      namespace,
      name,
      kind,
      displayName: args.displayName ? String(args.displayName) : undefined
    })
    for (const file of files) {
      const res = await window.api.writeFile(`${ctx.projectPath}/${file.path}`, file.content)
      if (!res.success) return `Error writing ${file.path}: ${res.error}`
    }
    return `✅ Fabric assets/data generated:\n${files.map((file) => `- ${file.path}`).join('\n')}`
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
    return `✅ Mixin scaffold generated with conflict-risk warning:\n- ${configPath}\n- ${classPath}`
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

// Register all built-in tools
import { Registry } from './tools'
import { logger } from '../utils/logger'

export function registerModCraftingTools(registry: Registry): void {
  registry.add(readFileTool)
  registry.add(writeFileTool)
  registry.add(fabricDocsSearchTool)
  registry.add(fabricJavadocLookupTool)
  registry.add(vanillaMcWikiQueryTool)
  registry.add(fabricMetaVersionCheckTool)
  registry.add(fabricModJsonValidateTool)
  registry.add(createRecipeTool)
  registry.add(fabricRecipeGenerateTool)
  registry.add(fabricContentRegisterTool)
  registry.add(fabricDataAssetsGenerateTool)
  registry.add(fabricMixinScaffoldTool)
  registry.add(fabricLogDebuggerTool)
  registry.add(listDirectoryTool)
  registry.add(runCommandTool)
  registry.add(readErrorLogTool)
  registry.add(triggerBuildTool)
  registry.add(completeStepTool)
  logger.agent('Tools registered', registry.names())
}
