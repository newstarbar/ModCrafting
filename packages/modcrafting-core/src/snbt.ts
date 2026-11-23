/**
 * SNBT (stringified NBT) reader and writer.
 *
 * FTB Quests stores every chapter, quest, task and reward as SNBT on disk, so
 * "author a quest book" means "emit valid SNBT". This module is the only place
 * allowed to do that: string templates cannot preserve NBT types, and the type
 * *is* the data here — `x: 0` (int) and `x: 0.0d` (double) are different tags,
 * and a rewritten `5` where the game expects `5L` silently changes a progress
 * counter into a value the codec rejects.
 *
 * Grammar notes that matter in practice:
 *  - Separators are optional. Minecraft's parser accepts `{a:1 b:2}` as well as
 *    `{a:1,b:2}`, and FTB's writer emits one entry per line with **no commas**.
 *  - Booleans are bytes. FTB writes `hide: false`, not `hide: 0b`, so the writer
 *    mirrors that for byte 0/1 and falls back to `1b` for anything else.
 *  - Unquoted strings are accepted on read; the writer always quotes, because a
 *    bare string that looks numeric is otherwise read back as a number.
 *
 * Pure module: no Node imports, so the browser can format a preview with the
 * exact same code the server writes to disk.
 */

export type NbtByte = { readonly t: 'byte'; readonly v: number }
export type NbtShort = { readonly t: 'short'; readonly v: number }
export type NbtInt = { readonly t: 'int'; readonly v: number }
/** NBT longs are 64-bit; this stores them as a JS number and refuses unsafe values. */
export type NbtLong = { readonly t: 'long'; readonly v: number }
export type NbtFloat = { readonly t: 'float'; readonly v: number }
export type NbtDouble = { readonly t: 'double'; readonly v: number }
export type NbtString = { readonly t: 'string'; readonly v: string }
export type NbtList = { readonly t: 'list'; readonly v: readonly NbtValue[] }
export type NbtCompound = { readonly t: 'compound'; readonly v: Readonly<Record<string, NbtValue>> }
export type NbtByteArray = { readonly t: 'byteArray'; readonly v: readonly number[] }
export type NbtIntArray = { readonly t: 'intArray'; readonly v: readonly number[] }
export type NbtLongArray = { readonly t: 'longArray'; readonly v: readonly number[] }

export type NbtValue =
  | NbtByte | NbtShort | NbtInt | NbtLong | NbtFloat | NbtDouble | NbtString
  | NbtList | NbtCompound | NbtByteArray | NbtIntArray | NbtLongArray

export type NbtScalar = NbtByte | NbtShort | NbtInt | NbtLong | NbtFloat | NbtDouble | NbtString

// ---------------------------------------------------------------------------
// Constructors. Kept tiny so call sites read like the SNBT they emit.
// ---------------------------------------------------------------------------

export const nbtByte = (v: number): NbtByte => ({ t: 'byte', v })
export const nbtShort = (v: number): NbtShort => ({ t: 'short', v })
export const nbtInt = (v: number): NbtInt => ({ t: 'int', v })
export const nbtLong = (v: number): NbtLong => ({ t: 'long', v })
export const nbtFloat = (v: number): NbtFloat => ({ t: 'float', v })
export const nbtDouble = (v: number): NbtDouble => ({ t: 'double', v })
export const nbtString = (v: string): NbtString => ({ t: 'string', v })
export const nbtList = (v: readonly NbtValue[]): NbtList => ({ t: 'list', v })
export const nbtCompound = (v: Record<string, NbtValue>): NbtCompound => ({ t: 'compound', v })

export function isNbtCompound(value: NbtValue | undefined): value is NbtCompound {
  return value?.t === 'compound'
}

export function isNbtList(value: NbtValue | undefined): value is NbtList {
  return value?.t === 'list'
}

export function isNbtScalar(value: NbtValue | undefined): value is NbtScalar {
  return Boolean(value) && value!.t !== 'compound' && value!.t !== 'list'
    && value!.t !== 'byteArray' && value!.t !== 'intArray' && value!.t !== 'longArray'
}

/** The string this value carries, or undefined when it is not a string tag. */
export function nbtText(value: NbtValue | undefined): string | undefined {
  return value?.t === 'string' ? value.v : undefined
}

/** The numeric value of any numeric tag, or undefined. */
export function nbtNumber(value: NbtValue | undefined): number | undefined {
  if (!value) return undefined
  switch (value.t) {
    case 'byte': case 'short': case 'int': case 'long': case 'float': case 'double':
      return value.v
    default:
      return undefined
  }
}

export function nbtEntries(value: NbtValue | undefined): Array<[string, NbtValue]> {
  return value?.t === 'compound' ? Object.entries(value.v) : []
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

const NUMBER_RE = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)([bBsSlLfFdD])?$/

class SnbtReader {
  private index = 0
  // Explicit field, not a parameter property: Node's strip-only TypeScript mode
  // rejects `constructor(private readonly text: string)`.
  private readonly text: string

  constructor(text: string) {
    this.text = text
  }

  parseDocument(): NbtValue {
    this.skipTrivia()
    if (this.index >= this.text.length) this.fail('内容为空')
    const value = this.readValue()
    this.skipTrivia()
    if (this.index < this.text.length) this.fail(`值后面还有多余内容「${this.text.slice(this.index, this.index + 12)}」`)
    return value
  }

  private fail(message: string): never {
    const before = this.text.slice(0, this.index)
    const line = before.split('\n').length
    const column = this.index - before.lastIndexOf('\n')
    throw Object.assign(
      new Error(`SNBT 解析失败（第 ${line} 行第 ${column} 列）：${message}`),
      { code: 'SNBT_INVALID', line, column, offset: this.index }
    )
  }

  /** Whitespace, newlines and `//` line comments. FTB writes no comments, humans do. */
  private skipTrivia(): void {
    for (;;) {
      while (this.index < this.text.length && /\s/.test(this.text[this.index])) this.index += 1
      if (this.text.startsWith('//', this.index)) {
        const end = this.text.indexOf('\n', this.index)
        this.index = end < 0 ? this.text.length : end + 1
        continue
      }
      return
    }
  }

  private peek(): string {
    return this.text[this.index] ?? ''
  }

  private expect(character: string, context: string): void {
    this.skipTrivia()
    if (this.peek() !== character) this.fail(`${context}缺少「${character}」`)
    this.index += 1
  }

  private readValue(): NbtValue {
    this.skipTrivia()
    const character = this.peek()
    if (character === '') this.fail('期望一个值，但内容已结束')
    if (character === '{') return this.readCompound()
    if (character === '[') return this.readList()
    if (character === '"') return nbtString(this.readQuoted())
    return this.readBareValue()
  }

  private readCompound(): NbtCompound {
    this.index += 1 // {
    const value: Record<string, NbtValue> = {}
    for (;;) {
      this.skipTrivia()
      if (this.peek() === '}') { this.index += 1; return nbtCompound(value) }
      if (this.peek() === '') this.fail('复合标签没有闭合的「}」')

      const key = this.peek() === '"' ? this.readQuoted() : this.readBareToken()
      if (!key) {
        if (this.peek() === ':') this.fail('这里出现了一个「:」；上一个值是字符串且含冒号时，必须给它加引号（例如 "minecraft:diamond"）')
        this.fail('复合标签的键为空')
      }
      this.skipTrivia()
      if (this.peek() === ':') this.index += 1
      else this.fail(`键「${key}」后面缺少「:」`)

      value[key] = this.readValue()
      this.skipTrivia()
      // A comma is optional: FTB's own writer separates entries with newlines.
      if (this.peek() === ',') this.index += 1
    }
  }

  private readList(): NbtValue {
    this.index += 1 // [
    this.skipTrivia()

    const typed = this.peekTypedArray()
    if (typed) {
      this.index += 2 // marker + ;
      const values: number[] = []
      for (;;) {
        this.skipTrivia()
        if (this.peek() === ']') { this.index += 1; return { t: typed, v: values } }
        if (this.peek() === '') this.fail(`数组标签没有闭合的「]」`)
        const item = this.readValue()
        const number = nbtNumber(item)
        if (number === undefined) this.fail('数组元素必须是数字')
        values.push(number)
        this.skipTrivia()
        if (this.peek() === ',') this.index += 1
      }
    }

    const values: NbtValue[] = []
    for (;;) {
      this.skipTrivia()
      if (this.peek() === ']') { this.index += 1; return nbtList(values) }
      if (this.peek() === '') this.fail('列表标签没有闭合的「]」')
      values.push(this.readValue())
      this.skipTrivia()
      if (this.peek() === ',') this.index += 1
    }
  }

  /** `[B;` / `[I;` / `[L;` — the marker is a single letter followed by a semicolon. */
  private peekTypedArray(): 'byteArray' | 'intArray' | 'longArray' | undefined {
    const head = this.text.slice(this.index, this.index + 2)
    if (head.length < 2 || head[1] !== ';') return undefined
    switch (head[0]) {
      case 'B': return 'byteArray'
      case 'I': return 'intArray'
      case 'L': return 'longArray'
      default: return undefined
    }
  }

  private readQuoted(): string {
    this.index += 1 // opening quote
    let output = ''
    for (;;) {
      if (this.index >= this.text.length) this.fail('字符串没有闭合的引号')
      const character = this.text[this.index]
      if (character === '"') { this.index += 1; return output }
      if (character !== '\\') { output += character; this.index += 1; continue }
      this.index += 1
      const escaped = this.text[this.index]
      if (escaped === undefined) this.fail('转义符后面没有字符')
      this.index += 1
      switch (escaped) {
        case 'n': output += '\n'; break
        case 't': output += '\t'; break
        case 'r': output += '\r'; break
        case 'b': output += '\b'; break
        case 'f': output += '\f'; break
        case '"': output += '"'; break
        case '\\': output += '\\'; break
        case 'u': {
          const hex = this.text.slice(this.index, this.index + 4)
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail('\\u 后面需要 4 位十六进制')
          output += String.fromCharCode(Number.parseInt(hex, 16))
          this.index += 4
          break
        }
        default: output += escaped
      }
    }
  }

  /**
   * A run of characters allowed in an unquoted token.
   *
   * The set matches Minecraft's `StringReader`: only `[0-9A-Za-z_.+-]` may appear
   * bare. Everything else terminates the token, which is why `minecraft:diamond`
   * *must* be quoted — and why the writer always quotes.
   */
  private readBareToken(): string {
    const start = this.index
    while (this.index < this.text.length && /[0-9A-Za-z_.+-]/.test(this.text[this.index])) this.index += 1
    return this.text.slice(start, this.index)
  }

  private readBareValue(): NbtValue {
    const token = this.readBareToken()
    if (!token) this.fail('期望一个值')
    if (token === 'true') return nbtByte(1)
    if (token === 'false') return nbtByte(0)

    const match = NUMBER_RE.exec(token)
    if (!match) return nbtString(token)

    const [, digits, suffix] = match
    const decimal = /[.eE]/.test(digits)
    switch ((suffix ?? '').toLowerCase()) {
      case 'b': return nbtByte(this.integer(digits, 8, token))
      case 's': return nbtShort(this.integer(digits, 16, token))
      case 'f': return nbtFloat(this.finite(Number(digits), token))
      case 'd': return nbtDouble(this.finite(Number(digits), token))
      case 'l': return nbtLong(this.integer(digits, 64, token))
      case '': return decimal ? nbtDouble(this.finite(Number(digits), token)) : nbtInt(this.integer(digits, 32, token))
      default: return nbtString(token)
    }
  }

  private integer(digits: string, bits: number, token: string): number {
    const value = Number(digits)
    if (!Number.isInteger(value)) this.fail(`「${token}」不是整数`)
    if (bits === 64) {
      if (!Number.isSafeInteger(value)) {
        this.fail(`长整数「${token}」超出 JavaScript 的安全整数范围；请先在 FTB Quests 里修掉这个值，或改用字符串表示`)
      }
      return value
    }
    const limit = 2 ** (bits - 1)
    if (value < -limit || value >= limit) this.fail(`「${token}」超出 ${bits} 位整数范围`)
    return value
  }

  private finite(value: number, token: string): number {
    if (!Number.isFinite(value)) this.fail(`「${token}」不是有限数字`)
    return value
  }
}

export function parseSnbt(text: string): NbtValue {
  if (typeof text !== 'string') {
    throw Object.assign(new Error('SNBT 必须是字符串'), { code: 'SNBT_INVALID' })
  }
  return new SnbtReader(text).parseDocument()
}

/** Every FTB Quests file has a compound at the top level; this saves a narrowing step. */
export function parseSnbtCompound(text: string): NbtCompound {
  const value = parseSnbt(text)
  if (value.t !== 'compound') {
    throw Object.assign(new Error('SNBT 顶层必须是复合标签（以「{」开头）'), { code: 'SNBT_INVALID' })
  }
  return value
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

export interface PrintOptions {
  /** One indentation unit. FTB uses tabs; keep the default to minimise diffs. */
  indent?: string
  /** Containers whose compact form fits in this many characters stay on one line. */
  maxInline?: number
}

const DEFAULT_INDENT = '\t'
const DEFAULT_MAX_INLINE = 96

function escapeString(value: string): string {
  let output = ''
  for (const character of value) {
    switch (character) {
      case '"': output += '\\"'; break
      case '\\': output += '\\\\'; break
      case '\n': output += '\\n'; break
      case '\t': output += '\\t'; break
      case '\r': output += '\\r'; break
      case '\b': output += '\\b'; break
      case '\f': output += '\\f'; break
      default: {
        const code = character.codePointAt(0) ?? 0
        output += code < 0x20 ? `\\u${code.toString(16).padStart(4, '0')}` : character
      }
    }
  }
  return output
}

function formatNumber(value: number, suffix: string): string {
  if (!Number.isFinite(value)) {
    throw Object.assign(new Error(`不能写出非有限数值：${value}`), { code: 'SNBT_INVALID' })
  }
  if (suffix === 'f' || suffix === 'd') {
    // Java rejects scientific notation with a type suffix, so expand it first.
    const text = Number.isInteger(value)
      ? `${value}.0`
      : /e/i.test(String(value))
        ? value.toFixed(10).replace(/0+$/, '').replace(/\.$/, '.0')
        : String(value)
    return `${text}${suffix}`
  }
  if (!Number.isInteger(value)) {
    throw Object.assign(new Error(`不能把非整数写成 ${suffix} 类型：${value}`), { code: 'SNBT_INVALID' })
  }
  return `${value}${suffix}`
}

function scalarText(value: NbtScalar): string {
  switch (value.t) {
    case 'byte': return value.v === 1 ? 'true' : value.v === 0 ? 'false' : formatNumber(value.v, 'b')
    case 'short': return formatNumber(value.v, 's')
    case 'int': return formatNumber(value.v, '')
    case 'long': return formatNumber(value.v, 'L')
    case 'float': return formatNumber(value.v, 'f')
    case 'double': return formatNumber(value.v, 'd')
    case 'string': return `"${escapeString(value.v)}"`
  }
}

function safeKey(key: string): string {
  return /^[A-Za-z0-9_.+-]+$/.test(key) ? key : `"${escapeString(key)}"`
}

function compact(value: NbtValue): string {
  switch (value.t) {
    case 'byte': case 'short': case 'int': case 'long': case 'float': case 'double': case 'string':
      return scalarText(value)
    case 'byteArray': return `[B;${value.v.map((item) => formatNumber(item, 'b')).join(',')}]`
    case 'intArray': return `[I;${value.v.map((item) => formatNumber(item, '')).join(',')}]`
    case 'longArray': return `[L;${value.v.map((item) => formatNumber(item, 'L')).join(',')}]`
    case 'list': return `[${value.v.map(compact).join(',')}]`
    case 'compound': {
      const entries = Object.entries(value.v)
      if (entries.length === 0) return '{}'
      return `{${entries.map(([key, child]) => `${safeKey(key)}:${compact(child)}`).join(',')}}`
    }
  }
}

function expanded(value: NbtValue, level: number, options: Required<PrintOptions>): string {
  const pad = options.indent.repeat(level + 1)
  const closing = options.indent.repeat(level)

  if (value.t === 'compound') {
    const entries = Object.entries(value.v)
    if (entries.length === 0) return '{}'
    const lines = entries.map(([key, child]) => `${pad}${safeKey(key)}: ${render(child, level + 1, options)}`)
    return `{\n${lines.join('\n')}\n${closing}}`
  }
  if (value.t === 'list') {
    if (value.v.length === 0) return '[]'
    const lines = value.v.map((child) => `${pad}${render(child, level + 1, options)}`)
    return `[\n${lines.join('\n')}\n${closing}]`
  }
  return compact(value)
}

/** Inline when it fits, otherwise expand. Scalars always render inline. */
function render(value: NbtValue, level: number, options: Required<PrintOptions>): string {
  switch (value.t) {
    case 'compound': case 'list': {
      const inline = compact(value)
      return inline.length <= options.maxInline ? inline : expanded(value, level, options)
    }
    default:
      return compact(value)
  }
}

export function printSnbt(value: NbtValue, options: PrintOptions = {}): string {
  const resolved: Required<PrintOptions> = {
    indent: options.indent ?? DEFAULT_INDENT,
    maxInline: options.maxInline ?? DEFAULT_MAX_INLINE
  }
  // The document root is always expanded: a one-line 20 KB quest file defeats
  // version control, and FTB writes one entry per line for the same reason.
  return `${expanded(value, 0, resolved)}\n`
}

/**
 * A stable identity for a value, used for change detection.
 *
 * Two documents that differ only in whitespace or key order produce the same
 * signature, so a save is only attempted when the *data* changed.
 */
export function snbtSignature(value: NbtValue): string {
  return compact(sortKeys(value))
}

function sortKeys(value: NbtValue): NbtValue {
  switch (value.t) {
    case 'compound': {
      const sorted: Record<string, NbtValue> = {}
      for (const key of Object.keys(value.v).sort()) sorted[key] = sortKeys(value.v[key])
      return nbtCompound(sorted)
    }
    case 'list': return nbtList(value.v.map(sortKeys))
    default: return value
  }
}
