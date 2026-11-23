/**
 * Redistribution policy for third-party bytes.
 *
 * This is deliberately separate from "can I install it?". A pack may reference
 * any file the player can download; what this decides is whether the file's
 * bytes may be inlined into an exported pack. Unknown licences answer `false`:
 * a wrong `true` here is the one mistake that cannot be undone after publishing.
 */

import type { PackLicense } from '../workspace-model.ts'

const EXACT = new Set([
  'MIT', 'ISC', 'UNLICENSE', 'ZLIB', 'CC0-1.0', 'BSL-1.0', 'OFL-1.1',
  'APACHE-2.0', 'MPL-2.0', 'EPL-2.0'
])

const PREFIXES = [
  'MIT-', 'APACHE-', 'BSD-', 'MPL-', 'LGPL-', 'GPL-', 'AGPL-', 'EPL-',
  'CC0-', 'CC-BY-', 'BSL-', 'OFL-'
]

const RESERVED = new Set([
  '', 'UNKNOWN', 'ALL-RIGHTS-RESERVED', 'ARR', 'CUSTOM', 'CUSTOM-EULA',
  'PROPRIETARY', 'NONE'
])

export function normalizeLicenseId(id: string): string {
  return id.trim().replace(/\s+/g, ' ')
}

/**
 * Whether an unmodified file under this licence may be redistributed in a pack.
 * Copyleft licences qualify: they constrain the *combined work*, not the act of
 * shipping the original jar alongside other mods.
 */
export function isRedistributableLicense(id: string): boolean {
  const normalized = normalizeLicenseId(id)
  if (!normalized) return false
  const upper = normalized.toUpperCase()
  if (RESERVED.has(upper)) return false
  if (EXACT.has(upper)) return true
  return PREFIXES.some((prefix) => upper.startsWith(prefix))
}

/**
 * Whether the licence permits *changing* the work, which is stricter than
 * redistribution for ND variants: CC-BY-ND may be shipped unmodified but not
 * patched. Unknown and reserved licences answer `false` for the same reason the
 * redistribution check does.
 */
export function isModificationAllowedLicense(id: string): boolean {
  const normalized = normalizeLicenseId(id)
  if (!normalized) return false
  const upper = normalized.toUpperCase()
  if (upper.includes('-ND-') || upper.endsWith('-ND')) return false
  return isRedistributableLicense(normalized)
}

export function licenseFor(id: string): PackLicense {
  const normalized = normalizeLicenseId(id)
  if (!normalized) return { id: 'Unknown', redistributable: false }
  return { id: normalized, redistributable: isRedistributableLicense(normalized) }
}

/** The CurseForge API does not expose an SPDX id; only the author's distribution flag. */
export function curseforgeLicense(allowed: unknown): PackLicense {
  return allowed === true
    ? { id: 'CurseForge-Author-Allowed', redistributable: true }
    : { id: 'All-Rights-Reserved', redistributable: false }
}
