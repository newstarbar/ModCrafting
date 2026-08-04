#!/usr/bin/env node
/**
 * 把当前 runtime 目录打包为 zip 压缩包，用于离线分发环境配置。
 *
 * 打包前会校验环境完整性（JDK / Gradle / Fabric 依赖 / 知识库），
 * 校验失败则中止打包，避免分发不完整的环境包。
 *
 * 用法：
 *   node scripts/toolchain/export-runtime-zip.mjs [输出路径]
 *
 * 默认输出到桌面 ModCrafting-runtime-env.zip。
 * 依赖 Windows 10+ 自带的 tar.exe（支持 zip 格式）。
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawn, spawnSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..", "..");

const GRADLE_VERSION = "9.5.0";
const GRADLE_RUNTIME_FOLDER = "gradle-9.5";
const GRADLE_LAUNCHER_JAR = `gradle-launcher-${GRADLE_VERSION}.jar`;
const SEED_MARKER = ".modcrafting-seed.json";

const REQUIRED_FABRIC_API_MODULES = [
	"fabric-api",
	"fabric-api-lookup-api-v1",
	"fabric-blockrenderlayer-v1",
	"fabric-client-tags-api-v1",
	"fabric-content-registries-v0",
	"fabric-data-generation-api-v1",
	"fabric-convention-tags-v1",
	"fabric-convention-tags-v2",
	"fabric-data-attachment-api-v1",
	"fabric-events-interaction-v0",
	"fabric-lifecycle-events-v1",
	"fabric-model-loading-api-v1",
	"fabric-screen-handler-api-v1",
	"fabric-networking-api-v1",
	"fabric-object-builder-api-v1",
	"fabric-rendering-fluids-v1",
	"fabric-rendering-data-attachment-v1",
	"fabric-block-view-api-v2",
	"fabric-client-gametest-api-v1",
	"fabric-crash-report-info-v1",
	"fabric-key-binding-api-v1",
	"fabric-resource-conditions-api-v1",
	"fabric-resource-loader-v0",
	"fabric-transitive-access-wideners-v1"
];

const REQUIRED_KNOWLEDGE_DIRS = ["minecraft-data", "mc-wiki-zh", "mc-wiki-zh-index", "mc-wiki-model", "agent-knowledge", "fabric-symbol-index", "_base_mods"];

// runtime 目录位置：项目根目录下的 runtime/（dev 模式）
// 或 %LOCALAPPDATA%\ModCrafting\runtime\（安装版）
function resolveRuntimeRoot() {
	const devRuntime = path.join(projectRoot, "runtime");
	if (fs.existsSync(devRuntime)) return devRuntime;
	const localAppData = process.env.LOCALAPPDATA;
	if (localAppData) {
		const installed = path.join(localAppData, "ModCrafting", "runtime");
		if (fs.existsSync(installed)) return installed;
	}
	return null;
}

function loadFabricVersions() {
	const fallback = {
		minecraft_version: "1.21.4",
		loader_version: "0.16.10",
		fabric_version: "0.116.0+1.21.4",
		yarn_mappings: "1.21.4+build.1",
		loom_version: "1.17.12",
		gradle_version: GRADLE_VERSION
	};
	const searchPaths = [path.join(projectRoot, "resources", "fabric-versions.json"), path.join(projectRoot, "out", "resources", "fabric-versions.json")];
	for (const p of searchPaths) {
		if (fs.existsSync(p)) {
			try {
				return { ...fallback, ...JSON.parse(fs.readFileSync(p, "utf-8")) };
			} catch {
				/* use fallback */
			}
		}
	}
	return fallback;
}

// ── 环境完整性校验 ──

function moduleDirHasJar(moduleDir) {
	if (!fs.existsSync(moduleDir)) return false;
	try {
		const walk = (dir) => {
			for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, ent.name);
				if (ent.isDirectory()) {
					if (walk(full)) return true;
				} else if (ent.name.endsWith(".jar")) return true;
			}
			return false;
		};
		return walk(moduleDir);
	} catch {
		return false;
	}
}

function gradleHomeHasFabricCache(gradleHome) {
	const fabricApiDir = path.join(gradleHome, "caches", "modules-2", "files-2.1", "net.fabricmc.fabric-api");
	if (!fs.existsSync(fabricApiDir)) return false;
	return REQUIRED_FABRIC_API_MODULES.every((name) => moduleDirHasJar(path.join(fabricApiDir, name)));
}

function gradleHomeHasLoomCache(gradleHome, mcVersion) {
	const loomCache = path.join(gradleHome, "caches", "fabric-loom");
	if (!fs.existsSync(loomCache)) return false;
	try {
		const walk = (dir) => {
			for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, ent.name);
				if (ent.isDirectory()) {
					if (walk(full)) return true;
				} else {
					const lower = ent.name.toLowerCase();
					if (lower.includes("minecraft") || lower.includes(mcVersion.toLowerCase())) return true;
				}
			}
			return false;
		};
		return walk(loomCache);
	} catch {
		return false;
	}
}

function validateEnvironment(runtimeRoot) {
	const errors = [];
	const warnings = [];
	const expected = loadFabricVersions();

	// 1. JDK 21
	const jdkPath = path.join(runtimeRoot, "jdk-21");
	const javaExe = path.join(jdkPath, "bin", "java.exe");
	if (!fs.existsSync(javaExe)) {
		errors.push(`JDK 21 缺失：${javaExe} 不存在`);
	}

	// 2. Gradle
	const gradlePath = path.join(runtimeRoot, GRADLE_RUNTIME_FOLDER);
	const gradleJar = path.join(gradlePath, "lib", GRADLE_LAUNCHER_JAR);
	if (!fs.existsSync(gradleJar)) {
		errors.push(`Gradle 缺失：${gradleJar} 不存在`);
	}

	// 3. Seed Marker
	const gradleHome = path.join(runtimeRoot, "gradle-home");
	const markerPath = path.join(gradleHome, SEED_MARKER);
	if (!fs.existsSync(markerPath)) {
		errors.push(`Seed marker 缺失：${SEED_MARKER} 不存在（Fabric 依赖未完成离线验证）`);
	} else {
		try {
			const marker = JSON.parse(fs.readFileSync(markerPath, "utf-8"));
			if (!marker.verifiedOffline) {
				errors.push("Seed marker: verifiedOffline 不为 true（离线构建验证未通过）");
			}
			if (!marker.assetsVerified) {
				errors.push("Seed marker: assetsVerified 不为 true（游戏资源验证未通过）");
			}
			// 版本匹配检查
			for (const key of Object.keys(expected)) {
				if (marker[key] !== expected[key]) {
					errors.push(`Seed marker 版本不匹配：${key} 期望 ${expected[key]}，实际 ${marker[key]}`);
					break;
				}
			}
		} catch (err) {
			errors.push(`Seed marker 解析失败：${String(err)}`);
		}
	}

	// 4. Fabric API 缓存
	if (!gradleHomeHasFabricCache(gradleHome)) {
		errors.push("Fabric API 缓存不完整（部分必需模块的 jar 缺失）");
	}

	// 5. Loom 缓存
	if (!gradleHomeHasLoomCache(gradleHome, expected.minecraft_version)) {
		errors.push("Fabric Loom 缓存缺失（Minecraft 映射未下载）");
	}

	// 6. 知识库
	const knowledgeRoot = path.join(runtimeRoot, "knowledge");
	for (const dir of REQUIRED_KNOWLEDGE_DIRS) {
		const dirPath = path.join(knowledgeRoot, dir);
		if (!fs.existsSync(dirPath)) {
			warnings.push(`知识库目录缺失：knowledge/${dir}`);
		} else if (fs.readdirSync(dirPath).length === 0) {
			warnings.push(`知识库目录为空：knowledge/${dir}`);
		}
	}

	// 7. fabric-symbol-index 版本文件（递归搜索，zip 解压可能多一层嵌套目录）
	const symbolDir = path.join(knowledgeRoot, "fabric-symbol-index");
	const targetName = `fabric-symbol-index-${expected.minecraft_version}.json.gz`;
	const findSymbolFile = (dir) => {
		if (!fs.existsSync(dir)) return false;
		for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, ent.name);
			if (ent.isDirectory()) {
				if (findSymbolFile(full)) return true;
			} else if (ent.name === targetName) return true;
		}
		return false;
	};
	if (!findSymbolFile(symbolDir)) {
		warnings.push(`Fabric 符号索引文件缺失：${targetName}`);
	}

	return { errors, warnings, expected };
}

// 需要排除的条目（日志、临时目录、迁移暂存、重复缓存）
const EXCLUDE_PATTERNS = [
	/^logs?[/\\]/i,
	/^_prefetch_project_[^/\\]+[/\\]?/i,
	/\.migration-\d+[/\\]?$/,
	/^\.modcrafting-probe-/i,
	/^caches[/\\]mk-[\w-]+[/\\]daemon$/i, // Gradle daemon 注册表（导入后会自动重建）
	/^gradle-home[/\\]wrapper[/\\]dists[/\\]?/i // Gradle wrapper 下载缓存（与 gradle-9.5 目录重复，约 150MB）
];

function shouldExclude(relPath) {
	const normalized = relPath.replace(/\\/g, "/");
	return EXCLUDE_PATTERNS.some((p) => p.test(normalized));
}

function getDirSize(dir) {
	let total = 0;
	let count = 0;
	function walk(d, relBase = "") {
		for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
			const full = path.join(d, entry.name);
			const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
			if (shouldExclude(rel)) continue;
			if (entry.isDirectory()) walk(full, rel);
			else {
				count++;
				try {
					total += fs.statSync(full).size;
				} catch {
					/* ignore */
				}
			}
		}
	}
	if (fs.existsSync(dir)) walk(dir);
	return { totalBytes: total, fileCount: count };
}

function formatBytes(bytes) {
	if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
	if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
	return `${bytes} B`;
}

async function main() {
	const runtimeRoot = resolveRuntimeRoot();
	if (!runtimeRoot) {
		console.error("未找到 runtime 目录。请先运行 npm run dev 初始化环境，或指定路径。");
		process.exit(1);
	}

	console.log(`runtime 目录：${runtimeRoot}`);

	// ── 环境完整性校验 ──
	console.log("");
	console.log("=== 环境完整性校验 ===");
	const { errors, warnings, expected } = validateEnvironment(runtimeRoot);

	console.log(`  MC 版本：${expected.minecraft_version}`);
	console.log(`  Fabric Loader：${expected.loader_version}`);
	console.log(`  Fabric API：${expected.fabric_version}`);
	console.log(`  Yarn 映射：${expected.yarn_mappings}`);
	console.log(`  Loom：${expected.loom_version}`);
	console.log(`  Gradle：${expected.gradle_version}`);
	console.log("");

	if (errors.length > 0) {
		console.error(`  校验失败：${errors.length} 项错误`);
		for (const e of errors) console.error(`    [错误] ${e}`);
		if (warnings.length > 0) {
			for (const w of warnings) console.warn(`    [警告] ${w}`);
		}
		console.error("");
		console.error("环境不完整，已中止打包。请先运行 ModCrafting 完成环境初始化后重试。");
		process.exit(1);
	}

	if (warnings.length > 0) {
		console.warn(`  校验通过（${warnings.length} 项警告）`);
		for (const w of warnings) console.warn(`    [警告] ${w}`);
		console.warn("  知识库不完整不会阻塞构建，但会影响 AI 功能。建议补全后打包。");
	} else {
		console.log("  所有校验项通过");
	}
	console.log("");

	const outputPath = process.argv[2] || path.join(projectRoot, "release", "ModCrafting-runtime-env.zip");

	const { totalBytes, fileCount } = getDirSize(runtimeRoot);
	console.log(`总大小：${formatBytes(totalBytes)}（${fileCount} 个文件）`);

	// 检查 tar.exe 是否可用
	const tarCheck = spawnSync("tar", ["--version"], { encoding: "utf-8", shell: true });
	if (tarCheck.error || tarCheck.status !== 0) {
		console.error("tar.exe 不可用。请确保使用 Windows 10+ 或已安装 tar。");
		process.exit(1);
	}

	// 确保输出目录存在
	const outputDir = path.dirname(outputPath);
	if (!fs.existsSync(outputDir)) {
		fs.mkdirSync(outputDir, { recursive: true });
	}

	// 删除已存在的输出文件
	if (fs.existsSync(outputPath)) {
		fs.unlinkSync(outputPath);
		console.log(`已删除旧的压缩包：${outputPath}`);
	}

	// 创建排除列表文件（tar --exclude-from）
	const excludeFile = path.join(os.tmpdir(), `modcrafting-exclude-${Date.now()}.txt`);
	const excludeLines = ["logs", "log", "_prefetch_project_*", "*.migration-*", ".modcrafting-probe-*", "caches/mk-*/daemon", "gradle-home/wrapper/dists"];
	fs.writeFileSync(excludeFile, excludeLines.join("\n"), "utf-8");

	console.log(`正在压缩为 zip（使用 tar.exe）…`);
	console.log(`输出路径：${outputPath}`);

	// 使用 tar.exe 创建 zip 压缩包，异步运行以便显示进度
	const tarArgs = ["-a", "-cf", outputPath, "--exclude-from", excludeFile, "-C", runtimeRoot, "."];
	const startTime = Date.now();
	let stderrBuf = "";
	let lastSize = 0;
	let lastTime = startTime;

	const child = spawn("tar", tarArgs, { stdio: ["ignore", "pipe", "pipe"], shell: false });
	child.stderr?.on("data", (chunk) => {
		stderrBuf += chunk.toString();
	});
	child.stdout?.on("data", () => {
		/* tar 静默模式无 stdout */
	});

	// 进度定时器：每 2 秒检查输出文件大小
	const progressTimer = setInterval(() => {
		try {
			const currentSize = fs.statSync(outputPath).size;
			const now = Date.now();
			const elapsedSec = (now - startTime) / 1000;
			const intervalSec = (now - lastTime) / 1000;
			const intervalBytes = currentSize - lastSize;
			const speedMBps = intervalSec > 0 ? intervalBytes / 1024 / 1024 / intervalSec : 0;
			// zip 对已压缩内容（jar/png/ogg）几乎无效，整体压缩率约 0.95
			const estimatedFinal = totalBytes * 0.95;
			const percent = Math.min(Math.round((currentSize / estimatedFinal) * 100), 99);
			const barLen = 30;
			const filled = Math.round((percent / 100) * barLen);
			const bar = "█".repeat(filled) + "░".repeat(barLen - filled);
			process.stdout.write(`\r  ${bar} ${percent}% | ${formatBytes(currentSize)} | ${speedMBps.toFixed(1)} MB/s`);
			lastSize = currentSize;
			lastTime = now;
		} catch {
			/* 文件可能尚未创建 */
		}
	}, 2000);

	const exitCode = await new Promise((resolve) => {
		child.on("close", resolve);
		child.on("error", (err) => {
			stderrBuf += `\nspawn error: ${err.message}`;
			resolve(1);
		});
	});

	clearInterval(progressTimer);
	process.stdout.write("\r" + " ".repeat(70) + "\r");

	const totalElapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
	console.log(`  压缩耗时：${totalElapsedSec}s`);

	// 清理临时文件
	try {
		fs.unlinkSync(excludeFile);
	} catch {
		/* ignore */
	}

	if (exitCode !== 0) {
		console.error("压缩失败：", stderrBuf || `tar 退出码 ${exitCode}`);
		process.exit(1);
	}

	const outputSize = fs.statSync(outputPath).size;
	const ratio = ((1 - outputSize / totalBytes) * 100).toFixed(1);
	console.log("");
	console.log("压缩完成！");
	console.log(`  原始大小：${formatBytes(totalBytes)}`);
	console.log(`  压缩包大小：${formatBytes(outputSize)}`);
	console.log(`  压缩率：${ratio}%`);
	console.log(`  输出路径：${outputPath}`);
	console.log("");
	console.log("可将此压缩包上传到 QQ 群文件，供网络较慢的用户手动导入。");
	console.log("导入方式：在 ModCrafting 环境初始化界面选择「手动导入环境包」。");
}

main().catch((err) => {
	console.error("执行失败：", err);
	process.exit(1);
});
