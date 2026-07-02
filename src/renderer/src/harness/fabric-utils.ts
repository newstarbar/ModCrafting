export interface FabricValidationResult {
  ok: boolean
  issues: string[]
  warnings: string[]
}

export interface FabricLogClassification {
  kind: 'mixin-error' | 'side-error' | 'resource-error' | 'datagen-error' | 'registry-error' | 'gradle-error' | 'unknown'
  title: string
  advice: string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isValidModId(value: unknown): boolean {
  return typeof value === 'string' && /^[a-z][a-z0-9_-]{1,63}$/.test(value)
}

export function validateFabricModJsonContent(content: string): FabricValidationResult {
  const issues: string[] = []
  const warnings: string[] = []
  let parsed: unknown

  try {
    parsed = JSON.parse(content)
  } catch (err) {
    return {
      ok: false,
      issues: [`fabric.mod.json 不是合法 JSON：${err instanceof Error ? err.message : String(err)}`],
      warnings
    }
  }

  if (!isObject(parsed)) {
    return { ok: false, issues: ['fabric.mod.json 根节点必须是对象'], warnings }
  }

  if (parsed.schemaVersion !== 1) issues.push('schemaVersion 必须为 1')
  if (!isValidModId(parsed.id)) issues.push('id 必须为小写字母开头，并且只能包含小写字母、数字、下划线或连字符')
  if (typeof parsed.version !== 'string' || !parsed.version) issues.push('version 必须是非空字符串')
  if (typeof parsed.name !== 'string' || !parsed.name) issues.push('name 必须是非空字符串')

  if (parsed.entrypoints !== undefined) {
    if (!isObject(parsed.entrypoints)) {
      issues.push('entrypoints 必须是对象')
    } else {
      const main = parsed.entrypoints.main
      if (!Array.isArray(main) || main.length === 0) issues.push('entrypoints.main 至少需要一个 ModInitializer')
      const client = parsed.entrypoints.client
      if (client !== undefined && (!Array.isArray(client) || client.length === 0)) {
        warnings.push('entrypoints.client 存在时应至少包含一个 ClientModInitializer')
      }
    }
  } else {
    issues.push('entrypoints 缺失')
  }

  if (!isObject(parsed.depends)) {
    issues.push('depends 缺失或不是对象')
  } else {
    if (typeof parsed.depends.minecraft !== 'string') issues.push('depends.minecraft 缺失')
    if (typeof parsed.depends.fabricloader !== 'string') warnings.push('depends.fabricloader 缺失，建议声明 Fabric Loader 约束')
    if (typeof parsed.depends.java !== 'string') warnings.push('depends.java 缺失，1.20.5+ 建议声明 >=21')
  }

  if (typeof parsed.icon === 'string' && !parsed.icon.startsWith(`assets/${String(parsed.id || '')}/`)) {
    warnings.push('icon 建议使用 assets/<modid>/icon.png 路径，确保资源能被打包')
  }

  if (parsed.mixins !== undefined && !Array.isArray(parsed.mixins)) {
    issues.push('mixins 必须是字符串数组或对象数组')
  }

  return { ok: issues.length === 0, issues, warnings }
}

export function classifyFabricLog(log: string): FabricLogClassification {
  const lower = log.toLowerCase()
  if (/invalidinjectionexception|mixin apply failed|mixin/.test(lower)) {
    return {
      kind: 'mixin-error',
      title: 'Mixin 注入失败',
      advice: '检查目标类/方法 Yarn 名称、方法签名、注入点和 remap 设置；能用 Fabric API 事件替代时优先移除 Mixin。'
    }
  }
  if (/attempted to load class .*client|invalid dist dedicated_server|dedicated_server.*client/.test(lower)) {
    return {
      kind: 'side-error',
      title: '客户端代码被服务端加载',
      advice: '把渲染、模型、Screen、HUD、Client 类移动到 src/client/java 或 ClientModInitializer，并避免 main 入口引用客户端类。'
    }
  }
  if (/jsonparseexception|malformedjsonexception|unable to load model|missing model|filenotfoundexception.*assets/.test(lower)) {
    return {
      kind: 'resource-error',
      title: '资源或 JSON 格式错误',
      advice: '检查 assets/data 路径、命名空间、模型 parent、textures、blockstates、loot_tables 与 JSON 语法。'
    }
  }
  if (/datagen|data generator|fabric-api.datagen/.test(lower)) {
    return {
      kind: 'datagen-error',
      title: 'DataGen 失败',
      advice: '检查 DataGeneratorEntrypoint、runDatagen VM 参数、输出目录和 provider 注册。'
    }
  }
  if (/registry|duplicate key|already registered|registrykey/.test(lower)) {
    return {
      kind: 'registry-error',
      title: 'Registry 注册错误',
      advice: '检查 Identifier、RegistryKey、重复注册、注册时机和 Item.Settings/Block.Settings 的 registryKey。'
    }
  }
  if (/build failed|could not resolve|gradle|loom/.test(lower)) {
    return {
      kind: 'gradle-error',
      title: 'Gradle/Loom 构建错误',
      advice: '检查 Loom、Fabric API、Loader、Yarn 和 Java 版本是否匹配；必要时重新预取依赖缓存。'
    }
  }
  return {
    kind: 'unknown',
    title: '未分类 Fabric 日志',
    advice: '先定位最上方的 caused by 和第一个项目源码栈帧，再结合构建或运行阶段判断。'
  }
}

export interface GeneratedFile {
  path: string
  content: string
}

function toTitle(value: string): string {
  return value.split(/[_-]/).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ')
}

export function buildDataAssetFiles(input: {
  namespace: string
  name: string
  kind: 'item' | 'block'
  displayName?: string
}): GeneratedFile[] {
  const displayName = input.displayName || toTitle(input.name)
  const langKey = `${input.kind}.${input.namespace}.${input.name}`
  const files: GeneratedFile[] = [
    {
      path: `src/main/resources/assets/${input.namespace}/lang/zh_cn.json`,
      content: JSON.stringify({ [langKey]: displayName }, null, 2) + '\n'
    }
  ]

  if (input.kind === 'item') {
    files.push({
      path: `src/main/resources/assets/${input.namespace}/models/item/${input.name}.json`,
      content: JSON.stringify({
        parent: 'item/generated',
        textures: { layer0: `${input.namespace}:item/${input.name}` }
      }, null, 2) + '\n'
    })
    return files
  }

  files.push(
    {
      path: `src/main/resources/assets/${input.namespace}/blockstates/${input.name}.json`,
      content: JSON.stringify({
        variants: { '': { model: `${input.namespace}:block/${input.name}` } }
      }, null, 2) + '\n'
    },
    {
      path: `src/main/resources/assets/${input.namespace}/models/block/${input.name}.json`,
      content: JSON.stringify({
        parent: 'minecraft:block/cube_all',
        textures: { all: `${input.namespace}:block/${input.name}` }
      }, null, 2) + '\n'
    },
    {
      path: `src/main/resources/assets/${input.namespace}/models/item/${input.name}.json`,
      content: JSON.stringify({
        parent: `${input.namespace}:block/${input.name}`
      }, null, 2) + '\n'
    },
    {
      path: `src/main/resources/data/${input.namespace}/loot_tables/blocks/${input.name}.json`,
      content: JSON.stringify({
        type: 'minecraft:block',
        pools: [{
          rolls: 1,
          entries: [{ type: 'minecraft:item', name: `${input.namespace}:${input.name}` }],
          conditions: [{ condition: 'minecraft:survives_explosion' }]
        }]
      }, null, 2) + '\n'
    }
  )
  return files
}
