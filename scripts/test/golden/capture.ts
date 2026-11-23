/**
 * Capture the emitted resource tree for one Minecraft target.
 *
 * Text files keep their real relative path so a human can read the golden
 * directory like a project. Binary assets are recorded as hashes inside
 * index.json, because the same PNG bytes are already pinned by the voxel
 * determinism test and a binary blob in git cannot be reviewed.
 */
import { createHash } from 'node:crypto'
import { generateContent } from '../../../packages/modcrafting-core/src/content-codegen.ts'
import { buildRecipeContent, recipePath } from '../../../packages/modcrafting-core/src/recipe-format.ts'
import { deriveResourceLayout } from '../../../packages/modcrafting-core/src/resources/layout.ts'
import { getRegistry } from '../../../packages/modcrafting-core/src/version/registry.ts'
import { GOLDEN_CASES, GOLDEN_MOD_ID } from './cases.ts'

const RESOURCE_ROOT = 'src/main/resources/'

export interface CapturedText { path: string; content: string }
export interface CapturedBinary { path: string; sha256: string; size: number }
export interface CapturedTree { text: CapturedText[]; binary: CapturedBinary[] }

export const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')

const byPath = <T extends { path: string }>(left: T, right: T): number => left.path < right.path ? -1 : left.path > right.path ? 1 : 0

/** Stable fingerprint over both text and binary members. */
export function contentHash(tree: CapturedTree): string {
  const lines = [
    ...tree.text.map((file) => `${file.path}\0${sha256(file.content)}`),
    ...tree.binary.map((file) => `${file.path}\0${file.sha256}`)
  ].sort()
  return sha256(lines.join('\n'))
}

export function pathsetHash(tree: CapturedTree): string {
  return sha256([...tree.text.map((file) => file.path), ...tree.binary.map((file) => file.path)].sort().join('\n'))
}

export function captureTree(minecraft = '1.21.4'): CapturedTree {
  const text = new Map<string, string>()
  const binary = new Map<string, CapturedBinary>()
  const layout = deriveResourceLayout(minecraft, getRegistry())

  for (const entry of GOLDEN_CASES) {
    if (entry.kind === 'content') {
      let generated
      try {
        generated = generateContent(entry.value, { layout })
      } catch (error) {
        // A target that cannot produce a kind yet (tool/armor/entity on pre-1.21.2)
        // is expected to be absent from its representative, not to break the capture.
        if ((error as { code?: string }).code === 'JAVA_DIALECT_UNSUPPORTED') continue
        throw error
      }
      for (const file of generated.files) {
        if (!file.path.startsWith(RESOURCE_ROOT)) continue
        text.set(file.path.slice(RESOURCE_ROOT.length), file.content)
      }
      for (const asset of generated.assets) {
        if (!asset.path.startsWith(RESOURCE_ROOT)) continue
        const relative = asset.path.slice(RESOURCE_ROOT.length)
        binary.set(relative, { path: relative, sha256: sha256(asset.content), size: asset.content.length })
      }
      continue
    }
    const [namespace, name] = entry.recipeId.split(':')
    const path = recipePath(namespace, name, minecraft).slice(RESOURCE_ROOT.length)
    text.set(path, buildRecipeContent({ ...entry.input, mcVersion: minecraft }))
  }

  const textFiles = [...text.entries()].map(([filePath, content]) => ({ path: filePath, content })).sort(byPath)
  return { text: textFiles, binary: [...binary.values()].sort(byPath) }
}

export function captureForMod(minecraft = '1.21.4'): { tree: CapturedTree; modId: string } {
  return { tree: captureTree(minecraft), modId: GOLDEN_MOD_ID }
}
