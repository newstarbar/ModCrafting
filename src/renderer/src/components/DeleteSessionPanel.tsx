import React from 'react'

interface DeleteSessionPanelProps {
	sessionName: string
	onConfirm: () => void
	onCancel: () => void
}

const DeleteSessionPanel: React.FC<DeleteSessionPanelProps> = ({
	sessionName,
	onConfirm,
	onCancel,
}) => {
	return (
		<div className="rollback-warning-overlay">
			<div className="rollback-warning-panel">
				<div className="rollback-warning-header">
					<span className="rollback-warning-icon">⚠</span>
					<span className="rollback-warning-title">删除确认</span>
				</div>
				<div className="rollback-warning-body">
					<p className="rollback-warning-text">
						将删除该会话及全部聊天记录，此操作不可撤销。
					</p>
					<div className="rollback-warning-message-preview">
						<span className="rollback-warning-preview-label">会话名称：</span>
						<p className="rollback-warning-preview-content">{sessionName}</p>
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
						确认删除
					</button>
				</div>
			</div>
		</div>
	)
}

export default DeleteSessionPanel
