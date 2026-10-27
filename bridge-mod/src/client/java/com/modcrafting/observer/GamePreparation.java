package com.modcrafting.observer;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.screen.AccessibilityOnboardingScreen;
import net.minecraft.client.gui.screen.ConfirmScreen;
import net.minecraft.client.gui.screen.MessageScreen;
import net.minecraft.client.gui.screen.Screen;
import net.minecraft.client.gui.screen.TitleScreen;
import net.minecraft.client.gui.screen.world.CreateWorldScreen;
import net.minecraft.client.gui.screen.world.WorldCreator;
import net.minecraft.client.gui.widget.ButtonWidget;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.nbt.NbtCompound;
import net.minecraft.nbt.NbtIo;
import net.minecraft.nbt.NbtSizeTracker;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.integrated.IntegratedServerLoader;
import net.minecraft.world.GameMode;
import net.minecraft.util.WorldSavePath;
import net.minecraft.world.Difficulty;
import net.minecraft.world.level.storage.LevelStorage;
import net.minecraft.text.TranslatableTextContent;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/** Drives first-run dismissal and the native Minecraft test-world creation/load flow. */
public final class GamePreparation {
    public static final String TEST_WORLD = "ModCrafting Test World";
    private static final String OWNER_FILE = ".modcrafting-owner.json";
    private static final Gson GSON = new GsonBuilder().disableHtmlEscaping().create();
    private static String sessionId;
    private static Map<String, Object> profile = Map.of();
    private static Map<String, Object> mapProfile = Map.of();
    private static String phase = "idle";
    private static String blockedReason;
    private static String recoveryAction;
    private static int onboardingAttempts;
    private static int createScreenTicks;
    private static boolean openingCreateScreen;
    private static boolean loadingWorld;
    private static boolean ready;
    private static boolean failed;

    private GamePreparation() {}

    public static Map<String, Object> begin(Map<String, Object> request) {
        String requestedSession = string(request.get("sessionId"));
        Object rawProfile = request.get("profile");
        if (requestedSession.isBlank() || !(rawProfile instanceof Map<?, ?> map)) {
            return error("BAD_REQUEST", "准备测试世界需要 sessionId 和 profile。", "prepare_files", "重新读取当前会话的测试配置。", null);
        }
        if (sessionId != null && !sessionId.equals(requestedSession) && !ready && !failed) {
            return error("SESSION_CONFLICT", "这个 Minecraft 实例已被另一个会话占用。", phase, "在原会话停止该游戏后再继续。", screenSnapshot());
        }
        if (!requestedSession.equals(sessionId)) reset();
        sessionId = requestedSession;
        profile = (Map<String, Object>) map;
        Object rawMap = profile.get("map");
        mapProfile = rawMap instanceof Map<?, ?> nested ? (Map<String, Object>) nested : Map.of();
        phase = "handling_first_run";
        return status();
    }

    public static Map<String, Object> status() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("sessionId", sessionId);
        out.put("phase", phase);
        out.put("ready", ready);
        out.put("failed", failed);
        out.put("blockedReason", blockedReason);
        out.put("recoveryAction", recoveryAction);
        out.put("screen", screenSnapshot());
        out.put("worldName", TEST_WORLD);
        return out;
    }

    public static void tick(MinecraftClient client) {
        Screen screen = client.currentScreen;
        if (screen instanceof AccessibilityOnboardingScreen onboarding) {
            if (onboardingAttempts >= 2) {
                fail("首次辅助功能向导重复出现，自动处理已停止。", "保留当前界面与启动日志，确认游戏版本和配置文件是否完整。");
                return;
            }
            onboardingAttempts++;
            client.options.onboardAccessibility = false;
            client.options.write();
            onboarding.close();
            if (sessionId != null) phase = "handling_first_run";
            return;
        }
        if (screen == null && client.player == null) {
            if (sessionId != null) phase = "waiting_title_screen";
            return;
        }
        if (sessionId == null || ready || failed) return;

        ClientPlayerEntity player = client.player;
        MinecraftServer server = client.getServer();
        if (player != null && client.world != null && server != null) {
            Path worldRoot = worldRoot(server);
            if (worldRoot == null) {
                fail("Minecraft 没有报告当前存档目录。", "保留当前画面和游戏日志；检查世界是否已完成加载。");
                return;
            }
            if (!TEST_WORLD.equals(worldRoot.getFileName().toString())) {
                fail("当前进入的存档不是 ModCrafting 专用测试世界。", "返回标题界面后使用当前会话的游戏启动入口。普通存档不会被修改。");
                return;
            }
            try {
                applyWorldProfile(server, player);
                Path owner = worldRoot.resolve(OWNER_FILE);
                Map<String, Object> marker = new LinkedHashMap<>(readMarker(owner));
                if (marker.isEmpty()) {
                    marker.put("sessionId", sessionId);
                    marker.put("worldName", TEST_WORLD);
                    marker.put("createdAt", System.currentTimeMillis());
                    Files.writeString(owner, GSON.toJson(marker), StandardCharsets.UTF_8);
                }
                if (!sessionId.equals(string(marker.get("sessionId")))) {
                    fail("测试地图属于其他任务会话。", "请在这个会话的独立游戏目录中创建测试地图。");
                    return;
                }
                ready = true;
                phase = "test_ready";
                blockedReason = null;
                recoveryAction = null;
            } catch (Exception error) {
                fail("无法写入测试地图归属标记：" + message(error), "检查当前测试目录是否可写；不要改动原始存档。");
            }
            return;
        }

        String simpleName = screen == null ? "" : screen.getClass().getSimpleName();
        if (isLoadingScreen(screen)) {
            phase = "loading_world";
            return;
        }
        if (screen instanceof CreateWorldScreen createScreen) {
            configureAndCreate(createScreen);
            return;
        }
        if (screen instanceof TitleScreen || screen instanceof net.minecraft.client.gui.screen.world.SelectWorldScreen) {
            openOrCreate(client, screen);
            return;
        }
        if (screen instanceof ConfirmScreen confirm) {
            if (acceptExperimentalWarning(confirm)) return;
            fail("游戏停在无法识别的确认界面：" + simpleName + " · " + (confirm.getTitle() == null ? "" : confirm.getTitle().getString()), "保留当前画面和任务日志；确认是否有额外的首次启动提示或模组弹窗。");
            return;
        }
        if (screen != null) fail("游戏停在无法识别的界面：" + simpleName, "保留当前画面和任务日志；确认是否有额外的首次启动提示或模组弹窗。");
    }

    /**
     * A custom dimension data pack marks the session-owned test world as experimental.
     * Only the experimental/backup warning may be accepted automatically; other confirmations stay blocked.
     */
    private static boolean acceptExperimentalWarning(ConfirmScreen screen) {
        String title = screen.getTitle() == null ? "" : screen.getTitle().getString().toLowerCase(java.util.Locale.ROOT);
        if (!title.contains("experimental") && !title.contains("实验")) return false;
        ButtonWidget fallback = null;
        for (var child : screen.children()) {
            if (!(child instanceof ButtonWidget button) || !button.active || !button.visible) continue;
            if (fallback == null) fallback = button;
            var message = button.getMessage();
            String key = message != null && message.getContent() instanceof TranslatableTextContent text ? text.getKey() : "";
            if ("gui.proceed".equals(key) || "gui.continue".equals(key) || "selectWorld.experimental.confirm".equals(key)) {
                button.onClick(button.getX() + button.getWidth() / 2.0, button.getY() + button.getHeight() / 2.0);
                return true;
            }
        }
        // ConfirmScreen adds its affirmative button first; only reached for the guarded experimental title.
        if (fallback != null) {
            fallback.onClick(fallback.getX() + fallback.getWidth() / 2.0, fallback.getY() + fallback.getHeight() / 2.0);
            return true;
        }
        return false;
    }

    public static boolean isTestWorld(MinecraftServer server) {
        if (server == null || sessionId == null) return false;
        Path worldRoot = worldRoot(server);
        if (worldRoot == null) return false;
        if (!TEST_WORLD.equals(worldRoot.getFileName().toString())) return false;
        Map<String, Object> marker = readMarker(worldRoot.resolve(OWNER_FILE));
        return sessionId.equals(string(marker.get("sessionId"))) && TEST_WORLD.equals(string(marker.get("worldName")));
    }

    private static void openOrCreate(MinecraftClient client, Screen parent) {
        try {
            LevelStorage storage = LevelStorage.create(client.runDirectory.toPath());
            if (storage.levelExists(TEST_WORLD)) {
                Path target = storage.resolve(TEST_WORLD);
                Map<String, Object> marker = readMarker(target.resolve(OWNER_FILE));
                if (!sessionId.equals(string(marker.get("sessionId")))) {
                    fail("测试地图目录存在，但没有当前会话的归属标记。", "为该会话选择一个空的游戏目录；现有地图不会被覆盖。");
                    return;
                }
                configureCopiedWorld(target);
                loadingWorld = true;
                phase = "entering_world";
                new IntegratedServerLoader(client, storage).start(TEST_WORLD, () -> fail("Minecraft 取消了测试世界加载。", "检查地图是否损坏后再继续。"));
                return;
            }
            if (openingCreateScreen) return;
            openingCreateScreen = true;
            phase = "preparing_world";
            CreateWorldScreen.show(client, parent);
        } catch (Exception error) {
            fail("无法打开 Minecraft 世界列表：" + message(error), "检查独立游戏目录中的 saves 文件夹是否可读写。");
        }
    }

    private static void configureAndCreate(CreateWorldScreen screen) {
        createScreenTicks++;
        WorldCreator creator = screen.getWorldCreator();
        try {
            creator.setWorldName(TEST_WORLD);
            creator.setSeed(string(mapProfile.getOrDefault("seed", "0")));
            creator.setCheatsEnabled(bool(profile.get("allowCommands"), true));
            String selectedMode = string(profile.getOrDefault("gameMode", "creative")).toUpperCase(java.util.Locale.ROOT);
            creator.setGameMode("CREATIVE".equals(selectedMode) ? WorldCreator.Mode.CREATIVE : WorldCreator.Mode.SURVIVAL);
            creator.setDifficulty(Difficulty.valueOf(string(profile.getOrDefault("difficulty", "peaceful")).toUpperCase(java.util.Locale.ROOT)));
            String terrain = string(mapProfile.getOrDefault("terrain", "flat"));
            Optional<WorldCreator.WorldType> selected = java.util.stream.Stream.concat(creator.getNormalWorldTypes().stream(), creator.getExtendedWorldTypes().stream())
                    .filter(value -> value.preset() != null && value.preset().getKey().map(key -> ("minecraft:" + terrain).equals(key.getValue().toString())).orElse(false))
                    .findFirst();
            if (selected.isEmpty()) {
                fail("Minecraft 没有提供所选地图地形：" + terrain, "选择默认平地或普通地形后再启动。");
                return;
            }
            creator.setWorldType(selected.get());
            for (var child : screen.children()) {
                if (!(child instanceof ButtonWidget button) || button.getMessage() == null) continue;
                if (!(button.getMessage().getContent() instanceof TranslatableTextContent text) || !"selectWorld.create".equals(text.getKey())) continue;
                if (!button.active || !button.visible) {
                    fail("创建测试地图按钮当前不可用。", "检查游戏日志和世界创建配置。");
                    return;
                }
                phase = "creating_world";
                loadingWorld = true;
                openingCreateScreen = false;
                button.onClick(button.getX() + button.getWidth() / 2.0, button.getY() + button.getHeight() / 2.0);
                return;
            }
            if (createScreenTicks > 4) fail("世界创建页面没有找到稳定标识为 selectWorld.create 的按钮。", "保留当前界面和日志；请检查该 Minecraft 版本的创建页面变化。");
        } catch (Exception error) {
            fail("应用测试世界配置失败：" + message(error), "检查 Minecraft 版本和测试配置，再在当前会话重试。");
        }
    }

    private static Map<String, Object> screenSnapshot() {
        try { return GameQueries.screen(); }
        catch (Exception ignored) { return Map.of("ok", false, "kind", "unknown"); }
    }

    /** The source save is already a session-owned copy created by Core. */
    private static void configureCopiedWorld(Path worldDirectory) throws IOException {
        Path levelDat = worldDirectory.resolve("level.dat");
        NbtCompound root = NbtIo.readCompressed(levelDat, NbtSizeTracker.ofUnlimitedBytes());
        NbtCompound data = root.getCompound("Data");
        if (data.isEmpty()) throw new IOException("level.dat has no Data compound");
        String selectedMode = string(profile.getOrDefault("gameMode", "creative")).toUpperCase(java.util.Locale.ROOT);
        int mode = switch (selectedMode) { case "CREATIVE" -> 1; case "ADVENTURE" -> 2; default -> 0; };
        String selectedDifficulty = string(profile.getOrDefault("difficulty", "peaceful")).toUpperCase(java.util.Locale.ROOT);
        int difficulty = switch (selectedDifficulty) { case "EASY" -> 1; case "NORMAL" -> 2; case "HARD" -> 3; default -> 0; };
        data.putInt("GameType", mode);
        data.putByte("Difficulty", (byte) difficulty);
        data.putBoolean("allowCommands", bool(profile.get("allowCommands"), true));
        root.put("Data", data);
        NbtIo.writeCompressed(root, levelDat);
    }

    private static void applyWorldProfile(MinecraftServer server, ClientPlayerEntity clientPlayer) {
        Difficulty difficulty = Difficulty.valueOf(string(profile.getOrDefault("difficulty", "peaceful")).toUpperCase(java.util.Locale.ROOT));
        GameMode gameMode = GameMode.valueOf(string(profile.getOrDefault("gameMode", "creative")).toUpperCase(java.util.Locale.ROOT));
        server.getSaveProperties().setDifficulty(difficulty);
        server.setDifficulty(difficulty, true);
        server.getSaveProperties().setGameMode(gameMode);
        var serverPlayer = server.getPlayerManager().getPlayer(clientPlayer.getUuid());
        if (serverPlayer != null) serverPlayer.changeGameMode(gameMode);
    }

    private static Path worldRoot(MinecraftServer server) {
        Path levelDat = server.getSavePath(WorldSavePath.LEVEL_DAT);
        return levelDat == null ? null : levelDat.getParent();
    }

    private static boolean isLoadingScreen(Screen screen) {
        if (screen == null) return false;
        String simpleName = screen.getClass().getSimpleName();
        if (simpleName.contains("Loading") || simpleName.contains("Progress") || simpleName.equals("DownloadingTerrainScreen")) return true;
        // Minecraft 1.21.4 uses a buttonless MessageScreen while its initial resources finish loading.
        // Wait on this native screen type instead of treating its localized message as an error or selector.
        return screen instanceof MessageScreen && screen.children().stream().noneMatch(ButtonWidget.class::isInstance);
    }

    private static Map<String, Object> readMarker(Path path) {
        try {
            Map<String, Object> value = GSON.fromJson(Files.readString(path, StandardCharsets.UTF_8), Map.class);
            return value == null ? Map.of() : value;
        }
        catch (Exception ignored) { return Map.of(); }
    }

    private static Map<String, Object> error(String code, String reason, String blockedPhase, String recovery, Map<String, Object> screen) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", false); out.put("code", code); out.put("error", reason); out.put("phase", blockedPhase);
        out.put("blockedReason", reason); out.put("recoveryAction", recovery); out.put("screen", screen);
        return out;
    }

    private static void fail(String reason, String recovery) {
        failed = true; ready = false; phase = "failed"; blockedReason = reason; recoveryAction = recovery;
        ModCraftingObserverClient.LOGGER.warn("Test world preparation failed at {}: {}", phase, reason);
    }

    private static void reset() {
        phase = "idle"; blockedReason = null; recoveryAction = null; onboardingAttempts = 0; createScreenTicks = 0;
        openingCreateScreen = false; loadingWorld = false; ready = false; failed = false;
        mapProfile = Map.of();
    }

    private static String string(Object value) { return value == null ? "" : String.valueOf(value); }
    private static boolean bool(Object value, boolean fallback) { return value instanceof Boolean b ? b : fallback; }
    private static String message(Throwable error) { return error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage(); }
}
