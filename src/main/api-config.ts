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

function settingsPath(userDataPath = app.getPath('userData')): string {
  return path.join(userDataPath, 'api-settings.json')
}

function legacyApiKeyPath(userDataPath = app.getPath('userData')): string {
  return path.join(userDataPath, 'api-key.bin')
}

function apiKeysDir(userDataPath = app.getPath('userData')): string {
  return path.join(userDataPath, 'api-keys')
}

function sanitizeProviderId(providerId: string): string {
  return providerId.replace(/[^a-z0-9_-]/gi, '_') || DEFAULT_PROVIDER_ID
}

function apiKeyPathForProvider(providerId: string, userDataPath = app.getPath('userData')): string {
  return path.join(apiKeysDir(userDataPath), `${sanitizeProviderId(providerId)}.bin`)
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

function readSettingsFile(userDataPath = app.getPath('userData')): { endpoint?: string; model?: string; providerId?: string } {
  try {
    const p = settingsPath(userDataPath)
    if (!fs.existsSync(p)) return {}
    return JSON.parse(fs.readFileSync(p, 'utf-8'))
  } catch {
    return {}
  }
}

export interface LoadedApiConfigWithKey {
  endpoint: string
  model: string
  providerId: string
  apiKey: string
}

/**
 * Read a provider from another ModCrafting profile without mutating it. Used by
 * explicitly-enabled Test Lab live runs: the decrypted key stays in the main
 * process and is sent only to the isolated renderer's in-memory Controller.
 */
export function loadApiConfigFromUserData(
  userDataPath: string,
  requestedProviderId?: string
): { success: boolean; config?: LoadedApiConfigWithKey; error?: string } {
  const file = readSettingsFile(userDataPath)
  const endpoint = file.endpoint || DEFAULT_ENDPOINT
  const model = file.model || DEFAULT_MODEL
  const providerId = sanitizeProviderId(
    requestedProviderId || file.providerId || inferProviderId(endpoint, model) || DEFAULT_PROVIDER_ID
  )
  const encrypted = readEncryptedBufferAt(apiKeyPathForProvider(providerId, userDataPath))
    || readEncryptedBufferAt(legacyApiKeyPath(userDataPath))
  if (!encrypted) return { success: false, error: `saved_provider_key_not_found:${providerId}` }
  if (!safeStorage.isEncryptionAvailable()) return { success: false, error: 'safe_storage_unavailable' }
  try {
    const apiKey = safeStorage.decryptString(encrypted).trim()
    if (!apiKey) return { success: false, error: `saved_provider_key_empty:${providerId}` }
    return { success: true, config: { endpoint, model, providerId, apiKey } }
  } catch {
    return { success: false, error: `saved_provider_key_decrypt_failed:${providerId}` }
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
