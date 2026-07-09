import type { ProjectCreateConfig } from './scaffold.ts'
import { mainClassName } from './scaffold.ts'
import {
  mergeLangEntries,
  patchClientInitializer,
  patchMainInitializer,
  runTemplateCodegen,
  type TemplateCodegenParams
} from './template-codegen.ts'

export interface TemplateGenerateInput {
  projectPath: string
  templateId: string
  name: string
  displayName?: string
  formFields?: Record<string, unknown>
  config: ProjectCreateConfig
}

export interface TemplateGenerateOutput {
  ok: boolean
  message: string
  createdFiles: string[]
}

export async function resolveProjectConfig(projectPath: string): Promise<ProjectCreateConfig | null> {
  let modId = ''
  let groupId = ''
  let javaPackage = ''
  let mcVersion = '1.21.4'

  try {
    const jsonRes = await window.api.readFile(`${projectPath}/src/main/resources/fabric.mod.json`)
    if (jsonRes.success && jsonRes.content) {
      const json = JSON.parse(jsonRes.content) as { id?: string; depends?: { minecraft?: string } }
      modId = json.id || ''
      const mcDep = json.depends?.minecraft
      if (typeof mcDep === 'string') {
        const m = mcDep.match(/([\d.]+)/)
        if (m) mcVersion = m[1]
      }
    }
    const propsRes = await window.api.readFile(`${projectPath}/gradle.properties`)
    if (propsRes.success && propsRes.content) {
      const lines = propsRes.content.split('\n')
      const groupLine = lines.find((l: string) => l.startsWith('maven_group='))
      if (groupLine) groupId = groupLine.split('=')[1]?.trim() || ''
      const mcLine = lines.find((l: string) => l.startsWith('minecraft_version='))
      if (mcLine) mcVersion = mcLine.split('=')[1]?.trim() || mcVersion
    }
    const javaFiles = await window.api.listDirectory(`${projectPath}/src/main/java`)
    for (const file of javaFiles) {
      if (!file.isDirectory) continue
      const pkgParts: string[] = []
      let current = `${projectPath}/src/main/java/${file.name}`
      pkgParts.push(file.name)
      let entries = await window.api.listDirectory(current)
      while (entries.length === 1 && entries[0].isDirectory) {
        pkgParts.push(entries[0].name)
        current = `${current}/${entries[0].name}`
        entries = await window.api.listDirectory(current)
      }
      javaPackage = pkgParts.join('.')
      break
    }
  } catch {
    return null
  }

  if (!modId || !groupId || !javaPackage) return null

  return {
    projectDir: projectPath,
    folderName: '',
    displayName: '',
    modId,
    groupId,
    javaPackage,
    authors: '',
    description: '',
    modVersion: '',
    versions: {
      minecraft_version: mcVersion,
      loader_version: '0.16.10',
      fabric_version: '',
      yarn_mappings: '',
      loom_version: '',
      gradle_version: ''
    }
  }
}

async function readProjectFile(projectPath: string, rel: string): Promise<string | null> {
  const res = await window.api.readFile(`${projectPath}/${rel}`)
  return res.success && res.content != null ? res.content : null
}

async function writeProjectFile(projectPath: string, rel: string, content: string): Promise<string | null> {
  const res = await window.api.writeFile(`${projectPath}/${rel}`, content)
  return res.success ? null : (res.error || `failed to write ${rel}`)
}

export async function executeTemplateGenerate(input: TemplateGenerateInput): Promise<TemplateGenerateOutput> {
  const { projectPath, templateId, name, displayName, formFields, config } = input
  if (templateId === 'custom-recipe') {
    return { ok: false, message: 'custom-recipe 请使用 create_recipe / fabric_recipe_generate', createdFiles: [] }
  }

  const params: TemplateCodegenParams & { templateId: string } = {
    templateId,
    config,
    name,
    displayName,
    formFields,
    mcVersion: config.versions.minecraft_version || '1.21.4'
  }

  const result = runTemplateCodegen(params)
  if (!result.files.length) {
    return { ok: false, message: `不支持的模板: ${templateId}`, createdFiles: [] }
  }

  const createdFiles: string[] = []
  const errors: string[] = []

  for (const file of result.files) {
    let content = file.content
    if (file.path.endsWith('/lang/zh_cn.json')) {
      const existing = await readProjectFile(projectPath, file.path)
      try {
        const newEntries = JSON.parse(file.content) as Record<string, string>
        content = mergeLangEntries(existing, newEntries)
      } catch {
        content = file.content
      }
    }
    const err = await writeProjectFile(projectPath, file.path, content)
    if (err) errors.push(err)
    else createdFiles.push(file.path)
  }

  const mainCn = mainClassName(config.javaPackage)
  const mainRel = `src/main/java/${config.groupId.replace(/\./g, '/')}/${config.javaPackage}/${mainCn}.java`
  const mainContent = await readProjectFile(projectPath, mainRel)
  if (mainContent && result.mainInitCalls.length) {
    const patched = patchMainInitializer(mainContent, mainCn, result.mainInitCalls)
    if (patched !== mainContent) {
      const err = await writeProjectFile(projectPath, mainRel, patched)
      if (!err) createdFiles.push(mainRel)
      else errors.push(err)
    }
  }

  if (templateId === 'custom-entity') {
    const clientRel = `src/client/java/${config.groupId.replace(/\./g, '/')}/${config.javaPackage}/${mainCn}Client.java`
    const clientContent = await readProjectFile(projectPath, clientRel)
    if (clientContent) {
      const patched = patchClientInitializer(clientContent, mainCn)
      if (patched !== clientContent) {
        const err = await writeProjectFile(projectPath, clientRel, patched)
        if (!err) createdFiles.push(clientRel)
        else errors.push(err)
      }
    }
  }

  if (errors.length) {
    return {
      ok: false,
      message: `部分文件写入失败:\n${errors.join('\n')}`,
      createdFiles
    }
  }

  const label = displayName ? `（${displayName}）` : ''
  return {
    ok: true,
    message: `已生成模板 ${templateId}${label}：\n${createdFiles.map((f) => `- ${f}`).join('\n')}`,
    createdFiles
  }
}
