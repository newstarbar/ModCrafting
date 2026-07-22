#!/usr/bin/env node
/**
 * Stop Gradle daemons and sanitize gradle-home-seed before electron-builder copies it.
 * Dev mode uses the seed as GRADLE_USER_HOME, which leaves *.lock files that cause EBUSY during packaging.
 */
import { prepareGradleHomeSeedForPackaging } from './gradle-seed-utils.mjs'

try {
  const { seedDir, removed } = await prepareGradleHomeSeedForPackaging()
  console.log(`gradle-home-seed ready for packaging: ${seedDir}`)
  if (removed > 0) console.log(`Sanitized ${removed} ephemeral path(s)`)
} catch (err) {
  console.error(err?.message || err)
  process.exit(1)
}
