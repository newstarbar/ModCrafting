/** In-run project fact cache. The caller supplies the project/version
 * fingerprint so facts from another Minecraft/Yarn baseline never collide. */
export class KnowledgeFactCache {
  private readonly facts = new Map<string, string>()

  key(projectFingerprint: string, kind: string, subject: string): string {
    return `${projectFingerprint}|${kind}|${subject.trim().toLowerCase().replace(/\s+/g, ' ')}`
  }

  get(key: string): string | undefined { return this.facts.get(key) }
  has(key: string): boolean { return this.facts.has(key) }
  set(key: string, value: string): void { this.facts.set(key, value) }
  keys(): string[] { return [...this.facts.keys()] }
  clear(): void { this.facts.clear() }
}
