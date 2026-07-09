import React from 'react'

interface RollbackWarningPanelProps {
  messageContent: string
  fileCount: number
  onConfirm: () => void
  onCancel: () => void
}

const RollbackWarningPanel: React.FC<RollbackWarningPanelProps> = ({
  messageContent,
  fileCount,
  onConfirm,
  onCancel
}) => {
  return (
    <div className="rollback-warning-overlay">
      <div className="rollback-warning-panel">
        <div className="rollback-warning-header">
          <span className="rollback-warning-icon">⚠</span>
          <span className="rollback-warning-title">回滚确认</span>
        </div>
        <div className="rollback-warning-body">
          <p className="rollback-warning-text">
            确定要回滚到该消息吗？
          </p>
          <div className="rollback-warning-details">
            {fileCount > 0 && (
              <div className="rollback-warning-detail-item">
                <span className="rollback-warning-detail-label">文件变更：</span>
                <span className="rollback-warning-detail-value">将恢复 {fileCount} 个文件</span>
              </div>
            )}
            <div className="rollback-warning-detail-item">
              <span className="rollback-warning-detail-label">后续对话：</span>
              <span className="rollback-warning-detail-value">将被删除</span>
            </div>
          </div>
          <div className="rollback-warning-message-preview">
            <span className="rollback-warning-preview-label">消息内容：</span>
            <p className="rollback-warning-preview-content">{messageContent}</p>
          </div>
          <p className="rollback-warning-hint">
            确认后，该消息将被返回到输入框中。
          </p>
        </div>
        <div className="rollback-warning-footer">
          <button
            type="button"
            className="rollback-warning-btn rollback-warning-btn--cancel"
            onClick={onCancel}
          >
            取消
          </button>
          <button
            type="button"
            className="rollback-warning-btn rollback-warning-btn--confirm"
            onClick={onConfirm}
          >
            确认回滚
          </button>
        </div>
      </div>
    </div>
  )
}

export default RollbackWarningPanel
