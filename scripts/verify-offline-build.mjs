/**
 * Verifies offline Gradle build using bundled gradle-home-seed.
 * Run: node scripts/verify-offline-build.mjs
 */
import { runOfflineBuildVerification } from './gradle-seed-utils.mjs'

const result = await runOfflineBuildVerification()

console.log('\n---')
console.log('Exit code:', result.exitCode)
if (!result.ok) {
  if (result.offlineIssue) {
    console.log('Offline resolution or cache issue detected in output')
  }
  if (result.output && !result.offlineIssue) {
    console.log(result.output)
  }
}

process.exit(result.ok ? 0 : 1)
