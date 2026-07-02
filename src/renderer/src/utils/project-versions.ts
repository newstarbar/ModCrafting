export interface ProjectVersions {
  minecraft: string
  loader: string
  fabricApi: string
}

export function parseGradleProperties(text: string): ProjectVersions | null {
  const props: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    props[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
  }

  const minecraft = props.minecraft_version
  const loader = props.loader_version
  const fabricApi = props.fabric_version
  if (!minecraft && !loader && !fabricApi) return null

  return {
    minecraft: minecraft || '—',
    loader: loader || '—',
    fabricApi: fabricApi || '—'
  }
}

export function formatProjectVersions(v: ProjectVersions): string {
  return `${v.minecraft} · Loader ${v.loader} · API ${v.fabricApi}`
}

export async function loadProjectVersions(projectPath: string): Promise<ProjectVersions | null> {
  const sep = projectPath.includes('\\') ? '\\' : '/'
  const filePath = `${projectPath}${sep}gradle.properties`
  try {
    const result = await window.api.readFile(filePath)
    if (!result.success || !result.content) return null
    return parseGradleProperties(result.content)
  } catch {
    return null
  }
}
