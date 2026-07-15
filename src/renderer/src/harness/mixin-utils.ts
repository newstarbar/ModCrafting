export type SupportedMixinInjection = 'inject' | 'accessor' | 'invoker' | 'redirect' | 'modify_arg' | 'modify_return_value'
export type SupportedAt = 'HEAD' | 'TAIL' | 'RETURN' | 'INVOKE' | 'FIELD'

export interface MixinScaffoldMetadata {
  version: 1
  targetClass: string
  selector: string
  descriptor: string
  injectionType: SupportedMixinInjection
  at: SupportedAt
  atTarget?: string
  side: 'common' | 'client' | 'server'
  cancellable?: boolean
  argumentIndex?: number
  fieldOperation?: 'GET' | 'SET'
}

export interface ParsedMethodDescriptor {
  parameters: string[]
  returnType: string
}

const PRIMITIVES: Record<string, string> = {
  V: 'void', Z: 'boolean', B: 'byte', C: 'char', S: 'short', I: 'int', J: 'long', F: 'float', D: 'double'
}

const BOXED: Record<string, string> = {
  void: 'Void', boolean: 'Boolean', byte: 'Byte', char: 'Character', short: 'Short', int: 'Integer', long: 'Long', float: 'Float', double: 'Double'
}

function parseType(descriptor: string, start: number): { type: string; next: number } {
  let index = start
  let dimensions = 0
  while (descriptor[index] === '[') { dimensions++; index++ }
  let type: string
  const token = descriptor[index]
  if (token === 'L') {
    const end = descriptor.indexOf(';', index)
    if (end < 0) throw new Error(`Invalid JVM descriptor: ${descriptor}`)
    type = descriptor.slice(index + 1, end).replaceAll('/', '.')
    index = end + 1
  } else if (PRIMITIVES[token]) {
    type = PRIMITIVES[token]
    index++
  } else {
    throw new Error(`Invalid JVM descriptor token "${token}" in ${descriptor}`)
  }
  return { type: type + '[]'.repeat(dimensions), next: index }
}

export function parseMethodDescriptor(descriptor: string): ParsedMethodDescriptor {
  if (!descriptor.startsWith('(')) throw new Error(`Expected method descriptor, received ${descriptor}`)
  const parameters: string[] = []
  let index = 1
  while (descriptor[index] !== ')') {
    if (index >= descriptor.length) throw new Error(`Invalid method descriptor: ${descriptor}`)
    const parsed = parseType(descriptor, index)
    parameters.push(parsed.type)
    index = parsed.next
  }
  const result = parseType(descriptor, index + 1)
  if (result.next !== descriptor.length) throw new Error(`Trailing data in method descriptor: ${descriptor}`)
  return { parameters, returnType: result.type }
}

export function parseFieldDescriptor(descriptor: string): string {
  const result = parseType(descriptor, 0)
  if (result.next !== descriptor.length || result.type === 'void') throw new Error(`Invalid field descriptor: ${descriptor}`)
  return result.type
}

export function boxedJavaType(type: string): string {
  return BOXED[type] || type
}

export function simpleJavaName(type: string): string {
  const suffix = type.endsWith('[]') ? '[]' : ''
  const raw = suffix ? type.slice(0, -2) : type
  return (raw.split('.').pop() || raw).replaceAll('$', '.') + suffix
}

export function parseAtTarget(value: string): { className: string; memberName: string; descriptor: string; kind: 'method' | 'field' } | null {
  const method = value.match(/^L([^;]+);([\w$]+)(\(.*\).+)$/)
  if (method) return { className: method[1].replaceAll('/', '.'), memberName: method[2], descriptor: method[3], kind: 'method' }
  const field = value.match(/^L([^;]+);([\w$]+):(.+)$/)
  if (field) return { className: field[1].replaceAll('/', '.'), memberName: field[2], descriptor: field[3], kind: 'field' }
  return null
}

function collectImports(types: string[]): { imports: string[]; render: (type: string) => string } {
  const imports = [...new Set(types
    .map((type) => type.replace(/\[\]$/, ''))
    .filter((type) => type.includes('.') && !type.startsWith('java.lang.'))
    .map((type) => type.replaceAll('$', '.')))]
    .sort()
  return {
    imports,
    render: (type) => simpleJavaName(type)
  }
}

export function buildMixinScaffold(input: {
  packageName: string
  className: string
  metadata: MixinScaffoldMetadata
  targetStatic: boolean
  atTargetStatic?: boolean
}): string {
  const { metadata } = input
  const target = metadata.injectionType === 'accessor'
    ? { parameters: [] as string[], returnType: parseFieldDescriptor(metadata.descriptor) }
    : parseMethodDescriptor(metadata.descriptor)
  const atTarget = metadata.atTarget ? parseAtTarget(metadata.atTarget) : null
  const atMethod = atTarget?.kind === 'method' ? parseMethodDescriptor(atTarget.descriptor) : null
  const atField = atTarget?.kind === 'field' ? parseFieldDescriptor(atTarget.descriptor) : null
  const allTypes = [metadata.targetClass, ...target.parameters, target.returnType]
  if (atTarget) allTypes.push(atTarget.className)
  if (atMethod) allTypes.push(...atMethod.parameters, atMethod.returnType)
  if (atField) allTypes.push(atField)
  const { imports, render } = collectImports(allTypes)
  const targetSimple = render(metadata.targetClass)
  const staticPrefix = input.targetStatic ? 'static ' : ''
  const selector = `${metadata.selector}${metadata.descriptor}`
  const marker = `// MODCRAFTING_MIXIN ${JSON.stringify(metadata)}`
  const annotationAt = metadata.at === 'INVOKE' || metadata.at === 'FIELD'
    ? `@At(value = "${metadata.at}", target = "${metadata.atTarget}")`
    : `@At("${metadata.at}")`
  let importsBlock = [
    'org.spongepowered.asm.mixin.Mixin',
    ...imports
  ]
  let body = ''
  let declaration = `public abstract class ${input.className}`

  if (metadata.injectionType === 'inject') {
    importsBlock.push('org.spongepowered.asm.mixin.injection.At', 'org.spongepowered.asm.mixin.injection.Inject')
    const callbackType = target.returnType === 'void'
      ? 'org.spongepowered.asm.mixin.injection.callback.CallbackInfo'
      : 'org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable'
    importsBlock.push(callbackType)
    const callback = target.returnType === 'void' ? 'CallbackInfo ci' : `CallbackInfoReturnable<${render(boxedJavaType(target.returnType))}> cir`
    const params = [...target.parameters.map((type, index) => `${render(type)} arg${index}`), callback].join(', ')
    body = `    @Inject(method = "${selector}", at = ${annotationAt}${metadata.cancellable ? ', cancellable = true' : ''})\n` +
      `    private ${staticPrefix}void modcrafting$inject(${params}) {\n` +
      '        // Implement only the business logic. Target signature and callback type are validated.\n' +
      '    }'
  } else if (metadata.injectionType === 'accessor') {
    importsBlock.push('org.spongepowered.asm.mixin.gen.Accessor')
    declaration = `public interface ${input.className}`
    const fieldType = parseFieldDescriptor(metadata.descriptor)
    body = input.targetStatic
      ? `    @Accessor("${metadata.selector}")\n    static ${render(fieldType)} modcrafting$get${metadata.selector}() { throw new AssertionError(); }`
      : `    @Accessor("${metadata.selector}")\n    ${render(fieldType)} modcrafting$get${metadata.selector}();`
  } else if (metadata.injectionType === 'invoker') {
    importsBlock.push('org.spongepowered.asm.mixin.gen.Invoker')
    declaration = `public interface ${input.className}`
    const params = target.parameters.map((type, index) => `${render(type)} arg${index}`).join(', ')
    const signature = `${render(target.returnType)} modcrafting$invoke${metadata.selector}(${params})`
    body = input.targetStatic
      ? `    @Invoker("${metadata.selector}")\n    static ${signature} { throw new AssertionError(); }`
      : `    @Invoker("${metadata.selector}")\n    ${signature};`
  } else if (metadata.injectionType === 'redirect') {
    importsBlock.push('org.spongepowered.asm.mixin.injection.At', 'org.spongepowered.asm.mixin.injection.Redirect')
    if (!atTarget) throw new Error('redirect requires an exact atTarget')
    let params: string[] = []
    let returnType = 'void'
    if (atMethod) {
      if (!input.atTargetStatic) params.push(`${render(atTarget.className)} instance`)
      params.push(...atMethod.parameters.map((type, index) => `${render(type)} arg${index}`))
      returnType = render(atMethod.returnType)
    } else if (atField) {
      const operation = metadata.fieldOperation || 'GET'
      if (!input.atTargetStatic) params.push(`${render(atTarget.className)} instance`)
      if (operation === 'SET') params.push(`${render(atField)} value`)
      returnType = operation === 'GET' ? render(atField) : 'void'
    }
    body = `    @Redirect(method = "${selector}", at = ${annotationAt})\n` +
      `    private ${staticPrefix}${returnType} modcrafting$redirect(${params.join(', ')}) {\n` +
      '        throw new UnsupportedOperationException("Implement redirect behavior");\n' +
      '    }'
  } else if (metadata.injectionType === 'modify_arg') {
    importsBlock.push('org.spongepowered.asm.mixin.injection.At', 'org.spongepowered.asm.mixin.injection.ModifyArg')
    if (!atMethod || metadata.argumentIndex == null || !atMethod.parameters[metadata.argumentIndex]) {
      throw new Error('modify_arg requires an exact INVOKE atTarget and valid argumentIndex')
    }
    const argumentType = render(atMethod.parameters[metadata.argumentIndex])
    body = `    @ModifyArg(method = "${selector}", at = ${annotationAt}, index = ${metadata.argumentIndex})\n` +
      `    private ${staticPrefix}${argumentType} modcrafting$modifyArg(${argumentType} value) {\n        return value;\n    }`
  } else {
    importsBlock.push('com.llamalad7.mixinextras.injector.ModifyReturnValue', 'org.spongepowered.asm.mixin.injection.At')
    if (target.returnType === 'void') throw new Error('modify_return_value cannot target a void method')
    const returnType = render(target.returnType)
    body = `    @ModifyReturnValue(method = "${selector}", at = @At("RETURN"))\n` +
      `    private ${staticPrefix}${returnType} modcrafting$modifyReturnValue(${returnType} original) {\n        return original;\n    }`
  }

  const renderedImports = [...new Set(importsBlock)].sort().map((entry) => `import ${entry};`).join('\n')
  return `package ${input.packageName};\n\n${renderedImports}\n\n${marker}\n@Mixin(${targetSimple}.class)\n${declaration} {\n${body}\n}\n`
}

export function readMixinMetadata(source: string): MixinScaffoldMetadata | null {
  const match = source.match(/^\/\/ MODCRAFTING_MIXIN (\{.*\})$/m)
  if (!match) return null
  try {
    const parsed = JSON.parse(match[1]) as MixinScaffoldMetadata
    return parsed.version === 1 ? parsed : null
  } catch {
    return null
  }
}
