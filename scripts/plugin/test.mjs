import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
// Protocol/isolation is plugin:smoke; this command runs focused Core correctness regressions.
const result = spawnSync(process.execPath, ['--experimental-strip-types', '--test', '--test-concurrency=1', 'scripts/test/harness-modcrafting-plugin-core.test.ts', 'scripts/test/harness-plugin-game-test.test.ts', 'scripts/test/harness-fabric-bench.test.ts', 'scripts/test/harness-plugin-runtime.test.ts', 'scripts/test/harness-fabric-bench-live.test.ts', 'scripts/test/harness-browser-view.test.ts', 'scripts/test/harness-recipe-workspace.test.ts', 'scripts/test/harness-content-workspace.test.ts', 'scripts/test/harness-visual-assets.test.ts', 'scripts/test/harness-gui-workspace.test.ts', 'scripts/test/harness-voxel-model.test.ts', 'scripts/test/harness-building-studio.test.ts', 'scripts/test/harness-texture-core.test.ts', 'scripts/test/harness-pixel-editor.test.ts', 'scripts/test/harness-texture-workspace.test.ts', 'scripts/test/harness-host-distribution.test.ts', 'scripts/test/harness-plugin-experience.test.ts', 'scripts/test/harness-qoder-plugin.test.ts'], { cwd: root, encoding: 'utf8', timeout: 120000, windowsHide: true })
process.stdout.write(result.stdout || '')
process.stderr.write(result.stderr || '')
if (result.error) console.error('Plugin tests did not complete within 120 seconds')
process.exit(result.status ?? 1)
