/**
 * Pure helpers for Mixin registration / validation that work for both
 * scaffold-generated Mixins (with // MODCRAFTING_MIXIN metadata) and
 * handwritten Mixins (no metadata marker).
 */

export type MixinSide = 'common' | 'client' | 'server'

export interface JavaIdentity {
  packageName: string
  className: string
  fqn: string
}

/** True when source looks like a Mixin class (has @Mixin annotation). */
export function hasMixinAnnotation(source: string): boolean {
  return /@Mixin\s*\(/.test(source)
}

export function parseJavaIdentity(source: string): JavaIdentity | null {
  const packageMatch = source.match(/^\s*package\s+([\w.]+)\s*;/m)
  const classMatch = source.match(/\b(?:class|interface)\s+([A-Za-z_$][\w$]*)/)
  if (!packageMatch || !classMatch) return null
  return {
    packageName: packageMatch[1],
    className: classMatch[1],
    fqn: `${packageMatch[1]}.${classMatch[1]}`
  }
}

/** Infer side from source path when MODCRAFTING_MIXIN metadata is absent. */
export function inferSideFromSourcePath(sourcePath: string): MixinSide {
  const normalized = sourcePath.replace(/\\/g, '/')
  if (normalized.includes('src/client/')) return 'client'
  if (normalized.includes('src/server/')) return 'server'
  return 'common'
}

export function sideToConfigKey(side: MixinSide): 'client' | 'server' | 'mixins' {
  if (side === 'client') return 'client'
  if (side === 'server') return 'server'
  return 'mixins'
}

/** Relative class name under the mixins.json package (e.g. "MouseMixin" or "sub.Foo"). */
export function relativeMixinClassName(
  identity: JavaIdentity,
  basePackage: string
): string {
  if (basePackage && identity.fqn.startsWith(`${basePackage}.`)) {
    return identity.fqn.slice(basePackage.length + 1)
  }
  return identity.className
}

/**
 * Check whether a Mixin class is registered in any of the given config arrays.
 * When `preferredKey` is set, that array is checked first; otherwise any of
 * client / server / mixins counts as registered (handwritten fallback).
 */
export function isMixinRegisteredInConfig(
  config: Record<string, unknown>,
  relativeClass: string,
  preferredKey?: 'client' | 'server' | 'mixins'
): { registered: boolean; key?: string } {
  const keys: Array<'client' | 'server' | 'mixins'> = preferredKey
    ? [preferredKey, ...(['client', 'server', 'mixins'] as const).filter((k) => k !== preferredKey)]
    : ['client', 'server', 'mixins']

  for (const key of keys) {
    const entries = config[key]
    if (Array.isArray(entries) && entries.includes(relativeClass)) {
      return { registered: true, key }
    }
  }
  return { registered: false }
}

/**
 * Path is acceptable for a handwritten Mixin: under src/main/java or src/client/java
 * (or src/server/java) and ends with the FQN path.
 */
export function isAcceptableHandwrittenMixinPath(
  sourcePath: string,
  fqn: string
): boolean {
  const normalized = sourcePath.replace(/\\/g, '/')
  const relative = `${fqn.replace(/\./g, '/')}.java`
  const candidates = [
    `src/main/java/${relative}`,
    `src/client/java/${relative}`,
    `src/server/java/${relative}`
  ]
  return candidates.includes(normalized)
}

export interface HandwrittenValidateInput {
  source: string
  sourcePath: string
  identity: JavaIdentity
  /** Config JSON already loaded, or null if missing. */
  config: Record<string, unknown> | null
  configName: string | null
  /** fabric.mod.json mixin config refs */
  refs: string[]
  /** Optional preferred side (from caller args or path inference). */
  preferredSide?: MixinSide
}

export interface HandwrittenValidateResult {
  ok: boolean
  errors: string[]
  side: MixinSide
  relativeClass: string
}

/**
 * Lightweight validation for handwritten Mixins without MODCRAFTING_MIXIN metadata.
 * Checks @Mixin presence, path sanity, and registration in mixins.json.
 */
export function validateHandwrittenMixin(input: HandwrittenValidateInput): HandwrittenValidateResult {
  const errors: string[] = []
  const side = input.preferredSide ?? inferSideFromSourcePath(input.sourcePath)
  const relativeClass = input.identity.className

  if (!hasMixinAnnotation(input.source)) {
    errors.push('源码缺少 @Mixin 注解，不是有效 Mixin')
  }

  if (!isAcceptableHandwrittenMixinPath(input.sourcePath, input.identity.fqn)) {
    errors.push(
      `源码路径应为 src/main/java/... 或 src/client/java/... 下的 ${input.identity.fqn.replace(/\./g, '/')}.java`
    )
  }

  if (!input.configName) {
    if (input.refs.length > 1) {
      errors.push(`存在多个配置，校验时必须指定 configPath：${input.refs.join(', ')}`)
    } else if (input.refs.length === 0) {
      errors.push('fabric.mod.json 未引用 Mixin 配置')
    }
  } else if (!input.refs.includes(input.configName)) {
    errors.push(`${input.configName} 未被 fabric.mod.json 引用`)
  }

  let resolvedRelative = relativeClass
  if (input.configName && input.config) {
    const basePackage = typeof input.config.package === 'string' ? input.config.package : ''
    resolvedRelative = relativeMixinClassName(input.identity, basePackage)
    if (
      basePackage &&
      input.identity.packageName !== basePackage &&
      !input.identity.packageName.startsWith(`${basePackage}.`)
    ) {
      errors.push(`Mixin 源码包 ${input.identity.packageName} 不在配置 package ${basePackage} 下`)
    }
    const preferredKey = sideToConfigKey(side)
    const check = isMixinRegisteredInConfig(input.config, resolvedRelative, preferredKey)
    if (!check.registered) {
      errors.push(`${resolvedRelative} 未注册到 ${input.configName} 的 ${preferredKey}（或任一 side 数组）`)
    }
  } else if (input.configName && !input.config) {
    errors.push(`${input.configName} 不存在或 JSON 无效`)
  }

  return {
    ok: errors.length === 0,
    errors,
    side,
    relativeClass: resolvedRelative
  }
}

/**
 * Gate for fabric_mixin_register when metadata is absent:
 * require @Mixin; otherwise reject.
 */
export function assertRegisterableMixin(
  source: string,
  metadataPresent: boolean
): string | null {
  if (metadataPresent) return null
  if (!hasMixinAnnotation(source)) {
    return 'Error: 源码缺少 @Mixin 注解，无法注册为 Mixin（手写 Mixin 须含 @Mixin；或使用 fabric_mixin_scaffold 生成）'
  }
  return null
}
