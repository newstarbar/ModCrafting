import React, { useState, useEffect, useLayoutEffect, useCallback, useRef } from "react";
import ChatPanel from "./components/ChatPanel";
import BottomPanel, { type BottomPanelHandle } from "./components/BottomPanel";
import McRuntimePanel, { type McRuntimePanelHandle } from "./components/McRuntimePanel";
import DevLogPanel from "./components/DevLogPanel";
import PreviewPanel from "./components/PreviewPanel";
import SessionSidebar from "./components/SessionSidebar";
import DeleteSessionPanel from "./components/DeleteSessionPanel";
import StatusBar from "./components/StatusBar";
import ProjectHub from "./components/ProjectHub";
import AppChrome, { type AppView } from "./components/AppChrome";
import WorkspaceEmpty from "./components/WorkspaceEmpty";
import NewProjectWizard from "./components/NewProjectWizard";
import OpenProjectDialog from "./components/OpenProjectDialog";
import ToolchainInitOverlay, { type ToolchainInitState } from "./components/ToolchainInitOverlay";
import UpdateBanner from "./components/UpdateBanner";
import { IconCode, IconGamepad, IconPanelRightClose, IconSquare } from "./components/Icon";
import PanelExpandRail from "./components/PanelExpandRail";
import PanelResizeHandle from "./components/PanelResizeHandle";
import { useWorkspaceLayout } from "./hooks/useWorkspaceLayout";
import { EMPTY_USAGE, normalizeSessionUsage, sumSessionsCost, type UsageStats } from "./utils/usage";
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
	loadSessionsWithMeta,
	saveSessions,
	saveCurrentSessionId
} from "./utils/session-storage";
import { getMostRecentSessionId, sortSessionsByUpdatedAt } from "./utils/session-sort";
import { nextDefaultSessionName, sessionTitleFromMessage } from "./utils/session-title";
import { registerPanelBridge, setLastBuildLogText } from "./utils/panel-bridge";
import type { ApiConfigState, ApiSettingsPayload } from "./types/api-config";
import { providerDisplayLabel, resolveSelection } from "../../shared/llm-providers.ts";
import type { ProviderModelSelection } from "./components/ComposerModelMenu";

const DEFAULT_API_CONFIG: ApiConfigState = {
	endpoint: "https://api.deepseek.com/v1",
	apiKey: "",
	model: "deepseek-v4-flash",
	providerId: "deepseek",
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
		rightPanelTab: "preview",
		chatContext: [],
		fileTreeRefreshKey: 0
	});
	const [sessions, setSessions] = useState<ChatSession[]>([]);
	const [pendingDeleteSessionId, setPendingDeleteSessionId] = useState<string | null>(null);
	const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
	const sessionsHydratedRef = useRef(false);
	const projectPathForSessionsRef = useRef<string | null | undefined>(undefined);
	const sessionsLoadTokenRef = useRef<symbol | null>(null);
	const hadNonEmptySessionsRef = useRef(false);
	const sessionsRef = useRef(sessions);
	const currentSessionIdRef = useRef(currentSessionId);
	sessionsRef.current = sessions;
	currentSessionIdRef.current = currentSessionId;
	const [fileChanges, setFileChanges] = useState<{ time: string; entry: string }[]>([]);
	const [apiConfig, setApiConfig] = useState(DEFAULT_API_CONFIG);
	const [hasSavedApiKey, setHasSavedApiKey] = useState(false);
	const [savedProviderIds, setSavedProviderIds] = useState<string[]>([]);
	const [encryptionAvailable, setEncryptionAvailable] = useState(true);
	const [usage, setUsage] = useState<UsageData>(EMPTY_USAGE);
	const [projectCost, setProjectCost] = useState(0);
	const projectCostRef = useRef(0);
	projectCostRef.current = projectCost;
	const [isRunning, setIsRunning] = useState(false);
	const workspaceLayout = useWorkspaceLayout();
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
		if (projectPathForSessionsRef.current === path && sessionsHydratedRef.current) return;

		let cancelled = false;
		const loadToken = Symbol('sessions-load');
		sessionsLoadTokenRef.current = loadToken;
		sessionsHydratedRef.current = false;

		const run = async () => {
			const previousPath = projectPathForSessionsRef.current;
			// Only persist previous project when we actually had hydrated data.
			if (
				previousPath !== undefined &&
				previousPath !== path &&
				sessionsRef.current.length > 0
			) {
				await saveSessions(
					previousPath,
					sessionsRef.current,
					currentSessionIdRef.current,
					{ projectCost: projectCostRef.current }
				);
			}

			projectPathForSessionsRef.current = path;
			const { sessions: loaded, currentSessionId: loadedSessionId, projectCost: loadedProjectCost } =
				await loadSessionsWithMeta(path);
			if (cancelled || sessionsLoadTokenRef.current !== loadToken) return;

			const sorted = sortSessionsByUpdatedAt(loaded);
			const validSessionId = loadedSessionId && loaded.some((s) => s.id === loadedSessionId)
				? loadedSessionId
				: getMostRecentSessionId(sorted);

			setSessions(sorted);
			setCurrentSessionId(validSessionId);
			hadNonEmptySessionsRef.current = sorted.length > 0;
			const activeSession = validSessionId ? loaded.find((s) => s.id === validSessionId) : null;
			setUsage(normalizeSessionUsage(activeSession?.usage));
			setProjectCost(Math.max(0, loadedProjectCost || sumSessionsCost(sorted)));
			sessionsHydratedRef.current = true;
		};

		void run();
		return () => {
			cancelled = true;
		};
	}, [state.projectPath]);

	useEffect(() => {
		if (!sessionsHydratedRef.current) return;
		if (projectPathForSessionsRef.current !== state.projectPath) return;
		if (sessions.length > 0) hadNonEmptySessionsRef.current = true;
		// Skip accidental empty saves right after a failed/partial hydrate.
		// Allow empty only after this project once had sessions (user deleted them all).
		if (sessions.length === 0 && !hadNonEmptySessionsRef.current) return;
		void saveSessions(state.projectPath, sessions, currentSessionId, {
			allowEmptyOverwrite: hadNonEmptySessionsRef.current && sessions.length === 0,
			projectCost: projectCostRef.current
		});
	}, [sessions, state.projectPath, currentSessionId, projectCost]);

	useEffect(() => {
		if (!sessionsHydratedRef.current) return;
		if (projectPathForSessionsRef.current !== state.projectPath) return;
		void saveCurrentSessionId(state.projectPath, currentSessionId);
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
			setSavedProviderIds(settings.savedProviderIds);

			let apiKey = "";
			if (settings.hasApiKey) {
				const keyResult = await window.api.getApiKey(settings.providerId);
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
			} else {
				setHasSavedApiKey(false);
			}

			setApiConfig({
				endpoint: settings.endpoint,
				model: settings.model,
				providerId: settings.providerId,
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

		const keyResult = await window.api.getApiKey(apiConfig.providerId);
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
	}, [apiConfig.apiKey, apiConfig.providerId, hasSavedApiKey]);

	const handleApiSettingsChange = useCallback(async (config: ApiSettingsPayload) => {
		setApiConfig((prev) => ({
			...prev,
			endpoint: config.endpoint,
			model: config.model,
			providerId: config.providerId,
		}));
		await window.api.saveApiConfig(config);

		const keyResult = await window.api.getApiKey(config.providerId);
		const apiKey = keyResult.success && keyResult.apiKey?.trim() ? keyResult.apiKey.trim() : "";
		setApiConfig((prev) => ({ ...prev, apiKey }));
		setHasSavedApiKey(Boolean(apiKey));

		const refreshed = await window.api.loadApiConfig();
		setSavedProviderIds(refreshed.savedProviderIds);
	}, []);

	const handleProviderModelChange = useCallback(
		(selection: ProviderModelSelection) => {
			const resolved = resolveSelection(selection.providerId, selection.modelId);
			void handleApiSettingsChange({
				endpoint: selection.endpoint || resolved.endpoint,
				model: resolved.modelId,
				providerId: resolved.providerId,
			});
		},
		[handleApiSettingsChange]
	);

	const openApiSettings = useCallback(() => {
		window.dispatchEvent(new CustomEvent("modcrafting:open-settings"));
	}, []);

	const handleApiKeySave = useCallback(async (key: string) => {
		const trimmed = key.trim();
		if (!trimmed) return;

		const result = await window.api.saveApiKey(trimmed, apiConfig.providerId);
		if (!result.success) {
			alert(result.error || "API Key 保存失败");
			return;
		}
		setApiConfig((prev) => ({ ...prev, apiKey: trimmed }));
		setHasSavedApiKey(true);
		const refreshed = await window.api.loadApiConfig();
		setSavedProviderIds(refreshed.savedProviderIds);
	}, [apiConfig.providerId]);

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
			setState((prev) => ({ ...prev, projectPath: dir, projectName: name, selectedFile: null, fileContent: null, fileTreeRefreshKey: prev.fileTreeRefreshKey + 1, rightPanelTab: "preview" }));
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
					phase: res.ok ? 'ready' as const : 'error' as const,
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
		setSessions((prev) => sortSessionsByUpdatedAt(
			prev.map((s) => (
				s.id === sessionId ? { ...s, messages, updatedAt: Date.now() } : s
			))
		));
	}, []);

	const handleUpdateSessionMeta = useCallback((sessionId: string, meta: { composerMode?: 'agent' | 'plan' | 'ask'; sessionGoal?: string }) => {
		setSessions((prev) => prev.map((s) => (
			s.id === sessionId ? { ...s, ...meta } : s
		)));
	}, []);

	const handleUsageChange = useCallback((nextUsage: UsageStats, meta?: { costDelta?: number }) => {
		setUsage(nextUsage);
		if (meta?.costDelta && meta.costDelta > 0) {
			setProjectCost((c) => c + meta.costDelta!);
		}
		const sid = currentSessionIdRef.current;
		if (!sid) return;
		setSessions((prev) => prev.map((s) => (
			s.id === sid ? { ...s, usage: nextUsage } : s
		)));
	}, []);

	const handleOpenSession = useCallback((id: string) => {
		setCurrentSessionId(id);
	}, []);

	const handleNewSession = useCallback(() => {
		const id = `session-${Date.now()}`;
		const now = Date.now();
		setSessions((p) => sortSessionsByUpdatedAt([...p, { id, name: nextDefaultSessionName(p.length), messages: [], createdAt: now, updatedAt: now }]));
		setCurrentSessionId(id);
	}, []);

	const handleDeleteSession = useCallback((id: string) => {
		setSessions((p) => p.filter((s) => s.id !== id));
		setCurrentSessionId((cur) => (cur === id ? null : cur));
		localStorage.removeItem(`modcrafting-changelog-${id}`);
		setPendingDeleteSessionId(null);
	}, []);

	const pendingDeleteSession = pendingDeleteSessionId
		? sessions.find((s) => s.id === pendingDeleteSessionId) ?? null
		: null;

	const handleNewSessionFromChat = useCallback((firstMessage?: string) => {
		const id = `session-${Date.now()}`;
		const now = Date.now();
		const msg = firstMessage?.trim() ?? "";
		const initialMessages: PersistedMessage[] = msg
			? [{ role: "user", content: msg, timestamp: now }]
			: [];
		setSessions((p) => {
			const sessionName = msg ? sessionTitleFromMessage(msg) : nextDefaultSessionName(p.length);
			return sortSessionsByUpdatedAt([...p, { id, name: sessionName, messages: initialMessages, createdAt: now, updatedAt: now }]);
		});
		setCurrentSessionId(id);
		return id;
	}, []);
	const addToChatContext = useCallback((text: string) => setState((prev) => ({ ...prev, chatContext: [...prev.chatContext, text] })), []);
	const handleCrashToChat = useCallback((c: string) => setState((prev) => ({ ...prev, chatContext: [...prev.chatContext, `--- 崩溃报告 ---\n${c}`], rightPanelTab: "game" })), []);
	const handleContentClick = useCallback(async (type: string, name: string, className?: string) => {
		if (!state.projectPath || !className) {
			setState((prev) => ({ ...prev, chatContext: [...prev.chatContext, `--- 代码解释 ---\n${name} (${type})\n请在下方输入框发送消息以解释此代码`] }));
			return;
		}
		try {
			const javaDir = `${state.projectPath}/src/main/java`;
			const entries = await window.api.listDirectory(javaDir);
			const findFile = async (dir: string, pkgParts: string[]): Promise<{ code: string; relPath: string } | null> => {
				const dirEntries = await window.api.listDirectory(dir);
				for (const entry of dirEntries) {
					if (entry.isDirectory) {
						const result = await findFile(entry.path, [...pkgParts, entry.name]);
						if (result) return result;
					} else if (entry.name === `${className}.java`) {
						const res = await window.api.readFile(entry.path);
						if (!res.success || !res.content) return null;
						const relPath = entry.path.replace(`${state.projectPath}/`, "").replace(/\\/g, "/");
						return { code: res.content, relPath };
					}
				}
				return null;
			};
			for (const entry of entries) {
				if (entry.isDirectory) {
					const found = await findFile(entry.path, [entry.name]);
					if (found) {
						setState((prev) => ({
							...prev,
							chatContext: [
								...prev.chatContext,
								`--- 代码解释 ---\n${name} (${type})\n文件: ${found.relPath}\n\`\`\`java\n${found.code}\n\`\`\``
							]
						}));
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
					ref={workspaceLayout.layoutRef}
					className={`app-layout workspace-view app-shell-view${overlayLocked ? " app-layout--locked" : ""}${workspaceLayout.isResizing ? " app-layout--resizing" : ""}${appView !== "workspace" ? " app-shell-view--hidden" : ""}`}
					style={workspaceLayout.layoutStyle}
				>
						<SessionSidebar
							projectPath={state.projectPath}
							projectName={state.projectName}
							sessions={sessions}
							currentSessionId={currentSessionId}
							onOpenSession={handleOpenSession}
							onNewSession={handleNewSession}
							onDeleteSession={(id) => setPendingDeleteSessionId(id)}
							onRenameSession={(id, name) => setSessions((p) => p.map((s) => (s.id === id ? { ...s, name } : s)))}
							fileChanges={fileChanges}
							apiConfig={apiConfig}
							hasSavedApiKey={hasSavedApiKey}
							savedProviderIds={savedProviderIds}
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
							panelCollapsed={workspaceLayout.leftCollapsed}
							panelDragging={workspaceLayout.isResizing}
							onTogglePanelCollapse={() => workspaceLayout.toggleLeftCollapsed()}
						/>
						<PanelResizeHandle
							side="left"
							disabled={workspaceLayout.leftCollapsed}
							onPointerDown={workspaceLayout.beginLeftResize}
						/>
						<div className="main-area">
							{workspaceLayout.leftCollapsed && (
								<PanelExpandRail
									side="left"
									onExpand={() => workspaceLayout.toggleLeftCollapsed(false)}
								/>
							)}
							{workspaceLayout.rightCollapsed && (
								<PanelExpandRail
									side="right"
									onExpand={() => workspaceLayout.toggleRightCollapsed(false)}
								/>
							)}
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
									onProviderModelChange={handleProviderModelChange}
									onOpenApiSettings={openApiSettings}
								/>
							) : (
								<WorkspaceEmpty
									onGoHub={() => setAppView("hub")}
									onOpenProject={openProject}
									onNewProject={createProject}
								/>
							)}
						</div>
						<PanelResizeHandle
							side="right"
							disabled={workspaceLayout.rightCollapsed}
							onPointerDown={workspaceLayout.beginRightResize}
						/>
						<div className={`right-panel${workspaceLayout.rightCollapsed ? " right-panel--collapsed" : ""}${workspaceLayout.isResizing ? " right-panel--dragging" : ""}`}>
							<div className="right-panel-tabs">
								<button
									type="button"
									className={`mc-tab ${state.rightPanelTab === "preview" ? "active" : ""}`}
									onClick={() => setState((p) => ({ ...p, rightPanelTab: "preview" }))}
								>
									<IconSquare size="sm" /> 预览
								</button>
								<button
									type="button"
									className={`mc-tab ${state.rightPanelTab === "game" ? "active" : ""}`}
									onClick={() => setState((p) => ({ ...p, rightPanelTab: "game" }))}
								>
									<IconGamepad size="sm" /> 游戏
								</button>
								<button
									type="button"
									className={`mc-tab ${state.rightPanelTab === "advanced" ? "active" : ""}`}
									onClick={() => setState((p) => ({ ...p, rightPanelTab: "advanced" }))}
								>
									<IconCode size="sm" /> 高级
								</button>
								<button
									type="button"
									className="right-panel-collapse-btn"
									onClick={() => workspaceLayout.toggleRightCollapsed()}
									title="收起右侧面板"
									aria-label="收起右侧面板"
								>
									<IconPanelRightClose size="sm" />
								</button>
							</div>
							<div className="right-panel-content">
								<div
									className="right-panel-body right-panel-body--preview"
									hidden={state.rightPanelTab !== "preview"}
								>
									<PreviewPanel
										projectPath={state.projectPath}
										refreshKey={state.fileTreeRefreshKey}
										onContentClick={handleContentClick}
									/>
								</div>
								<div className="right-panel-body" hidden={state.rightPanelTab !== "game"}>
									<McRuntimePanel
										ref={mcRuntimeRef}
										projectPath={state.projectPath}
										onAddCrashToChat={handleCrashToChat}
										toolchainReady={toolchainReady}
										onRuntimeStatusChange={handleRuntimeStatusChange}
									/>
								</div>
								<div
									className="right-panel-body right-panel-body--advanced"
									hidden={state.rightPanelTab !== "advanced"}
								>
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
			{pendingDeleteSession && (
				<DeleteSessionPanel
					sessionName={pendingDeleteSession.name}
					onConfirm={() => handleDeleteSession(pendingDeleteSession.id)}
					onCancel={() => setPendingDeleteSessionId(null)}
				/>
			)}
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
					projectCost={projectCost}
					running={isRunning}
					providerLabel={providerDisplayLabel(apiConfig.providerId, apiConfig.endpoint)}
					modelId={apiConfig.model}
					providerId={apiConfig.providerId}
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
