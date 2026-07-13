/** Per-agent-run tracking of files that have been read (ACI read-before-edit). */

export class FileSession {
  private readPaths = new Set<string>()

  static normalize(relPath: string): string {
    return relPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
  }

  markRead(relPath: string): void {
    this.readPaths.add(FileSession.normalize(relPath))
  }

  hasRead(relPath: string): boolean {
    return this.readPaths.has(FileSession.normalize(relPath))
  }

  clear(): void {
    this.readPaths.clear()
  }
}
