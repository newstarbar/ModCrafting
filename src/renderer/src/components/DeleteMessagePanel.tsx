import React from 'react'

interface DeleteMessagePanelProps {
	role: 'user' | 'assistant'
	preview: string
	onConfirm: () => void
	onCancel: () => void
}

const DeleteMessagePanel: React.FC<DeleteMessagePanelProps> = ({
	role,
	preview,
	onConfirm,
	onCancel,
}) => {
	const isUser = role === 'user'

	return (
		<div className="rollback-warning-overlay">
			<div className="rollback-warning-panel">
				<div className="rollback-warning-header">
					<span className="rollback-warning-icon">⚠</span>
					<span className="rollback-warning-title">删除确认</span>
				</div>
				<div className="rollback-warning-body">
					<p className="rollback-warning-text">
						{isUser
							? '将删除该轮对话（含 AI 回复），此操作不可撤销。'
							: '将删除该条 AI 回复，此操作不可撤销。'}
					</p>
					<div className="rollback-warning-message-preview">
						<span className="rollback-warning-preview-label">消息内容：</span>
						<p className="rollback-warning-preview-content">{preview}</p>
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

export default DeleteMessagePanel
