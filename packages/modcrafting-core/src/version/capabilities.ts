/**
 * The capability surface: what this plugin can actually do for a given target.
 *
 * This is the one source of truth that every gate derives from — the content
 * generator's refusals, project materialization, the build probe and the MCP tool
 * descriptions all read the same table. Before it existed, "can I do X on target Y"
 * was answered by four different hardcoded checks, so an Agent had to hit four
 * different walls to learn the same boundary.
 *
 * `state` is deliberately two-valued and honest: `blocked` always carries a reason
 * plus the requirement that would unblock it. Generality of the architecture does
 * not mean pretending coverage — an Agent that gets a precise "no, because…, and
 * here is what would change it" is far more capable than one that guesses.
 */
import type { ContentKind } from '../content-model.ts'
import { contentKinds } from '../content-model.ts'
import { deriveJavaApiProfile, type JavaApiProfile } from './java-profile.ts'
import { getRegistry } from './registry.ts'
import type { LoaderId } from './schema.ts'

export type CapabilityState = 'available' | 'blocked'

export interface Capability {
  state: CapabilityState
  reason?: string
  /** What would unblock it, in terms an Agent can act on or report to the user. */
  requirement?: string
}

export interface TargetCapabilities {
  createProject: Capability
  content: Record<ContentKind, Capability>
  recipes: Capability
  gui: Capability
  build: Capability & { evidence: 'probed' | 'declared'; requires: string[] }
  runtimeTest: Capability
}

export interface CapabilityInput {
  loader: LoaderId
  minecraft: string
  release?: { javaTarget?: number; mappings?: { kind?: string }; build?: { evidence?: string; gradle?: string; pluginVersion?: string } }
  runtimeObserver?: boolean
}

const available = (): Capability => ({ state: 'available' })
const blocked = (reason: string, requirement?: string): Capability => ({ state: 'blocked', reason, ...(requirement ? { requirement } : {}) })

export function capabilitiesFor(input: CapabilityInput, api?: JavaApiProfile): TargetCapabilities {
  const profile = api ?? deriveJavaApiProfile(input.minecraft, input.loader === 'fabric' ? 'yarn' : 'mojmap', getRegistry())
  // Scaffolding (build files + platform metadata) is per-loader; the Java *content*
  // emitter is Yarn-only today, so non-Fabric targets can be created but not filled.
  const scaffoldReady = input.loader === 'fabric' || input.loader === 'neoforge' || input.loader === 'forge'
  const javaEmitterReady = input.loader === 'fabric'
  // The Java emitter is Yarn-structural: 26.x switched to Mojang official mappings
  // (yarn has no 26.x builds), so its content needs a Mojmap emitter first.
  const mappingKind = input.release?.mappings?.kind ?? profile.mapping
  const modernRegistration = profile.registration === 'registry-key' && mappingKind === 'yarn'
  // Tool/armor/entity Java uses the 1.21.2+ material and render APIs.
  const modernMaterial = modernRegistration && profile.entity.renderState === 'shared-state'
  const createProject = scaffoldReady
    ? available()
    : blocked(`${input.loader} 的平台适配尚未实现`, `P4 平台层：loaders/${input.loader}`)

  const content = Object.fromEntries(contentKinds.map((kind): [ContentKind, Capability] => {
    if (input.loader === 'forge') {
      // Same Mojmap API, different registry layer (ForgeRegistries + RegistryObject).
      return [kind, ['item', 'block', 'food'].includes(kind)
        ? available()
        : blocked(`${kind} 的 Forge 发射器尚未实现（item/block/food 已落地）`, '按类型逐个落地，并用 probe:target 在 CI 验证')]
    }
    if (input.loader === 'neoforge') {
      // The NeoForge emitter covers item first; each kind is flipped only once its
      // emitter exists and its shape is pinned by tests.
      return [kind, ['item', 'block', 'food'].includes(kind)
        ? available()
        : blocked(`${kind} 的 NeoForge 发射器尚未实现（item/block/food 已落地）`, '按类型逐个落地，并用 probe:target 在 CI 验证')]
    }
    if (!javaEmitterReady) return [kind, blocked(`生成器尚未产出 ${input.loader} 的 Java`, 'P4 内容层：Mojmap 注册与 DeferredRegister 对接')]
    if (mappingKind !== 'yarn') return [kind, blocked(`Mojmap 内容发射器尚未实现（${input.minecraft} 使用官方映射，yarn 未发布 26.x）`, 'P4 内容层：Mojmap 结构发射器')]
    if (kind === 'tool' || kind === 'armor' || kind === 'entity') {
      return [kind, modernMaterial ? available() : blocked(`${kind} 的 Java 使用 1.21.2+ 的材质/渲染 API`, '该目标需要 1.21.2+，或交由 Agent 手写')]
    }
    return [kind, available()]
  })) as Record<ContentKind, Capability>

  // Both draw-call generations are implemented and compile-proven (2026-11-16:
  // fabric@1.20.1 and fabric@1.21.4 build generated item/block/food/GUI Java).
  const gui = javaEmitterReady && mappingKind === 'yarn'
    ? available()
    : blocked(javaEmitterReady ? `GUI 的客户端 Java 尚未适配 ${mappingKind} 映射` : `GUI 的客户端 Java 尚未适配 ${input.loader}`, 'P4 内容层：Mojmap 结构发射器')

  const evidence = input.release?.build?.evidence === 'probed' ? 'probed' : 'declared'
  // Once a real build succeeded, the toolchain it used is part of the proof — the
  // second toolchain (JDK 25 + Gradle 9.8) is then a fact, not a missing requirement.
  const requires: string[] = evidence === 'probed'
    ? []
    : [
      ...(input.release?.javaTarget ?? 0) > 21 ? [`JDK ${input.release?.javaTarget}`] : [],
      ...(input.release?.javaTarget ?? 0) > 21 ? ['Gradle ≥ 9.8 与 Loom 1.19.4（第二套工具链）'] : [],
      // Probed 2026-11-16 (fabric@26.3): yarn has no 26.x builds AND loom's
      // officialMojangMappings cannot find 26.3 — the ecosystem mapping story for
      // 26.x is not settled yet. The toolchain itself runs fine up to configuration.
      ...(input.release?.javaTarget ?? 0) > 21 && input.loader === 'fabric' ? ['26.x 映射方案待定（yarn 未发布、loom 官方映射未覆盖）'] : []
    ]
  const base = evidence === 'probed' ? available() : requires.length ? blocked(`${input.minecraft} 需要尚未就绪的工具链`, requires.join('；')) : available()
  const build: TargetCapabilities['build'] = { ...base, evidence, requires }

  return {
    createProject,
    content,
    recipes: available(),
    gui,
    build,
    runtimeTest: input.runtimeObserver
      ? available()
      : blocked(`${input.minecraft} 没有对应的 Observer 游戏测试运行时`, '构建可用性由 probe:target 证明；游戏内测试需要 Observer')
  }
}
