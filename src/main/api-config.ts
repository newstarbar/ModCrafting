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
  encryptionAvailable: boolean
}

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'api-settings.json')
}

function apiKeyPath(): string {
  return path.join(app.getPath('userData'), 'api-key.bin')
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

function readEncryptedBuffer(): Buffer | null {
  const p = apiKeyPath()
  if (!fs.existsSync(p)) return null
  const raw = fs.readFileSync(p)
  if (raw.length === 0) return null

  // New format: base64 text file
  const asText = raw.toString('utf-8').trim()
  if (/^[A-Za-z0-9+/=]+$/.test(asText) && asText.length > 16) {
    try {
      return Buffer.from(asText, 'base64')
    } catch {
      // fall through to legacy raw buffer
    }
  }
  // Legacy format: raw encrypted bytes
  return raw
}

function writeEncryptedBuffer(encrypted: Buffer): void {
  fs.mkdirSync(app.getPath('userData'), { recursive: true })
  fs.writeFileSync(apiKeyPath(), encrypted.toString('base64'), 'utf-8')
}

export function loadApiConfig(): ApiSettings {
  const file = readSettingsFile()
  const endpoint = file.endpoint || DEFAULT_ENDPOINT
  const model = file.model || DEFAULT_MODEL
  const providerId = file.providerId
    || inferProviderId(endpoint, model)
  return {
    endpoint,
    model,
    providerId,
    hasApiKey: fs.existsSync(apiKeyPath()) && (readEncryptedBuffer()?.length ?? 0) > 0,
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

export function saveApiKey(key: string): { success: boolean; error?: string } {
  const trimmed = key.trim()
  if (!trimmed) {
    return clearApiKey()
  }
  if (trimmed.length < 8) {
    return { success: false, error: 'API Key 长度过短，请检查是否完整' }
  }
  if (!safeStorage.isEncryptionAvailable()) {
    return { success: false, error: '系统不支持加密存储，无法安全保存 API Key' }
  }
  try {
    const encrypted = safeStorage.encryptString(trimmed)
    writeEncryptedBuffer(encrypted)
    return { success: true }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

export function getApiKey(): { success: boolean; apiKey?: string; error?: string } {
  const encrypted = readEncryptedBuffer()
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
    // Corrupt file — remove so user can re-enter
    try { clearApiKey() } catch { /* ignore */ }
    return { success: false, error: `无法解密已保存的 API Key（可能已损坏），请重新填写。${String(err)}` }
  }
}

export function clearApiKey(): { success: boolean; error?: string } {
  try {
    const p = apiKeyPath()
    if (fs.existsSync(p)) fs.unlinkSync(p)
    return { success: true }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}
