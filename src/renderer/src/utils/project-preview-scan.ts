export interface ModContent {
	type: 'block' | 'item' | 'entity' | 'recipe'
	id: string
	source: 'java' | 'json'
	className?: string
	path?: string
}

export interface ProjectPreviewData {
	modJson: Record<string, unknown> | null
	gradleProps: Record<string, string>
	content: ModContent[]
}

/** Resolve Gradle ${...} placeholders using gradle.properties (and common aliases). */
export function resolveGradlePlaceholders(text: string, props: Record<string, string>): string {
	return text.replace(/\$\{([^}]+)\}/g, (_, rawKey: string) => {
		const key = rawKey.trim()
		if (props[key] !== undefined) return props[key]
		if (key === 'version' && props.mod_version !== undefined) return props.mod_version
		if (key === 'project.version' && props.mod_version !== undefined) return props.mod_version
		return `\${${key}}`
	})
}

function parseGradleProperties(content: string): Record<string, string> {
	const props: Record<string, string> = {}
	for (const line of content.split('\n')) {
		const trimmed = line.trim()
		if (!trimmed || trimmed.startsWith('#')) continue
		const eq = trimmed.indexOf('=')
		if (eq <= 0) continue
		props[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
	}
	return props
}

function contentKey(item: ModContent): string {
	return `${item.type}:${item.id}`
}

function addContent(map: Map<string, ModContent>, item: ModContent): void {
	const key = contentKey(item)
	if (!map.has(key)) map.set(key, item)
}

function inferTypeFromJava(code: string, fileName: string): ModContent['type'] | null {
	if (/extends\s+Block\b/.test(code) && !/extends\s+BlockItem\b/.test(code)) {
		return 'block'
	}
	if (/extends\s+BlockItem\b/.test(code) || (/extends\s+Item\b/.test(code) && !/extends\s+BlockItem\b/.test(code))) {
		return 'item'
	}
	if (/extends\s+(?:MobEntity|HostileEntity|PassiveEntity|AnimalEntity|Entity)\b/.test(code)) {
		return 'entity'
	}
	if (fileName.endsWith('Block.java')) return 'block'
	if (fileName.endsWith('Item.java')) return 'item'
	if (fileName.endsWith('Entity.java')) return 'entity'
	return null
}

function idFromJsonName(fileName: string): string {
	return fileName.replace(/\.json$/i, '')
}

function inferTypeFromResourcePath(filePath: string): ModContent['type'] | null {
	const normalized = filePath.replace(/\\/g, '/').toLowerCase()
	if (/\/recipes\/[^/]+\.json$/.test(normalized)) return 'recipe'
	if (/\/models\/block\/[^/]+\.json$/.test(normalized)) return 'block'
	if (/\/models\/item\/[^/]+\.json$/.test(normalized)) return 'item'
	if (/\/entity_types?\/[^/]+\.json$/.test(normalized)) return 'entity'
	return null
}

async function walkDirectory(
	rootDir: string,
	onEntry: (entry: { name: string; path: string; isDirectory: boolean }) => void | Promise<void>,
): Promise<void> {
	let entries: Array<{ name: string; path: string; isDirectory: boolean }>
	try {
		entries = await window.api.listDirectory(rootDir)
	} catch {
		return
	}
	for (const entry of entries) {
		await onEntry(entry)
		if (entry.isDirectory) {
			await walkDirectory(entry.path, onEntry)
		}
	}
}

export async function scanProjectPreview(projectPath: string): Promise<ProjectPreviewData> {
	const contentMap = new Map<string, ModContent>()
	let modJson: Record<string, unknown> | null = null
	let gradleProps: Record<string, string> = {}

	const jsonRes = await window.api.readFile(`${projectPath}/src/main/resources/fabric.mod.json`)
	if (jsonRes.success && jsonRes.content) {
		try {
			modJson = JSON.parse(jsonRes.content) as Record<string, unknown>
		} catch {
			modJson = null
		}
	}

	const propsRes = await window.api.readFile(`${projectPath}/gradle.properties`)
	if (propsRes.success && propsRes.content) {
		gradleProps = parseGradleProperties(propsRes.content)
	}

	const javaDir = `${projectPath}/src/main/java`
	await walkDirectory(javaDir, async (entry) => {
		if (entry.isDirectory || !entry.name.endsWith('.java')) return
		const res = await window.api.readFile(entry.path)
		if (!res.success || !res.content) return
		const type = inferTypeFromJava(res.content, entry.name)
		if (!type) return
		const className = entry.name.replace(/\.java$/, '')
		const id = className
			.replace(/Block$/, '')
			.replace(/Item$/, '')
			.replace(/Entity$/, '')
			.replace(/([a-z])([A-Z])/g, '$1_$2')
			.toLowerCase()
		addContent(contentMap, { type, id: id || className.toLowerCase(), source: 'java', className, path: entry.path })
	})

	const resourcesRoot = `${projectPath}/src/main/resources`
	await walkDirectory(resourcesRoot, async (entry) => {
		if (entry.isDirectory) return
		if (!entry.name.endsWith('.json')) return
		const type = inferTypeFromResourcePath(entry.path)
		if (!type) return
		addContent(contentMap, {
			type,
			id: idFromJsonName(entry.name),
			source: 'json',
			path: entry.path,
		})
	})

	return {
		modJson,
		gradleProps,
		content: [...contentMap.values()].sort((a, b) => {
			if (a.type !== b.type) return a.type.localeCompare(b.type)
			return a.id.localeCompare(b.id)
		}),
	}
}

export function displayModField(value: unknown, gradleProps: Record<string, string>): string {
	if (value === undefined || value === null || value === '') return '-'
	if (typeof value === 'string') return resolveGradlePlaceholders(value, gradleProps)
	if (Array.isArray(value)) return value.map((v) => displayModField(v, gradleProps)).join(', ')
	return String(value)
}
