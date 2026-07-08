import React, { useState, useEffect, useLayoutEffect, useCallback, useRef } from "react";
import ChatPanel from "./components/ChatPanel";
import BottomPanel, { type BottomPanelHandle } from "./components/BottomPanel";
import McRuntimePanel, { type McRuntimePanelHandle } from "./components/McRuntimePanel";
import DevLogPanel from "./components/DevLogPanel";
import PreviewPanel from "./components/PreviewPanel";
import SessionSidebar from "./components/SessionSidebar";
import StatusBar from "./components/StatusBar";
import ProjectHub from "./components/ProjectHub";
import AppChrome, { type AppView } from "./components/AppChrome";
import WorkspaceEmpty from "./components/WorkspaceEmpty";
import NewProjectWizard from "./components/NewProjectWizard";
import OpenProjectDialog from "./components/OpenProjectDialog";
import ToolchainInitOverlay, { type ToolchainInitState } from "./components/ToolchainInitOverlay";
import UpdateBanner from "./components/UpdateBanner";
import { IconCode, IconGamepad, IconSquare } from "./components/Icon";
import { EMPTY_USAGE, normalizeSessionUsage, type UsageStats } from "./utils/usage";
import { loadProjectVersions, type ProjectVersions } from "./utils/project-versions";
import {
	pickMcRuntimeSlot,
	type BuildDevStatus,
	type GameDevStatus,
	type McRuntimeSlot,
	type PhaseDevStatus
} from "./types/dev-status";
import type { ChatSession, PersistedMessage } from "./types/chat";
import {
	loadSessions,
	saveSessions,
	loadCurrentSessionId,
	saveCurrentSessionId
} from "./utils/session-storage";
import { registerPanelBridge, setLastBuildLogText } from "./utils/panel-bridge";

const DEFAULT_API_CONFIG = {
	endpoint: "https://api.deepseek.com/v1",
	apiKey: "",
	model: "deepseek-v4-flash"
};

interface UsageData extends UsageStats {}

type RightPanelTab = "game" | "preview" | "advanced";
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
	const [sessions, setSessions] = useState<ChatSession[]>([]);
	const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
	const sessionsHydratedRef = useRef(false);
	const projectPathForSessionsRef = useRef<string | null | undefined>(undefined);
	const sessionsRef = useRef(sessions);
	const currentSessionIdRef = useRef(currentSessionId);
	sessionsRef.current = sessions;
	currentSessionIdRef.current = currentSessionId;
	const [fileChanges, setFileChanges] = useState<{ time: string; entry: string }[]>([]);
	const [apiConfig, setApiConfig] = useState(DEFAULT_API_CONFIG);
	const [hasSavedApiKey, setHasSavedApiKey] = useState(false);
	const [encryptionAvailable, setEncryptionAvailable] = useState(true);
	const [usage, setUsage] = useState<UsageData>(EMPTY_USAGE);
	const [isRunning, setIsRunning] = useState(false);
	const [projectVersions, setProjectVersions] = useState<ProjectVersions | null>(null);
	const [buildDevStatus, setBuildDevStatus] = useState<BuildDevStatus>({ running: false });
	const [gameDevStatus, setGameDevStatus] = useState<GameDevStatus>({ label: '', variant: 'idle' });
	const [phaseDevStatus, setPhaseDevStatus] = useState<PhaseDevStatus | null>(null);
	const mcRuntimeSlot: McRuntimeSlot = pickMcRuntimeSlot(buildDevStatus, gameDevStatus, phaseDevStatus);
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
	const [appEdition, setAppEdition] = useState<'dev' | 'full' | 'portable'>('dev');
	const [updateBanner, setUpdateBanner] = useState({ visible: false, message: '', percent: 0 });
	const toolchainReady = toolchainInit.ready && !projectPreparing;
	const overlayLocked = !toolchainInit.ready || projectPreparing || toolchainInit.phase === "error";
	const [projectDialog, setProjectDialog] = useState<ProjectDialog>("none");
	const [openDialogInitialPath, setOpenDialogInitialPath] = useState<string | null>(null);
	const [recentProjects, setRecentProjects] = useState<RecentProject[]>([]);
	const [appView, setAppView] = useState<AppView>("hub");
	const bottomPanelRef = useRef<BottomPanelHandle>(null);
	const mcRuntimeRef = useRef<McRuntimePanelHandle>(null);
	const chatPanelRef = useRef<{ handleTemplateSelect: (templateId: string, name: string) => void }>(null);

	const refreshRecentProjects = useCallback(async () => {
		const list = await window.api.listRecentProjects();
		setRecentProjects(list);
		return list;
	}, []);

	useEffect(() => {
		const path = state.projectPath;
		if (projectPathForSessionsRef.current === path) return;

		if (projectPathForSessionsRef.current !== undefined && sessionsHydratedRef.current) {
			saveSessions(projectPathForSessionsRef.current, sessionsRef.current);
			saveCurrentSessionId(projectPathForSessionsRef.current, currentSessionIdRef.current);
		}

		projectPathForSessionsRef.current = path;
		const loaded = loadSessions(path);
		const loadedSessionId = loadCurrentSessionId(path);
		const validSessionId = loadedSessionId && loaded.some((s) => s.id === loadedSessionId)
			? loadedSessionId
			: loaded[0]?.id ?? null;

		setSessions(loaded);
		setCurrentSessionId(validSessionId);
		const activeSession = validSessionId ? loaded.find((s) => s.id === validSessionId) : null;
		setUsage(normalizeSessionUsage(activeSession?.usage));
		sessionsHydratedRef.current = true;
	}, [state.projectPath]);

	useEffect(() => {
		if (!sessionsHydratedRef.current) return;
		saveSessions(state.projectPath, sessions);
	}, [sessions, state.projectPath]);

	useEffect(() => {
		if (!sessionsHydratedRef.current) return;
		saveCurrentSessionId(state.projectPath, currentSessionId);
	}, [currentSessionId, state.projectPath]);
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
			setAppView("workspace");
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
			void loadProjectVersions(dir).then(setProjectVersions);
			setBuildDevStatus({ running: false });
			setGameDevStatus({ label: '', variant: 'idle' });
			setPhaseDevStatus(null);
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
			setAppView("workspace");
			setState((p) => ({ ...p, rightPanelTab: "advanced" }));
			window.setTimeout(() => {
				void bottomPanelRef.current?.runBuild();
			}, 150);
		});
		const u5 = window.api.onToolRunClient(() => {
			setAppView("workspace");
			setState((p) => ({ ...p, rightPanelTab: "game" }));
			window.setTimeout(() => {
				void mcRuntimeRef.current?.startDefaultForProject();
			}, 150);
		});
		const u6 = window.api.onToolStop(() => {
			setAppView("workspace");
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

	useEffect(() => {
		registerPanelBridge({
			switchTab: (tab) => {
				setAppView("workspace");
				setState((p) => ({ ...p, rightPanelTab: tab }));
			},
			runBuild: async () => {
				const res = await bottomPanelRef.current?.runBuild() ?? { exitCode: 1, failed: true };
				setLastBuildLogText(bottomPanelRef.current?.getBuildLogText() ?? "");
				return { ok: !res.failed, exitCode: res.exitCode, failed: res.failed };
			},
			startGameAndWait: async () => {
				const res = await mcRuntimeRef.current?.startDefaultAndWait() ?? {
					instanceId: "",
					ok: false,
					error: "游戏面板未就绪"
				};
				return {
					ok: res.ok,
					instanceId: res.instanceId,
					phase: res.ok ? "playing" as const : "error" as const,
					error: res.error
				};
			}
		});
		return () => registerPanelBridge(null);
	}, []);

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
		const unsubUpdate = window.api.onUpdateStatus((payload) => {
			if (payload.phase === 'downloading') {
				setUpdateBanner({
					visible: true,
					message: `正在下载更新（${payload.source || 'mirror'}）…`,
					percent: payload.percent || 0
				});
			} else if (payload.phase === 'downloaded' || payload.phase === 'error') {
				setUpdateBanner((prev) => ({ ...prev, visible: false }));
			}
		});

		return () => {
			unsubDownload();
			unsubToolchain();
			unsubUpdate();
		};
	}, []);

	useEffect(() => {
		const startedAt = Date.now();

		async function initToolchain(): Promise<void> {
			const edition = await window.api.getEdition();
			setAppEdition(edition);
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

	const handleRuntimeStatusChange = useCallback((game: GameDevStatus, phase: PhaseDevStatus | null) => {
		setGameDevStatus((prev) => (
			prev.label === game.label && prev.variant === game.variant ? prev : game
		));
		setPhaseDevStatus((prev) => {
			const prevLabel = prev?.label ?? '';
			const nextLabel = phase?.label ?? '';
			if (prevLabel === nextLabel) return prev;
			return phase;
		});
	}, []);

	const handleBuildStatusChange = useCallback((status: BuildDevStatus) => {
		setBuildDevStatus((prev) => (
			prev.running === status.running && prev.failed === status.failed ? prev : status
		));
	}, []);

	const handlePersistSession = useCallback((sessionId: string, messages: PersistedMessage[]) => {
		setSessions((prev) => prev.map((s) => (
			s.id === sessionId ? { ...s, messages, updatedAt: Date.now() } : s
		)));
	}, []);

	const handleUpdateSessionMeta = useCallback((sessionId: string, meta: { composerMode?: 'agent' | 'plan' | 'ask'; sessionGoal?: string }) => {
		setSessions((prev) => prev.map((s) => (
			s.id === sessionId ? { ...s, ...meta, updatedAt: Date.now() } : s
		)));
	}, []);

	const handleUsageChange = useCallback((nextUsage: UsageStats) => {
		setUsage(nextUsage);
		const sid = currentSessionIdRef.current;
		if (!sid) return;
		setSessions((prev) => prev.map((s) => (
			s.id === sid ? { ...s, usage: nextUsage, updatedAt: Date.now() } : s
		)));
	}, []);

	const handleOpenSession = useCallback((id: string) => {
		setCurrentSessionId(id);
	}, []);

	const handleNewSession = useCallback(() => {
		const id = `session-${Date.now()}`;
		const now = Date.now();
		setSessions((p) => [...p, { id, name: `会话 ${p.length + 1}`, messages: [], createdAt: now, updatedAt: now }]);
		setCurrentSessionId(id);
	}, []);

	const handleDeleteSession = useCallback((id: string) => {
		setSessions((p) => p.filter((s) => s.id !== id));
		setCurrentSessionId((cur) => (cur === id ? null : cur));
		localStorage.removeItem(`modcrafting-changelog-${id}`);
	}, []);

	const handleNewSessionFromChat = useCallback((firstMessage?: string) => {
		const id = `session-${Date.now()}`;
		const now = Date.now();
		const msg = firstMessage || "";
		const name = msg ? msg.slice(0, 30) + (msg.length > 30 ? "..." : "") : `会话 ${Math.floor(Math.random() * 1000)}`;
		const initialMessages: PersistedMessage[] = msg
			? [{ role: "user", content: msg, timestamp: now }]
			: [];
		setSessions((p) => [...p, { id, name, messages: initialMessages, createdAt: now, updatedAt: now }]);
		setCurrentSessionId(id);
		return id;
	}, []);
	const addToChatContext = useCallback((text: string) => setState((prev) => ({ ...prev, chatContext: [...prev.chatContext, text] })), []);
	const handleCrashToChat = useCallback((c: string) => setState((prev) => ({ ...prev, chatContext: [...prev.chatContext, `--- 崩溃报告 ---\n${c}`], rightPanelTab: "game" })), []);
	const handleTemplateClick = useCallback((templateId: string, name: string) => {
		chatPanelRef.current?.handleTemplateSelect(templateId, name);
	}, []);
	const handleContentClick = useCallback(async (type: string, name: string, className?: string) => {
		if (!state.projectPath || !className) {
			setState((prev) => ({ ...prev, chatContext: [...prev.chatContext, `--- 代码解释 ---\n${name} (${type})\n请在下方输入框发送消息以解释此代码`] }));
			return;
		}
		try {
			const javaDir = `${state.projectPath}/src/main/java`;
			const entries = await window.api.listDirectory(javaDir);
			const findFile = async (dir: string, pkgParts: string[]): Promise<string | null> => {
				const dirEntries = await window.api.listDirectory(dir);
				for (const entry of dirEntries) {
					if (entry.isDirectory) {
						const result = await findFile(entry.path, [...pkgParts, entry.name]);
						if (result) return result;
					} else if (entry.name === `${className}.java`) {
						const res = await window.api.readFile(entry.path);
						return res.success && res.content ? res.content : null;
					}
				}
				return null;
			};
			for (const entry of entries) {
				if (entry.isDirectory) {
					const code = await findFile(entry.path, [entry.name]);
					if (code) {
						setState((prev) => ({ ...prev, chatContext: [...prev.chatContext, `--- 代码解释 ---\n${name} (${type})\n\`\`\`java\n${code}\n\`\`\``] }));
						return;
					}
				}
			}
			setState((prev) => ({ ...prev, chatContext: [...prev.chatContext, `--- 代码解释 ---\n${name} (${type})\n未找到源代码文件`] }));
		} catch {
			setState((prev) => ({ ...prev, chatContext: [...prev.chatContext, `--- 代码解释 ---\n${name} (${type})\n读取源代码失败`] }));
		}
	}, [state.projectPath]);

	const lastProjectPath = recentProjects[0]?.path ?? null;

	return (
		<>
			<AppChrome
				appView={appView}
				onViewChange={setAppView}
				projectName={state.projectName}
				projectPath={state.projectPath}
			/>
			<div className="app-shell">
				<div className={`app-shell-view app-shell-view--hub${appView !== "hub" ? " app-shell-view--hidden" : ""}`}>
					<ProjectHub
						recentProjects={recentProjects}
						lastProjectPath={lastProjectPath}
						onNewProject={createProject}
						onOpenProject={openProject}
						onContinueLast={() => void handleContinueLast()}
						onOpenRecent={(path) => openProjectDialog(path)}
					/>
				</div>
				<div
					className={`app-layout workspace-view app-shell-view${overlayLocked ? " app-layout--locked" : ""}${appView !== "workspace" ? " app-shell-view--hidden" : ""}`}
				>
						<SessionSidebar
							projectPath={state.projectPath}
							projectName={state.projectName}
							sessions={sessions}
							currentSessionId={currentSessionId}
							onOpenSession={handleOpenSession}
							onNewSession={handleNewSession}
							onDeleteSession={handleDeleteSession}
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
									ref={chatPanelRef}
									projectPath={state.projectPath}
									contextFiles={state.chatContext}
									setContextFiles={(f) => setState((p) => ({ ...p, chatContext: f }))}
									selectedFile={state.selectedFile}
									apiConfig={apiConfig}
									ensureApiKey={ensureApiKey}
									toolchainReady={toolchainReady}
									onUsageChange={handleUsageChange}
									onRunningChange={(r) => setIsRunning(r)}
									currentSessionId={currentSessionId}
									sessions={sessions}
									onPersistSession={handlePersistSession}
									onUpdateSessionMeta={handleUpdateSessionMeta}
									onNewSession={handleNewSessionFromChat}
									onRenameSession={(id, name) => setSessions((p) => p.map((s) => (s.id === id ? { ...s, name } : s)))}
								/>
							) : (
								<WorkspaceEmpty
									onGoHub={() => setAppView("hub")}
									onOpenProject={openProject}
									onNewProject={createProject}
								/>
							)}
						</div>
						<div className="right-panel">
							<div className="right-panel-tabs">
								<button
									type="button"
									className={`mc-tab ${state.rightPanelTab === "game" ? "active" : ""}`}
									onClick={() => setState((p) => ({ ...p, rightPanelTab: "game" }))}
								>
									<IconGamepad size="sm" /> 游戏
								</button>
								<button
									type="button"
									className={`mc-tab ${state.rightPanelTab === "preview" ? "active" : ""}`}
									onClick={() => setState((p) => ({ ...p, rightPanelTab: "preview" }))}
								>
									<IconSquare size="sm" /> 预览
								</button>
								<button
									type="button"
									className={`mc-tab ${state.rightPanelTab === "advanced" ? "active" : ""}`}
									onClick={() => setState((p) => ({ ...p, rightPanelTab: "advanced" }))}
								>
									<IconCode size="sm" /> 高级
								</button>
							</div>
							<div className="right-panel-content">
								<div className="right-panel-body" style={{ display: state.rightPanelTab === "game" ? "block" : "none" }}>
									<McRuntimePanel
										ref={mcRuntimeRef}
										projectPath={state.projectPath}
										onAddCrashToChat={handleCrashToChat}
										toolchainReady={toolchainReady}
										onRuntimeStatusChange={handleRuntimeStatusChange}
									/>
								</div>
								<div className="right-panel-body" style={{ display: state.rightPanelTab === "preview" ? "block" : "none", overflow: "auto" }}>
									<PreviewPanel projectPath={state.projectPath} onTemplateClick={handleTemplateClick} onContentClick={handleContentClick} />
								</div>
								<div className="right-panel-body" style={{ display: state.rightPanelTab === "advanced" ? "flex" : "none", flexDirection: "column", height: "100%", overflow: "hidden" }}>
									<BottomPanel
										ref={bottomPanelRef}
										projectPath={state.projectPath}
										onAddToChatContext={addToChatContext}
										toolchainReady={toolchainReady}
										onBuildStatusChange={handleBuildStatusChange}
									/>
									<div className="advanced-devlog-wrap">
										<DevLogPanel />
									</div>
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
			<ToolchainInitOverlay state={toolchainInit} projectPreparing={projectPreparing} edition={appEdition} onRetry={retryToolchainInit} />
			<UpdateBanner visible={updateBanner.visible} message={updateBanner.message} percent={updateBanner.percent} />
			{appView === "workspace" && (
				<StatusBar
					usage={usage}
					running={isRunning}
					modelLabel={apiConfig.model}
					toolchain={toolchainStatus}
					toolchainProgress={toolchainProgress}
					toolchainPercent={overlayLocked ? toolchainInit.percent : undefined}
					projectVersions={projectVersions}
					mcRuntime={mcRuntimeSlot}
				/>
			)}
		</>
	);
};

export default App;
