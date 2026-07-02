import React, { useState, useEffect, useCallback, useMemo } from 'react'
import {
  scaffoldProject,
  sanitizeModId,
  sanitizeJavaPackage,
  getMainClassFqn,
  type FabricVersions
} from '../project/scaffold'

interface NewProjectWizardProps {
  open: boolean
  onClose: () => void
  onCreated: (projectDir: string) => void
}

function joinPath(parent: string, child: string): string {
  const sep = parent.includes('\\') ? '\\' : '/'
  return parent.replace(/[/\\]+$/, '') + sep + child.replace(/^[/\\]+/, '')
}

function isValidModId(id: string): boolean {
  return /^[a-z0-9_-]+$/.test(id) && id.length > 0
}

function isValidGroupId(group: string): boolean {
  return /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(group)
}

function isValidJavaPackage(pkg: string): boolean {
  return /^[a-z][a-z0-9_]*$/.test(pkg)
}

const NewProjectWizard: React.FC<NewProjectWizardProps> = ({ open, onClose, onCreated }) => {
  const [step, setStep] = useState(0)
  const [versions, setVersions] = useState<FabricVersions | null>(null)
  const [creating, setCreating] = useState(false)

  const [displayName, setDisplayName] = useState('My Mod')
  const [modId, setModId] = useState('my-mod')
  const [groupId, setGroupId] = useState('com.example')
  const [javaPackage, setJavaPackage] = useState('my_mod')
  const [authors, setAuthors] = useState('ModCrafting')
  const [description, setDescription] = useState('')
  const [modVersion, setModVersion] = useState('1.0.0')

  const [parentDir, setParentDir] = useState('')
  const [folderName, setFolderName] = useState('my-mod')
  const [dirNotEmpty, setDirNotEmpty] = useState(false)
  const [confirmNonEmpty, setConfirmNonEmpty] = useState(false)

  const projectDir = parentDir ? joinPath(parentDir, folderName) : ''

  useEffect(() => {
    if (!open) return
    setStep(0)
    setDisplayName('My Mod')
    setModId('my-mod')
    setGroupId('com.example')
    setJavaPackage('my_mod')
    setAuthors('ModCrafting')
    setDescription('')
    setModVersion('1.0.0')
    setParentDir('')
    setFolderName('my-mod')
    setDirNotEmpty(false)
    setConfirmNonEmpty(false)
    void window.api.getFabricVersions().then(setVersions)
  }, [open])

  useEffect(() => {
    if (!projectDir) {
      setDirNotEmpty(false)
      return
    }
    void window.api.exists(projectDir).then(async (exists) => {
      if (!exists) {
        setDirNotEmpty(false)
        setConfirmNonEmpty(false)
        return
      }
      const entries = await window.api.listDirectory(projectDir)
      setDirNotEmpty(entries.length > 0)
      if (entries.length === 0) setConfirmNonEmpty(false)
    }).catch(() => setDirNotEmpty(false))
  }, [projectDir])

  const linkModIdFromName = useCallback((name: string) => {
    const id = sanitizeModId(name.replace(/\s+/g, '-'))
    setModId(id)
    setJavaPackage(sanitizeJavaPackage(id))
    setFolderName(id || 'my-mod')
  }, [])

  const step1Valid = useMemo(() => {
    return (
      displayName.trim().length > 0 &&
      isValidModId(modId) &&
      isValidGroupId(groupId) &&
      isValidJavaPackage(javaPackage) &&
      authors.trim().length > 0 &&
      /^\d+\.\d+\.\d+/.test(modVersion)
    )
  }, [displayName, modId, groupId, javaPackage, authors, modVersion])

  const step2Valid = useMemo(() => {
    if (!parentDir || !folderName.trim()) return false
    if (dirNotEmpty && !confirmNonEmpty) return false
    return true
  }, [parentDir, folderName, dirNotEmpty, confirmNonEmpty])

  const handlePickParent = useCallback(async () => {
    const dir = await window.api.selectNewProjectDirectory()
    if (dir) setParentDir(dir)
  }, [])

  const handleCreate = useCallback(async () => {
    if (!versions || !step1Valid || !step2Valid || !projectDir) return
    setCreating(true)
    try {
      await window.api.createDirectory(projectDir)
      const config = {
        projectDir,
        folderName: folderName.trim(),
        displayName: displayName.trim(),
        modId,
        groupId,
        javaPackage,
        authors: authors.trim(),
        description: description.trim(),
        modVersion: modVersion.trim(),
        versions
      }
      await scaffoldProject(config)
      onCreated(projectDir)
      onClose()
    } catch (err) {
      alert(`创建项目失败：${String(err)}`)
    } finally {
      setCreating(false)
    }
  }, [
    versions, step1Valid, step2Valid, projectDir, folderName, displayName,
    modId, groupId, javaPackage, authors, description, modVersion, onCreated, onClose
  ])

  if (!open) return null

  const mainClass = versions ? getMainClassFqn({
    projectDir,
    folderName,
    displayName,
    modId,
    groupId,
    javaPackage,
    authors,
    description,
    modVersion,
    versions
  }) : ''

  return (
    <div className="project-modal-overlay" onClick={onClose}>
      <div className="project-modal mc-frame" onClick={(e) => e.stopPropagation()}>
        <div className="project-modal-header">
          <h2>新建 Fabric 模组</h2>
          <button type="button" className="project-modal-close" onClick={onClose}>×</button>
        </div>
        <div className="project-modal-body">
          <div className="wizard-steps">
            <div className={`wizard-step ${step === 0 ? 'active' : 'done'}`}>1. 模组信息</div>
            <div className={`wizard-step ${step === 1 ? 'active' : ''}`}>2. 位置与版本</div>
          </div>

          {step === 0 && (
            <div className="wizard-form">
              <div className="wizard-field">
                <label>模组显示名</label>
                <input
                  value={displayName}
                  onChange={(e) => {
                    setDisplayName(e.target.value)
                    linkModIdFromName(e.target.value)
                  }}
                />
              </div>
              <div className="wizard-row">
                <div className="wizard-field">
                  <label>Mod ID</label>
                  <input
                    value={modId}
                    onChange={(e) => {
                      const v = e.target.value.toLowerCase()
                      setModId(v)
                      setJavaPackage(sanitizeJavaPackage(v))
                    }}
                  />
                  {!isValidModId(modId) && modId && (
                    <div className="error">仅允许小写字母、数字、下划线和连字符</div>
                  )}
                </div>
                <div className="wizard-field">
                  <label>初始版本</label>
                  <input value={modVersion} onChange={(e) => setModVersion(e.target.value)} />
                </div>
              </div>
              <div className="wizard-row">
                <div className="wizard-field">
                  <label>Maven Group</label>
                  <input value={groupId} onChange={(e) => setGroupId(e.target.value)} />
                  {!isValidGroupId(groupId) && groupId && (
                    <div className="error">格式如 com.example.myproject</div>
                  )}
                </div>
                <div className="wizard-field">
                  <label>Java 包名</label>
                  <input value={javaPackage} onChange={(e) => setJavaPackage(e.target.value)} />
                  {!isValidJavaPackage(javaPackage) && javaPackage && (
                    <div className="error">仅允许小写字母、数字和下划线</div>
                  )}
                </div>
              </div>
              <div className="wizard-field">
                <label>作者</label>
                <input value={authors} onChange={(e) => setAuthors(e.target.value)} />
              </div>
              <div className="wizard-field">
                <label>描述（可选）</label>
                <textarea
                  rows={2}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="模组简介…"
                />
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="wizard-form">
              <div className="wizard-field">
                <label>父目录</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input value={parentDir} readOnly placeholder="点击选择父目录…" style={{ flex: 1 }} />
                  <button type="button" className="btn" onClick={() => void handlePickParent()}>浏览…</button>
                </div>
              </div>
              <div className="wizard-field">
                <label>项目文件夹名</label>
                <input value={folderName} onChange={(e) => setFolderName(e.target.value)} />
                {projectDir && (
                  <div className="hint">完整路径：{projectDir}</div>
                )}
              </div>

              {versions && (
                <>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 8, fontWeight: 600 }}>
                    版本矩阵（固定离线版本）
                  </div>
                  <div className="version-matrix">
                    <div className="version-matrix-item">
                      <div className="label">Minecraft</div>
                      <div className="value">{versions.minecraft_version}</div>
                    </div>
                    <div className="version-matrix-item">
                      <div className="label">Fabric Loader</div>
                      <div className="value">{versions.loader_version}</div>
                    </div>
                    <div className="version-matrix-item">
                      <div className="label">Fabric API</div>
                      <div className="value">{versions.fabric_version}</div>
                    </div>
                    <div className="version-matrix-item">
                      <div className="label">Loom</div>
                      <div className="value">{versions.loom_version}</div>
                    </div>
                    <div className="version-matrix-item">
                      <div className="label">Gradle</div>
                      <div className="value">{versions.gradle_version}</div>
                    </div>
                    <div className="version-matrix-item">
                      <div className="label">Yarn</div>
                      <div className="value">{versions.yarn_mappings}</div>
                    </div>
                  </div>
                </>
              )}

              {dirNotEmpty && (
                <div className="wizard-warning">
                  目标目录不为空，继续创建可能覆盖或混入已有文件。
                  <label>
                    <input
                      type="checkbox"
                      checked={confirmNonEmpty}
                      onChange={(e) => setConfirmNonEmpty(e.target.checked)}
                    />
                    我了解风险，仍要在此目录创建
                  </label>
                </div>
              )}

              <div className="wizard-preview">
                <div>Mod ID: {modId}</div>
                <div>主类: {mainClass}</div>
                <div>路径: {projectDir || '（未选择）'}</div>
              </div>
            </div>
          )}
        </div>
        <div className="project-modal-footer">
          {step === 1 && (
            <button type="button" className="btn" onClick={() => setStep(0)}>上一步</button>
          )}
          <div style={{ flex: 1 }} />
          <button type="button" className="btn" onClick={onClose}>取消</button>
          {step === 0 ? (
            <button
              type="button"
              className="btn btn-primary"
              disabled={!step1Valid}
              onClick={() => setStep(1)}
            >
              下一步
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              disabled={!step2Valid || creating}
              onClick={() => void handleCreate()}
            >
              {creating ? '创建中…' : '创建项目'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

export default NewProjectWizard
