import React, { useState, useCallback, useEffect, useRef } from "react";

interface Props {
	/** 导入成功后回调 */
	onSuccess: () => void;
	/** 关闭对话框 */
	onClose: () => void;
}

interface ImportProgress {
	phase: string;
	message: string;
	percent: number;
}

const QQ_GROUP = "203657694";
// QQ 群官方加群页面（浏览器打开）
const QQ_GROUP_URL = "https://qm.qq.com/q/jGxqZBzh9m";

// 离线环境包下载源（QQ 群 + 各类网盘，任选其一）
type DownloadSource = {
	id: string;
	name: string;
	desc: string;
	url?: string;
	pwd?: string;
};
const DOWNLOAD_SOURCES: DownloadSource[] = [
	{ id: "qq", name: "QQ 群文件", desc: "入群后从群文件下载" },
	{ id: "123pan", name: "123 云盘", url: "https://1840910710.share.123pan.cn/123pan/4VpOTd-VzbBd", pwd: "H8my", desc: "免登录直链，速度较快" },
	{ id: "baidu", name: "百度网盘", url: "https://pan.baidu.com/s/1CWTMEDhGZqwu6heixoK_PQ", pwd: "tbrs", desc: "需登录百度账号" },
	{ id: "189", name: "天翼云盘", url: "https://cloud.189.cn/t/ArIbuaFNjmEv", pwd: "3j28", desc: "电信用户首选" }
];

/**
 * 环境配置手动导入对话框。
 * 包含：QQ 群指引教程 + 拖拽 zip + 选择文件按钮 + 导入进度。
 */
const EnvImportDialog: React.FC<Props> = ({ onSuccess, onClose }) => {
	const [importing, setImporting] = useState(false);
	const [progress, setProgress] = useState<ImportProgress | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [success, setSuccess] = useState(false);
	const [dragOver, setDragOver] = useState(false);
	const [copied, setCopied] = useState(false);
	const [copiedPwd, setCopiedPwd] = useState<string | null>(null);
	const dropRef = useRef<HTMLDivElement>(null);

	// 监听导入进度
	useEffect(() => {
		const unsubscribe = window.api.onImportProgress((payload) => {
			setProgress(payload);
		});
		return unsubscribe;
	}, []);

	const handleImport = useCallback(
		async (zipPath: string) => {
			if (!zipPath || importing) return;
			setError(null);
			setSuccess(false);
			setImporting(true);
			setProgress({ phase: "starting", message: "准备导入…", percent: 0 });
			try {
				const result = await window.api.importEnvZip(zipPath);
				if (result.ok) {
					setSuccess(true);
					setProgress({ phase: "done", message: "环境导入完成", percent: 100 });
					// 延迟一下让用户看到成功状态
					setTimeout(() => onSuccess(), 800);
				} else {
					setError(result.error || "导入失败");
					setProgress(null);
				}
			} catch (err) {
				setError(String(err));
				setProgress(null);
			} finally {
				setImporting(false);
			}
		},
		[importing, onSuccess]
	);

	const handleCopyQQGroup = useCallback(async () => {
		try {
			await navigator.clipboard.writeText(QQ_GROUP);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
			// 同时在浏览器打开加群页面
			void window.api.openExternalUrl(QQ_GROUP_URL);
		} catch {
			/* ignore */
		}
	}, []);

	const handleCopyPwd = useCallback(async (pwd: string, id: string) => {
		try {
			await navigator.clipboard.writeText(pwd);
			setCopiedPwd(id);
			setTimeout(() => setCopiedPwd(null), 2000);
		} catch {
			/* ignore */
		}
	}, []);

	const handleOpenUrl = useCallback((url: string) => {
		void window.api.openExternalUrl(url);
	}, []);

	const handleSelectFile = useCallback(async () => {
		if (importing) return;
		setError(null);
		try {
			const zipPath = await window.api.selectEnvZip();
			if (zipPath) {
				await handleImport(zipPath);
			}
		} catch (err) {
			setError(String(err));
		}
	}, [importing, handleImport]);

	// 拖拽处理
	const handleDragOver = useCallback(
		(e: React.DragEvent) => {
			e.preventDefault();
			e.stopPropagation();
			if (!importing) setDragOver(true);
		},
		[importing]
	);

	const handleDragLeave = useCallback((e: React.DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		setDragOver(false);
	}, []);

	const handleDrop = useCallback(
		(e: React.DragEvent) => {
			e.preventDefault();
			e.stopPropagation();
			setDragOver(false);
			if (importing) return;
			const files = e.dataTransfer?.files;
			if (files && files.length > 0) {
			const file = files[0];
			// Electron 32+ 需使用 webUtils.getPathForFile 获取拖拽文件路径
			const filePath = window.api?.getPathForFile?.(file) ?? (file as File & { path?: string }).path;
			if (filePath) {
				if (!/\.(zip|tar\.xz|tar\.gz|tar)$/i.test(filePath)) {
					setError("请选择 .zip / .tar.xz / .tar.gz 格式的压缩包");
					return;
				}
				void handleImport(filePath);
			} else {
				setError('无法获取文件路径，请使用"选择文件"按钮');
			}
		}
		},
		[importing, handleImport]
	);

	const percent = progress?.percent ?? 0;
	const phaseLabel = progress?.phase === "preparing" ? "准备中" : progress?.phase === "extracting" ? "解压中" : progress?.phase === "verifying" ? "验证中" : progress?.phase === "done" ? "完成" : "";

	return (
		<div className="toolchain-init-overlay" role="dialog" aria-modal="true" aria-labelledby="env-import-title">
			<div className="toolchain-init-card toolchain-init-card--download" style={{ maxWidth: 480 }}>
				<div className="toolchain-init-brand">
					<div>
						<h1 id="env-import-title">手动导入环境包</h1>
						<p className="toolchain-init-subtitle">网络慢？从网盘或 QQ 群下载环境压缩包</p>
					</div>
				</div>

				{/* 指引教程 */}
				{!importing && !success && (
					<>
						<div
							style={{
								margin: "4px 0 12px",
								padding: "12px 14px",
								borderRadius: 8,
								background: "var(--bg-secondary)",
								border: "1px solid var(--border-light)"
							}}
						>
							<div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", marginBottom: 8 }}>下载环境包（任选一种）</div>
						<div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
							{DOWNLOAD_SOURCES.map((src, idx) => {
								const isQQ = src.id === "qq";
								return (
									<div
										key={src.id}
										style={{
											display: "flex",
											alignItems: "center",
											justifyContent: "space-between",
											gap: 8,
											padding: "6px 10px",
											borderRadius: 6,
											background: "var(--bg-surface)",
											border: "1px solid var(--border-color)"
										}}
									>
										<div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 6 }}>
											<span
												style={{
													flexShrink: 0,
													width: 18,
													height: 18,
													borderRadius: "50%",
													background: "var(--bg-secondary)",
													color: "var(--text-muted)",
													fontSize: 10,
													display: "inline-flex",
													alignItems: "center",
													justifyContent: "center",
													fontWeight: 600
												}}
											>
												{idx + 1}
											</span>
											<span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)", flexShrink: 0 }}>{src.name}</span>
											<span style={{ fontSize: 10, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{src.desc}</span>
										</div>
										<div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
											{isQQ ? (
												<button
													type="button"
													onClick={() => void handleCopyQQGroup()}
													style={{
														background: "none",
														border: "1px solid var(--border-color)",
														borderRadius: 4,
														padding: "2px 8px",
														fontSize: 11,
														color: copied ? "var(--success)" : "var(--accent)",
														cursor: "pointer",
														whiteSpace: "nowrap"
													}}
													title="点击复制群号并打开加群页面"
												>
													{copied ? "已复制 ✓" : "复制群号"}
												</button>
											) : (
												<>
													<button
														type="button"
														onClick={() => src.url && handleOpenUrl(src.url)}
														style={{
															background: "none",
															border: "1px solid var(--border-color)",
															borderRadius: 4,
															padding: "2px 8px",
															fontSize: 11,
															color: "var(--accent)",
															cursor: "pointer",
															whiteSpace: "nowrap"
														}}
													>
														打开
													</button>
													{src.pwd && (
														<button
															type="button"
															onClick={() => void handleCopyPwd(src.pwd, src.id)}
															title="点击复制提取码"
															style={{
																background: "none",
																border: "1px solid var(--border-color)",
																borderRadius: 4,
																padding: "2px 8px",
																fontSize: 11,
																fontFamily: "monospace",
																fontWeight: 600,
																color: copiedPwd === src.id ? "var(--success)" : "var(--text-secondary)",
																cursor: "pointer",
																whiteSpace: "nowrap"
															}}
														>
															{copiedPwd === src.id ? "已复制 ✓" : src.pwd}
														</button>
													)}
												</>
											)}
										</div>
									</div>
								);
							})}
						</div>
						{DOWNLOAD_SOURCES[0] && (
							<div style={{ marginTop: 6, fontSize: 10, color: "var(--text-muted)", lineHeight: 1.5 }}>
								QQ 群号：<span style={{ fontFamily: "monospace", color: "var(--text-secondary)" }}>{QQ_GROUP}</span>，入群后从群文件下载「ModCrafting-runtime-env.zip」
							</div>
						)}
							<div style={{ marginTop: 10, fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.8 }}>
								<div style={{ fontWeight: 600, marginBottom: 4 }}>导入步骤</div>
								<ol style={{ margin: 0, paddingLeft: 20 }}>
									<li>下载完成后，将压缩包拖拽到下方区域</li>
									<li>或点击下方区域选择文件</li>
									<li>等待解压和验证完成即可使用</li>
								</ol>
							</div>
						</div>

						{/* 拖拽区域 */}
						<div
							ref={dropRef}
							onDragOver={handleDragOver}
							onDragLeave={handleDragLeave}
							onDrop={handleDrop}
							style={{
								margin: "0 0 12px",
								padding: "24px 16px",
								borderRadius: 8,
								border: `2px dashed ${dragOver ? "var(--accent)" : "var(--border-color)"}`,
								background: dragOver ? "rgba(88, 166, 255, 0.08)" : "var(--bg-surface)",
								textAlign: "center",
								cursor: importing ? "not-allowed" : "pointer",
								transition: "border-color 0.2s, background 0.2s"
							}}
							onClick={() => void handleSelectFile()}
						>
							<div style={{ fontSize: 28, marginBottom: 8, opacity: 0.6 }}>📦</div>
							<div style={{ fontSize: 13, color: "var(--text-primary)", marginBottom: 4 }}>{dragOver ? "松开鼠标导入" : "拖拽 zip 文件到此处"}</div>
							<div style={{ fontSize: 11, color: "var(--text-muted)" }}>或点击此区域选择文件</div>
						</div>

						{error && (
							<div
								style={{
									margin: "0 0 12px",
									padding: "8px 12px",
									borderRadius: 6,
									background: "rgba(248, 81, 73, 0.1)",
									border: "1px solid rgba(248, 81, 73, 0.3)",
									fontSize: 12,
									color: "var(--error)",
									lineHeight: 1.5
								}}
							>
								{error}
							</div>
						)}

						<div style={{ display: "flex", gap: 8 }}>
							<button type="button" className="toolchain-init-confirm-btn" style={{ margin: 0, flex: 1 }} onClick={() => void handleSelectFile()}>
								选择 zip 文件
							</button>
							<button type="button" className="toolchain-init-secondary-btn" style={{ width: "auto" }} onClick={onClose}>
								返回
							</button>
						</div>
					</>
				)}

				{/* 导入进度 */}
				{importing && progress && (
					<div style={{ padding: "8px 0" }}>
						<div style={{ fontSize: 13, color: "var(--text-primary)", marginBottom: 12, fontWeight: 600 }}>
							{phaseLabel} · {progress.message}
						</div>
						<div className="toolchain-init-progress-wrap">
							<div className="toolchain-init-progress-track">
								<div className="toolchain-init-progress-fill" style={{ width: `${percent}%` }} />
							</div>
							<div className="toolchain-init-progress-meta">
								<span className="toolchain-init-progress-message">{progress.message}</span>
								<span className="toolchain-init-progress-percent">{percent}%</span>
							</div>
						</div>
						<p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 12, lineHeight: 1.5 }}>正在解压环境包（约 1-2 GB），请耐心等待。解压完成后会自动验证环境完整性。</p>
					</div>
				)}

				{/* 导入成功 */}
				{success && (
					<div style={{ padding: "16px 0", textAlign: "center" }}>
						<div style={{ fontSize: 36, marginBottom: 8 }}>✓</div>
						<div style={{ fontSize: 14, color: "var(--success)", fontWeight: 600, marginBottom: 4 }}>环境导入完成</div>
						<div style={{ fontSize: 12, color: "var(--text-muted)" }}>正在加载开发环境…</div>
					</div>
				)}
			</div>
		</div>
	);
};

export default EnvImportDialog;
