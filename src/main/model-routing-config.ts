import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { defaultRoutingConfig, normalizeRoutingConfig, type ModelRoutingConfig } from '../shared/model-routing.ts'

function configPath(): string { return path.join(app.getPath('userData'), 'model-routing-config.json') }

export function loadModelRoutingConfig(): ModelRoutingConfig {
  try {
    if (!fs.existsSync(configPath())) return defaultRoutingConfig()
    return normalizeRoutingConfig(JSON.parse(fs.readFileSync(configPath(), 'utf-8')))
  } catch { return defaultRoutingConfig() }
}

export function saveModelRoutingConfig(raw: unknown): { success: boolean; config?: ModelRoutingConfig; error?: string } {
  try {
    const config = normalizeRoutingConfig(raw)
    fs.mkdirSync(app.getPath('userData'), { recursive: true })
    fs.writeFileSync(configPath(), JSON.stringify(config, null, 2), 'utf-8')
    return { success: true, config }
  } catch (error) { return { success: false, error: String(error) } }
}
