import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const versionsPath = path.join(__dirname, '..', 'resources', 'fabric-versions.json')

export const FABRIC_VERSIONS = JSON.parse(readFileSync(versionsPath, 'utf-8'))
