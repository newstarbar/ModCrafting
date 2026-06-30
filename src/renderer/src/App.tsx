import React, { useState, useEffect, useLayoutEffect, useCallback, useRef } from "react";
import ChatPanel from "./components/ChatPanel";
import BottomPanel, { type BottomPanelHandle } from "./components/BottomPanel";
import McRuntimePanel, { type McRuntimePanelHandle } from "./components/McRuntimePanel";
import DevLogPanel from "./components/DevLogPanel";
import SessionSidebar from "./components/SessionSidebar";
import StatusBar from "./components/StatusBar";
import ProjectHub from "./components/ProjectHub";
import NewProjectWizard from "./components/NewProjectWizard";
import OpenProjectDialog from "./components/OpenProjectDialog";
import ToolchainInitOverlay, { type ToolchainInitState } from "./components/ToolchainInitOverlay";
import { EMPTY_USAGE, type UsageStats } from "./utils/usage";

const DEFAULT_API_CONFIG = {
	endpoint: "https://api.deepseek.com/v1",
	apiKey: "",
	model: "deepseek-v4-flash"
};

interface UsageData extends UsageStats {}

type RightPanelTab = "game" | "advanced";
type ProjectDialog = "none" | "new" | "open";

interface RecentProject {
	path: string;
	name: string;
	openedAt: string;
}

interface AppState {
	projectPath: string | null;
	projectName: string;
	selectedFile: { path: string; name: string } | null;
	fileContent: string | null;
	rightPanelTab: RightPanelTab;
	chatContext: string[];
	fileTreeRefreshKey: number;
}

const MIN_OVERLAY_MS = 800;

const App: React.FC = () => {
	const [state, setState] = useState<AppState>({
		projectPath: null,
		projectName: "未打开项目",
		selectedFile: null,
		fileContent: null,
		rightPanelTab: "game",
		chatContext: [],
		fileTreeRefreshKey: 0
	});
	const [sessions, setSessions] = useState<{ id: string; name: string; messages: { role: string; content: string }[]; createdAt: number; updatedAt: number }[]>([]);
	const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
	const [fileChanges, setFileChanges] = useState<{ time: string; entry: string }[]>([]);
	const [apiConfig, setApiConfig] = useState(DEFAULT_API_CONFIG);
	const [hasSavedApiKey, setHasSavedApiKey] = useState(false);
	const [encryptionAvailable, setEncryptionAvailable] = useState(true);
	const [usage, setUsage] = useState<UsageData>(EMPTY_USAGE);
	const [isRunning, setIsRunning] = useState(false);
	const [toolchainStatus, setToolchainStatus] = useState<{ jdk: string; gradle: string; deps: string; isPackaged?: boolean }>({ jdk: "missing", gradle: "missing", deps: "missing" });
	const [toolchainProgress, setToolchainProgress] = useState("");
	const [toolchainInit, setToolchainInit] = useState<ToolchainInitState>({
		phase: "checking",
		percent: 0,
		message: "正在启动…",
		error: null,
		ready: false
	});
	const [projectPreparing, setProjectPreparing] = useState(false);
	const toolchainReady = toolchainInit.ready && !projectPreparing;
	const overlayLocked = !toolchainInit.ready || projectPreparing || toolchainInit.phase === "error";
	const [projectDialog, setProjectDialog] = useState<ProjectDialog>("none");
	const [openDialogInitialPath, setOpenDialogInitialPath] = useState<string | null>(null);
	const [recentProjects, setRecentProjects] = useState<RecentProject[]>([]);
	const bottomPanelRef = useRef<BottomPanelHandle>(null);
	const mcRuntimeRef = useRef<McRuntimePanelHandle>(null);

	const refreshRecentProjects = useCallback(async () => {
		const list = await window.api.listRecentProjects();
		setRecentProjects(list);
		return list;
	}, []);

	useEffect(() => {
		try {
			const raw = localStorage.getItem("modcrafting-sessions");
			if (raw) setSessions(JSON.parse(raw));
		} catch {
			/* ignore */
		}
	}, []);
	useEffect(() => {
		localStorage.setItem("modcrafting-sessions", JSON.stringify(sessions));
	}, [sessions]);
	useEffect(() => {
		if (!currentSessionId) {
			setFileChanges([]);
			return;
		}
		try {
			const key = `modcrafting-changelog-${currentSessionId}`;
			setFileChanges(JSON.parse(localStorage.getItem(key) || "[]"));
		} catch {
			setFileChanges([]);
		}
	}, [currentSessionId]);

	useEffect(() => {
		async function initApiConfig(): Promise<void> {
			const settings = await window.api.loadApiConfig();
			setEncryptionAvailable(settings.encryptionAvailable);

			let apiKey = "";
			if (settings.hasApiKey) {
				const keyResult = await window.api.getApiKey();
				if (keyResult.success && keyResult.apiKey?.trim()) {
					apiKey = keyResult.apiKey.trim();
					setHasSavedApiKey(true);
				} else {
					setHasSavedApiKey(false);
					if (keyResult.error) {
						console.warn("API key load failed:", keyResult.error);
						alert(`API Key 加载失败：${keyResult.error}\n请在左侧「设置」中重新保存密钥。`);
					}
				}
			}

			setApiConfig({
				endpoint: settings.endpoint,
				model: settings.model,
				apiKey
			});
		}
		initApiConfig().catch((err) => {
			console.error("initApiConfig failed:", err);
			alert("API 配置加载失败，请在设置中重新填写 API Key。");
		});
	}, []);

	const ensureApiKey = useCallback(async (): Promise<string | null> => {
		const current = apiConfig.apiKey.trim();
		if (current) return current;

		if (!hasSavedApiKey) return null;

		const keyResult = await window.api.getApiKey();
		if (keyResult.success && keyResult.apiKey?.trim()) {
			const key = keyResult.apiKey.trim();
			setApiConfig((prev) => ({ ...prev, apiKey: key }));
			setHasSavedApiKey(true);
			return key;
		}

		setHasSavedApiKey(false);
		setApiConfig((prev) => ({ ...prev, apiKey: "" }));
		if (keyResult.error) {
			alert(`API Key 读取失败：${keyResult.error}`);
		}
		return null;
	}, [apiConfig.apiKey, hasSavedApiKey]);

	const handleApiSettingsChange = useCallback(async (endpoint: string, model: string) => {
		setApiConfig((prev) => ({ ...prev, endpoint, model }));
		await window.api.saveApiConfig({ endpoint, model });
	}, []);

	const handleApiKeySave = useCallback(async (key: string) => {
		const trimmed = key.trim();
		if (!trimmed) return;

		const result = await window.api.saveApiKey(trimmed);
		if (!result.success) {
			alert(result.error || "API Key 保存失败");
			return;
		}
		setApiConfig((prev) => ({ ...prev, apiKey: trimmed }));
		setHasSavedApiKey(true);
	}, []);

	const loadProjectDir = useCallback(
		async (dir: string) => {
			const exists = await window.api.exists(dir);
			if (!exists) {
				await window.api.removeRecentProject(dir);
				await refreshRecentProjects();
				alert(`项目目录不存在或已被移动：\n${dir}\n\n已从最近项目中移除。`);
				return;
			}

			const name = dir.split(/[/\\]/).pop() || "未知项目";
			setState((prev) => ({ ...prev, projectPath: dir, projectName: name, selectedFile: null, fileContent: null, fileTreeRefreshKey: prev.fileTreeRefreshKey + 1, rightPanelTab: "game" }));
			window.api.setTitle(`ModCrafting - ${name}`);
			await window.api.saveRecentProject(dir);
			await refreshRecentProjects();
			await window.api.watchDirectory(dir);

			setProjectPreparing(true);
			try {
				const env = await window.api.ensureProjectEnvironment(dir);
				if (!env.ok && env.errors.length > 0) {
					console.warn("Project env init:", env.errors.join("; "));
				}
			} finally {
				setProjectPreparing(false);
				setToolchainProgress("");
			}
			setToolchainStatus(await window.api.getToolchainStatus());
		},
		[refreshRecentProjects]
	);

	const openProjectDialog = useCallback((initialPath?: string | null) => {
		setOpenDialogInitialPath(initialPath ?? null);
		setProjectDialog("open");
	}, []);

	const openProject = useCallback(() => {
		openProjectDialog(null);
	}, [openProjectDialog]);

	const createProject = useCallback(() => {
		setProjectDialog("new");
	}, []);

	const handleOpenProjectPath = useCallback(
		async (dir: string) => {
			const info = await window.api.detectProject(dir);
			if (!info.hasBuildGradle) return;
			await loadProjectDir(dir);
		},
		[loadProjectDir]
	);

	const handleContinueLast = useCallback(async () => {
		const last = recentProjects[0]?.path ?? (await window.api.loadRecentProject()).data;
		if (!last) return;
		if (!(await window.api.exists(last))) {
			await window.api.removeRecentProject(last);
			await refreshRecentProjects();
			alert(`上次打开的项目已不存在：\n${last}`);
			return;
		}
		const info = await window.api.detectProject(last);
		if (!info.hasBuildGradle) {
			openProjectDialog(last);
			return;
		}
		await loadProjectDir(last);
	}, [recentProjects, loadProjectDir, openProjectDialog, refreshRecentProjects]);

	const selectFile = useCallback(async (filePath: string, fileName: string) => {
		const result = await window.api.readFile(filePath);
		if (result.success) {
			setState((prev) => ({ ...prev, selectedFile: { path: filePath, name: fileName }, fileContent: result.content || null }));
		}
	}, []);

	useEffect(() => {
		const u1 = window.api.onMenuNewProject(() => createProject());
		const u2 = window.api.onMenuOpenProject(() => openProject());
		const u3 = window.api.onFileChanged(() => setState((prev) => ({ ...prev, fileTreeRefreshKey: prev.fileTreeRefreshKey + 1 })));
		const u4 = window.api.onToolBuild(() => {
			setState((p) => ({ ...p, rightPanelTab: "advanced" }));
			window.setTimeout(() => {
				void bottomPanelRef.current?.runBuild();
			}, 150);
		});
		const u5 = window.api.onToolRunClient(() => {
			setState((p) => ({ ...p, rightPanelTab: "game" }));
			window.setTimeout(() => {
				void mcRuntimeRef.current?.startDefaultForProject();
			}, 150);
		});
		const u6 = window.api.onToolStop(() => {
			setState((p) => ({ ...p, rightPanelTab: "game" }));
			window.setTimeout(() => {
				void mcRuntimeRef.current?.stopAllRunning();
			}, 150);
		});
		return () => {
			u1();
			u2();
			u3();
			u4();
			u5();
			u6();
		};
	}, [createProject, openProject]);

	useLayoutEffect(() => {
		const unsubDownload = window.api.onDownloadProgress((msg) => setToolchainProgress(msg));
		const unsubToolchain = window.api.onToolchainProgress((payload) => {
			setToolchainInit((prev) => ({
				...prev,
				phase: payload.phase === "ready" && prev.ready ? prev.phase : payload.phase,
				percent: payload.percent,
				message: payload.message,
				error: payload.phase === "error" ? payload.error || payload.message : prev.error
			}));
			setToolchainProgress(payload.message);
		});

		return () => {
			unsubDownload();
			unsubToolchain();
		};
	}, []);

	useEffect(() => {
		const startedAt = Date.now();

		async function initToolchain(): Promise<void> {
			const result = await window.api.initToolchain();
			const status = await window.api.getToolchainStatus();
			setToolchainStatus(status);
			const ready = result.ok && (await window.api.isToolchainReady());
			if (ready) {
				const waitMs = Math.max(0, MIN_OVERLAY_MS - (Date.now() - startedAt));
				if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
				setToolchainInit({
					phase: "ready",
					percent: 100,
					message: "构建环境已就绪",
					error: null,
					ready: true
				});
				setToolchainProgress("");
			} else {
				setToolchainInit((prev) => ({
					...prev,
					phase: "error",
					error: result.error || "构建环境未完全就绪，请重试",
					ready: false
				}));
			}
			await refreshRecentProjects();
		}

		initToolchain().catch((err) => {
			console.error("initToolchain failed:", err);
			setToolchainInit({
				phase: "error",
				percent: 0,
				message: "初始化异常",
				error: String(err),
				ready: false
			});
		});
	}, [refreshRecentProjects]);

	const retryToolchainInit = useCallback(() => {
		setToolchainInit({
			phase: "checking",
			percent: 0,
			message: "正在重新初始化…",
			error: null,
			ready: false
		});
		void window.api.initToolchain(true).then(async (result) => {
			const status = await window.api.getToolchainStatus();
			setToolchainStatus(status);
			const ready = result.ok && (await window.api.isToolchainReady());
			if (ready) {
				setToolchainInit({
					phase: "ready",
					percent: 100,
					message: "构建环境已就绪",
					error: null,
					ready: true
				});
				setToolchainProgress("");
			} else {
				setToolchainInit((prev) => ({
					...prev,
					phase: "error",
					error: result.error || "构建环境初始化失败",
					ready: false
				}));
			}
		});
	}, []);

	const addToChatContext = useCallback((text: string) => setState((prev) => ({ ...prev, chatContext: [...prev.chatContext, text] })), []);
	const handleCrashToChat = useCallback((c: string) => setState((prev) => ({ ...prev, chatContext: [...prev.chatContext, `--- 崩溃报告 ---\n${c}`], rightPanelTab: "game" })), []);

	const lastProjectPath = recentProjects[0]?.path ?? null;

	return (
		<>
			<div className={`app-layout${overlayLocked ? " app-layout--locked" : ""}`}>
				<SessionSidebar
					projectPath={state.projectPath}
					projectName={state.projectName}
					sessions={sessions}
					currentSessionId={currentSessionId}
					onOpenSession={(id) => setCurrentSessionId(id)}
					onNewSession={() => {
						const id = `session-${Date.now()}`;
						const now = Date.now();
						setSessions((p) => [...p, { id, name: `会话 ${p.length + 1}`, messages: [], createdAt: now, updatedAt: now }]);
						setCurrentSessionId(id);
						localStorage.setItem("modcrafting-current-session", id);
					}}
					onDeleteSession={(id) => {
						setSessions((p) => p.filter((s) => s.id !== id));
						if (currentSessionId === id) {
							setCurrentSessionId(null);
							localStorage.removeItem("modcrafting-current-session");
						}
						localStorage.removeItem(`modcrafting-changelog-${id}`);
					}}
					onRenameSession={(id, name) => setSessions((p) => p.map((s) => (s.id === id ? { ...s, name } : s)))}
					fileChanges={fileChanges}
					apiConfig={apiConfig}
					hasSavedApiKey={hasSavedApiKey}
					encryptionAvailable={encryptionAvailable}
					onApiSettingsChange={handleApiSettingsChange}
					onApiKeySave={handleApiKeySave}
					onOpenProject={openProject}
					onCreateProject={createProject}
					fileTreeRefreshKey={state.fileTreeRefreshKey}
					selectedFilePath={state.selectedFile?.path}
					selectedFile={state.selectedFile}
					fileContent={state.fileContent}
					onSelectFile={selectFile}
				/>
				<div className="main-area">
					{state.projectPath ? (
						<ChatPanel
							projectPath={state.projectPath}
							contextFiles={state.chatContext}
							setContextFiles={(f) => setState((p) => ({ ...p, chatContext: f }))}
							selectedFile={state.selectedFile}
							apiConfig={apiConfig}
							ensureApiKey={ensureApiKey}
							toolchainReady={toolchainReady}
							onUsageChange={(u) => setUsage(u)}
							onRunningChange={(r) => setIsRunning(r)}
							currentSessionId={currentSessionId}
							sessions={sessions}
							onAppendToSession={(sessionId, role, content) => {
								setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, messages: [...s.messages, { role, content }], updatedAt: Date.now() } : s)));
							}}
							onNewSession={(firstMessage) => {
								const id = `session-${Date.now()}`;
								const now = Date.now();
								const msg = firstMessage || "";
								const name = msg ? msg.slice(0, 30) + (msg.length > 30 ? "..." : "") : `会话 ${Math.floor(Math.random() * 1000)}`;
								setSessions((p) => [...p, { id, name, messages: msg ? [{ role: "user", content: msg }] : [], createdAt: now, updatedAt: now }]);
								setCurrentSessionId(id);
								localStorage.setItem("modcrafting-current-session", id);
								return id;
							}}
							onRenameSession={(id, name) => setSessions((p) => p.map((s) => (s.id === id ? { ...s, name } : s)))}
						/>
					) : (
						<ProjectHub
							recentProjects={recentProjects}
							lastProjectPath={lastProjectPath}
							onNewProject={createProject}
							onOpenProject={openProject}
							onContinueLast={() => void handleContinueLast()}
							onOpenRecent={(path) => openProjectDialog(path)}
						/>
					)}
				</div>
				<div className="right-panel">
					<div className="right-panel-tabs">
						<div className={`right-panel-tab ${state.rightPanelTab === "game" ? "active" : ""}`} onClick={() => setState((p) => ({ ...p, rightPanelTab: "game" }))}>
							🎮 游戏
						</div>
						<div className={`right-panel-tab ${state.rightPanelTab === "advanced" ? "active" : ""}`} onClick={() => setState((p) => ({ ...p, rightPanelTab: "advanced" }))}>
							⚙️ 高级
						</div>
					</div>
					<div className="right-panel-content">
						<div style={{ display: state.rightPanelTab === "game" ? "flex" : "none", height: "100%", flexDirection: "column" }}>
							<McRuntimePanel ref={mcRuntimeRef} projectPath={state.projectPath} onAddCrashToChat={handleCrashToChat} toolchainReady={toolchainReady} />
						</div>
						<div style={{ display: state.rightPanelTab === "advanced" ? "flex" : "none", height: "100%", flexDirection: "column", overflow: "hidden" }}>
							<BottomPanel ref={bottomPanelRef} projectPath={state.projectPath} onAddToChatContext={addToChatContext} toolchainReady={toolchainReady} />
							<div className="advanced-devlog-wrap">
								<DevLogPanel />
							</div>
						</div>
					</div>
				</div>
			</div>
			<NewProjectWizard open={projectDialog === "new"} onClose={() => setProjectDialog("none")} onCreated={(dir) => void loadProjectDir(dir)} />
			<OpenProjectDialog
				open={projectDialog === "open"}
				initialPath={openDialogInitialPath}
				onClose={() => {
					setProjectDialog("none");
					setOpenDialogInitialPath(null);
				}}
				onOpen={(dir) => void handleOpenProjectPath(dir)}
				onRecentChange={() => void refreshRecentProjects()}
			/>
			<ToolchainInitOverlay state={toolchainInit} projectPreparing={projectPreparing} onRetry={retryToolchainInit} />
			<StatusBar
				usage={usage}
				running={isRunning}
				modelLabel={apiConfig.model}
				toolchain={toolchainStatus}
				toolchainProgress={toolchainProgress}
				toolchainPercent={overlayLocked ? toolchainInit.percent : undefined}
			/>
		</>
	);
};

export default App;
