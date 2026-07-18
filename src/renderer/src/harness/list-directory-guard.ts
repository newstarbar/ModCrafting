/**
 * Detect when list_directory was given a file-like path so the tool can
 * return a clear error instead of a misleading "(empty directory)".
 */

/** Basename looks like a file (has an extension), e.g. BackgroundManager.java */
export function pathBasenameLooksLikeFile(relPath: string): boolean {
  const base = String(relPath || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .split('/')
    .pop() || ''
  // Require a real extension (dot not first char): Foo.java, en_us.json
  return /^[^.]+\.[a-zA-Z0-9]+$/.test(base)
}

/**
 * When list_directory returns no entries but the path exists and looks like
 * a file, explain the misuse to the agent.
 */
export function listDirectoryEmptyFileMessage(relPath: string): string {
  return (
    `Error: "${relPath}" 是文件不是目录。请用 read_file 读取，或 list_directory 其父目录。`
  )
}
