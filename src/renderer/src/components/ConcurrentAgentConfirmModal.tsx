import React from 'react'

interface ConcurrentAgentConfirmModalProps {
  runningSessionName: string
  onConfirm: () => void
  onCancel: () => void
}

const ConcurrentAgentConfirmModal: React.FC<ConcurrentAgentConfirmModalProps> = ({
  runningSessionName,
  onConfirm,
  onCancel
}) => {
  return (
    <div className="rollback-warning-overlay">
      <div className="rollback-warning-panel">
        <div className="rollback-warning-header">
          <span className="rollback-warning-icon">⚠</span>
          <span className="rollback-warning-title">并发执行提示</span>
        </div>
        <div className="rollback-warning-body">
          <p className="rollback-warning-text">
            检测到当前项目中已有其他会话正在执行代码修改或构建任务。同时并发修改同一个项目可能产生代码覆盖或构建冲突。
          </p>
          <div className="rollback-warning-message-preview">
            <span className="rollback-warning-preview-label">正在执行的会话：</span>
            <p className="rollback-warning-preview-content">{runningSessionName}</p>
          </div>
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
            仍要并发执行
          </button>
        </div>
      </div>
    </div>
  )
}

export default ConcurrentAgentConfirmModal
