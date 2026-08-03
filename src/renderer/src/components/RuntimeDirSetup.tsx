import React, { useEffect, useState } from 'react'

interface Props {
  /** 用户确认目录后回调，参数为最终选定的 runtime 路径 */
  onConfirm: (runtimePath: string) => void
  /** 用户跳过（使用默认 C 盘位置） */
  onSkip: () => void
}

/**
 * 首次启动引导：让用户选择数据目录位置（默认不在 C 盘）。
 * 仅在安装版 + 首次下载 + 无自定义路径配置时显示。
 */
const RuntimeDirSetup: React.FC<Props> = ({ onConfirm, onSkip }) => {
  const [suggested, setSuggested] = useState<string>('')
  const [selected, setSelected] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    void (async () => {
      try {
        const s = await window.api.appConfigSuggestRuntimePath()
        setSuggested(s)
        setSelected(s)
      } catch (err) {
        setError(String(err))
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  const handleSelect = async (): Promise<void> => {
    setError(null)
    try {
      const picked = await window.api.appConfigSelectDirectory()
      if (picked) {
        // 在用户选择的目录下追加 ModCrafting-Data/runtime 子目录，避免污染其根目录
        const target = `${picked.replace(/[\\/]+$/, '')}\\ModCrafting-Data\\runtime`
        setSelected(target)
      }
    } catch (err) {
      setError(String(err))
    }
  }

  const handleConfirm = async (): Promise<void> => {
    if (!selected) {
      setError('请先选择数据目录')
      return
    }
    setError(null)
    try {
      const result = await window.api.appConfigSetRuntimePath(selected)
      if (!result.success) {
        setError(result.error || '保存配置失败')
        return
      }
      onConfirm(selected)
    } catch (err) {
      setError(String(err))
    }
  }

  const handleSkip = (): void => {
    // 清除可能的临时配置，确保使用默认 C 盘位置
    void window.api.appConfigSetRuntimePath(null).then(() => onSkip())
  }

  const onCDrive = /^[cC]:[\\/]/.test(selected)

  return (
    <div className="toolchain-init-overlay" role="dialog" aria-modal="true" aria-labelledby="runtime-dir-title">
      <div className="toolchain-init-card toolchain-init-card--download">
        <div className="toolchain-init-brand">
          <span className="toolchain-init-logo">M</span>
          <div>
            <h1 id="runtime-dir-title">ModCrafting</h1>
            <p className="toolchain-init-subtitle">选择数据存放位置</p>
          </div>
        </div>
        <div className="toolchain-init-download-estimate">
          <p className="toolchain-init-download-intro">
            首次启动需要下载完整开发环境（JDK、Gradle、Fabric/Minecraft 依赖与游戏资源），约占用 1-2 GB 空间。
            为避免占用 C 盘，建议选择其他盘符作为数据目录。
          </p>
          <div style={{
            margin: '12px 0',
            padding: '12px 14px',
            borderRadius: 8,
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border-light)'
          }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
              数据目录位置
            </div>
            <div style={{
              fontSize: 13,
              color: 'var(--text-primary)',
              fontFamily: 'monospace',
              wordBreak: 'break-all',
              marginBottom: 8
            }}>
              {loading ? '检测可用盘符中…' : selected}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                type="button"
                className="mc-btn"
                style={{ padding: '4px 10px', fontSize: 11 }}
                onClick={() => void handleSelect()}
                disabled={loading}
              >
                浏览…
              </button>
              {!loading && suggested && selected !== suggested && (
                <button
                  type="button"
                  className="mc-btn"
                  style={{ padding: '4px 10px', fontSize: 11 }}
                  onClick={() => setSelected(suggested)}
                >
                  使用建议路径
                </button>
              )}
            </div>
            {onCDrive && (
              <div style={{ marginTop: 8, fontSize: 11, color: 'var(--warning, #f0a020)', lineHeight: 1.5 }}>
                当前路径位于 C 盘，下载的开发环境会占用系统盘空间。建议选择其他盘符。
              </div>
            )}
          </div>
          <p className="toolchain-init-download-hint">
            数据目录包含 JDK 21、Gradle 9.5、依赖缓存与游戏资源。后续可在「设置」中修改位置（会自动迁移已下载数据）。
          </p>
        </div>
        {error && (
          <div style={{
            margin: '8px 0 12px',
            padding: '8px 12px',
            borderRadius: 6,
            background: 'rgba(248, 81, 73, 0.1)',
            border: '1px solid rgba(248, 81, 73, 0.3)',
            fontSize: 12,
            color: 'var(--error)'
          }}>
            {error}
          </div>
        )}
        <button
          type="button"
          className="toolchain-init-confirm-btn"
          onClick={() => void handleConfirm()}
          disabled={loading || !selected}
        >
          确认并开始下载
        </button>
        <button
          type="button"
          className="mc-btn"
          style={{ width: '100%', padding: '8px 20px', fontSize: 12, color: 'var(--text-muted)' }}
          onClick={handleSkip}
          disabled={loading}
        >
          使用默认 C 盘位置
        </button>
      </div>
    </div>
  )
}

export default RuntimeDirSetup
