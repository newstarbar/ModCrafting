import { app, safeStorage } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { inferProviderId } from '../shared/llm-providers.ts'

const DEFAULT_ENDPOINT = 'https://api.deepseek.com/v1'
const DEFAULT_MODEL = 'deepseek-v4-flash'
const DEFAULT_PROVIDER_ID = 'deepseek'

export interface ApiSettings {
  endpoint: string
  model: string
  providerId: string
  hasApiKey: boolean
  savedProviderIds: string[]
  encryptionAvailable: boolean
}

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'api-settings.json')
}

function legacyApiKeyPath(): string {
  return path.join(app.getPath('userData'), 'api-key.bin')
}

function apiKeysDir(): string {
  return path.join(app.getPath('userData'), 'api-keys')
}

function sanitizeProviderId(providerId: string): string {
  return providerId.replace(/[^a-z0-9_-]/gi, '_') || DEFAULT_PROVIDER_ID
}

function apiKeyPathForProvider(providerId: string): string {
  return path.join(apiKeysDir(), `${sanitizeProviderId(providerId)}.bin`)
}

let legacyKeyMigrated = false

function migrateLegacyApiKey(): void {
  if (legacyKeyMigrated) return
  legacyKeyMigrated = true

  const legacyPath = legacyApiKeyPath()
  if (!fs.existsSync(legacyPath)) return

  const file = readSettingsFile()
  const endpoint = file.endpoint || DEFAULT_ENDPOINT
  const model = file.model || DEFAULT_MODEL
  const providerId = file.providerId || inferProviderId(endpoint, model) || DEFAULT_PROVIDER_ID
  const dest = apiKeyPathForProvider(providerId)

  try {
    fs.mkdirSync(apiKeysDir(), { recursive: true })
    if (!fs.existsSync(dest)) {
      fs.copyFileSync(legacyPath, dest)
    }
    fs.unlinkSync(legacyPath)
  } catch {
    // Keep legacy file if migration fails
  }
}

function readSettingsFile(): { endpoint?: string; model?: string; providerId?: string } {
  try {
    const p = settingsPath()
    if (!fs.existsSync(p)) return {}
    return JSON.parse(fs.readFileSync(p, 'utf-8'))
  } catch {
    return {}
  }
}

function readEncryptedBufferAt(filePath: string): Buffer | null {
  if (!fs.existsSync(filePath)) return null
  const raw = fs.readFileSync(filePath)
  if (raw.length === 0) return null

  const asText = raw.toString('utf-8').trim()
  if (/^[A-Za-z0-9+/=]+$/.test(asText) && asText.length > 16) {
    try {
      return Buffer.from(asText, 'base64')
    } catch {
      // fall through to legacy raw buffer
    }
  }
  return raw
}

function writeEncryptedBufferAt(filePath: string, encrypted: Buffer): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, encrypted.toString('base64'), 'utf-8')
}

function providerHasSavedKey(providerId: string): boolean {
  const encrypted = readEncryptedBufferAt(apiKeyPathForProvider(providerId))
  return Boolean(encrypted && encrypted.length > 0)
}

export function listSavedProviderIds(): string[] {
  migrateLegacyApiKey()
  if (!fs.existsSync(apiKeysDir())) return []

  return fs.readdirSync(apiKeysDir())
    .filter((name) => name.endsWith('.bin'))
    .map((name) => name.slice(0, -4))
    .filter((id) => providerHasSavedKey(id))
}

export function loadApiConfig(): ApiSettings {
  migrateLegacyApiKey()
  const file = readSettingsFile()
  const endpoint = file.endpoint || DEFAULT_ENDPOINT
  const model = file.model || DEFAULT_MODEL
  const providerId = file.providerId
    || inferProviderId(endpoint, model)
  const savedProviderIds = listSavedProviderIds()
  return {
    endpoint,
    model,
    providerId,
    hasApiKey: savedProviderIds.includes(sanitizeProviderId(providerId)),
    savedProviderIds,
    encryptionAvailable: safeStorage.isEncryptionAvailable()
  }
}

export function saveApiConfig(config: {
  endpoint: string
  model: string
  providerId?: string
}): { success: boolean; error?: string } {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true })
    const endpoint = config.endpoint || DEFAULT_ENDPOINT
    const model = config.model || DEFAULT_MODEL
    const providerId = config.providerId || inferProviderId(endpoint, model) || DEFAULT_PROVIDER_ID
    fs.writeFileSync(settingsPath(), JSON.stringify({
      endpoint,
      model,
      providerId,
    }, null, 2), 'utf-8')
    return { success: true }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

export function saveApiKey(key: string, providerId: string = DEFAULT_PROVIDER_ID): { success: boolean; error?: string } {
  const trimmed = key.trim()
  const safeProviderId = sanitizeProviderId(providerId)
  if (!trimmed) {
    return clearApiKey(safeProviderId)
  }
  if (trimmed.length < 8) {
    return { success: false, error: 'API Key 长度过短，请检查是否完整' }
  }
  if (!safeStorage.isEncryptionAvailable()) {
    return { success: false, error: '系统不支持加密存储，无法安全保存 API Key' }
  }
  try {
    migrateLegacyApiKey()
    const encrypted = safeStorage.encryptString(trimmed)
    writeEncryptedBufferAt(apiKeyPathForProvider(safeProviderId), encrypted)
    return { success: true }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

export function getApiKey(providerId: string = DEFAULT_PROVIDER_ID): { success: boolean; apiKey?: string; error?: string } {
  migrateLegacyApiKey()
  const encrypted = readEncryptedBufferAt(apiKeyPathForProvider(sanitizeProviderId(providerId)))
  if (!encrypted || encrypted.length === 0) {
    return { success: true, apiKey: '' }
  }
  if (!safeStorage.isEncryptionAvailable()) {
    return { success: false, error: '系统不支持加密存储，无法读取已保存的 API Key' }
  }
  try {
    const apiKey = safeStorage.decryptString(encrypted).trim()
    if (!apiKey) {
      return { success: false, error: '已保存的 API Key 为空，请重新填写' }
    }
    return { success: true, apiKey }
  } catch (err) {
    try { clearApiKey(providerId) } catch { /* ignore */ }
    return { success: false, error: `无法解密已保存的 API Key（可能已损坏），请重新填写。${String(err)}` }
  }
}

export function clearApiKey(providerId: string = DEFAULT_PROVIDER_ID): { success: boolean; error?: string } {
  try {
    const p = apiKeyPathForProvider(sanitizeProviderId(providerId))
    if (fs.existsSync(p)) fs.unlinkSync(p)
    return { success: true }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}
