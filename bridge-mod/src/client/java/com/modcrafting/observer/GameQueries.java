package com.modcrafting.observer;

import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.screen.Screen;
import net.minecraft.client.gui.screen.TitleScreen;
import net.minecraft.client.gui.screen.multiplayer.MultiplayerScreen;
import net.minecraft.client.gui.screen.world.SelectWorldScreen;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.client.util.ScreenshotRecorder;
import net.minecraft.entity.Entity;
import net.minecraft.entity.LivingEntity;
import net.minecraft.entity.player.PlayerInventory;
import net.minecraft.item.ItemStack;
import net.minecraft.registry.Registries;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.hit.EntityHitResult;
import net.minecraft.util.hit.HitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Box;
import net.minecraft.world.World;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class GameQueries {
    private static final DateTimeFormatter SHOT_TS =
            DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss-SSS").withZone(ZoneOffset.UTC);

    private GameQueries() {}

    public static Map<String, Object> health() {
        MinecraftClient client = MinecraftClient.getInstance();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("modVersion", ModCraftingObserverClient.MOD_VERSION);
        out.put("inWorld", client.player != null && client.world != null);
        out.put("paused", client.isPaused());
        Screen screen = client.currentScreen;
        out.put("hasScreen", screen != null);
        out.put("screenClass", screen != null ? screen.getClass().getName() : null);
        return out;
    }

    public static Map<String, Object> player() {
        MinecraftClient client = MinecraftClient.getInstance();
        ClientPlayerEntity player = client.player;
        if (player == null || client.world == null) {
            return error("NOT_IN_WORLD", "玩家尚未进入世界");
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("name", player.getName().getString());
        out.put("uuid", player.getUuidAsString());
        out.put("x", round(player.getX()));
        out.put("y", round(player.getY()));
        out.put("z", round(player.getZ()));
        out.put("yaw", round(player.getYaw()));
        out.put("pitch", round(player.getPitch()));
        out.put("health", player.getHealth());
        out.put("maxHealth", player.getMaxHealth());
        out.put("food", player.getHungerManager().getFoodLevel());
        out.put("saturation", player.getHungerManager().getSaturationLevel());
        out.put("air", player.getAir());
        out.put("experienceLevel", player.experienceLevel);
        out.put("dimension", client.world.getRegistryKey().getValue().toString());
        out.put("gamemode", client.interactionManager != null
                ? client.interactionManager.getCurrentGameMode().getName()
                : null);
        out.put("flying", player.getAbilities().flying);
        out.put("creative", player.getAbilities().creativeMode);
        out.put("onGround", player.isOnGround());
        out.put("sneaking", player.isSneaking());
        out.put("sprinting", player.isSprinting());
        out.put("mainHand", stackSummary(player.getMainHandStack()));
        out.put("offHand", stackSummary(player.getOffHandStack()));
        out.put("selectedSlot", player.getInventory().selectedSlot);
        return out;
    }

    public static Map<String, Object> inventory() {
        MinecraftClient client = MinecraftClient.getInstance();
        ClientPlayerEntity player = client.player;
        if (player == null) {
            return error("NOT_IN_WORLD", "玩家尚未进入世界");
        }
        PlayerInventory inv = player.getInventory();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("selectedSlot", inv.selectedSlot);
        out.put("main", slotList(inv, 9, 36));
        out.put("hotbar", slotList(inv, 0, 9));
        out.put("armor", slotList(inv, 36, 40));
        out.put("offhand", List.of(stackSummary(inv.getStack(40))));
        return out;
    }

    public static Map<String, Object> screen() {
        MinecraftClient client = MinecraftClient.getInstance();
        Screen screen = client.currentScreen;
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("inWorld", client.player != null && client.world != null);
        if (screen == null) {
            out.put("className", null);
            out.put("title", null);
            out.put("kind", client.player != null ? "ingame" : "none");
            out.put("widgets", List.of());
            return out;
        }
        out.put("className", screen.getClass().getName());
        out.put("simpleName", screen.getClass().getSimpleName());
        out.put("title", screen.getTitle() != null ? screen.getTitle().getString() : null);
        String kind = "other";
        if (screen instanceof TitleScreen) kind = "title";
        else if (screen instanceof SelectWorldScreen) kind = "select_world";
        else if (screen instanceof MultiplayerScreen) kind = "multiplayer";
        else if (screen.shouldPause()) kind = "pause_or_menu";
        out.put("kind", kind);
        out.put("pausesGame", screen.shouldPause());
        out.put("scaledWidth", client.getWindow().getScaledWidth());
        out.put("scaledHeight", client.getWindow().getScaledHeight());
        out.put("widgets", widgetsOf(screen));
        return out;
    }

    public static Map<String, Object> widgets() {
        MinecraftClient client = MinecraftClient.getInstance();
        Screen screen = client.currentScreen;
        Map<String, Object> out = new LinkedHashMap<>();
        if (screen == null) {
            out.put("ok", false);
            out.put("code", "NO_SCREEN");
            out.put("error", "当前没有打开的 GUI 屏幕");
            return out;
        }
        out.put("ok", true);
        out.put("screenClass", screen.getClass().getName());
        out.put("simpleName", screen.getClass().getSimpleName());
        out.put("title", screen.getTitle() != null ? screen.getTitle().getString() : null);
        out.put("scaledWidth", client.getWindow().getScaledWidth());
        out.put("scaledHeight", client.getWindow().getScaledHeight());
        out.put("widgets", widgetsOf(screen));
        return out;
    }

    private static List<Map<String, Object>> widgetsOf(Screen screen) {
        List<Map<String, Object>> list = new ArrayList<>();
        int index = 0;
        for (var element : screen.children()) {
            if (!(element instanceof net.minecraft.client.gui.widget.ClickableWidget widget)) continue;
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("index", index++);
            row.put("type", widget.getClass().getSimpleName());
            row.put("message", widget.getMessage() != null ? widget.getMessage().getString() : "");
            row.put("x", widget.getX());
            row.put("y", widget.getY());
            row.put("width", widget.getWidth());
            row.put("height", widget.getHeight());
            row.put("active", widget.active);
            row.put("visible", widget.visible);
            row.put("centerX", widget.getX() + widget.getWidth() / 2.0);
            row.put("centerY", widget.getY() + widget.getHeight() / 2.0);
            list.add(row);
            if (list.size() >= 64) break;
        }
        return list;
    }

    public static Map<String, Object> look() {
        MinecraftClient client = MinecraftClient.getInstance();
        if (client.player == null || client.world == null) {
            return error("NOT_IN_WORLD", "玩家尚未进入世界");
        }
        HitResult hit = client.crosshairTarget;
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        if (hit == null) {
            out.put("type", "miss");
            return out;
        }
        out.put("type", hit.getType().name().toLowerCase());
        if (hit instanceof BlockHitResult blockHit) {
            BlockPos pos = blockHit.getBlockPos();
            out.put("blockPos", Map.of("x", pos.getX(), "y", pos.getY(), "z", pos.getZ()));
            out.put("side", blockHit.getSide().asString());
            var state = client.world.getBlockState(pos);
            out.put("blockId", Registries.BLOCK.getId(state.getBlock()).toString());
        } else if (hit instanceof EntityHitResult entityHit) {
            Entity entity = entityHit.getEntity();
            out.put("entity", entitySummary(entity));
        }
        return out;
    }

    public static Map<String, Object> nearby(double radius) {
        MinecraftClient client = MinecraftClient.getInstance();
        ClientPlayerEntity player = client.player;
        World world = client.world;
        if (player == null || world == null) {
            return error("NOT_IN_WORLD", "玩家尚未进入世界");
        }
        double r = Math.max(1.0, Math.min(radius, 64.0));
        Box box = player.getBoundingBox().expand(r);
        List<Map<String, Object>> entities = new ArrayList<>();
        for (Entity entity : world.getOtherEntities(player, box)) {
            if (player.squaredDistanceTo(entity) > r * r) continue;
            entities.add(entitySummary(entity));
            if (entities.size() >= 64) break;
        }
        List<Map<String, Object>> blocks = new ArrayList<>();
        BlockPos origin = player.getBlockPos();
        int sample = Math.min(3, (int) Math.ceil(r));
        for (int dx = -sample; dx <= sample; dx++) {
            for (int dy = -1; dy <= 2; dy++) {
                for (int dz = -sample; dz <= sample; dz++) {
                    BlockPos pos = origin.add(dx, dy, dz);
                    var state = world.getBlockState(pos);
                    if (state.isAir()) continue;
                    Map<String, Object> b = new LinkedHashMap<>();
                    b.put("x", pos.getX());
                    b.put("y", pos.getY());
                    b.put("z", pos.getZ());
                    b.put("blockId", Registries.BLOCK.getId(state.getBlock()).toString());
                    blocks.add(b);
                    if (blocks.size() >= 48) break;
                }
                if (blocks.size() >= 48) break;
            }
            if (blocks.size() >= 48) break;
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("radius", r);
        out.put("entities", entities);
        out.put("blocks", blocks);
        return out;
    }

    public static Map<String, Object> screenshot() {
        MinecraftClient client = MinecraftClient.getInstance();
        Path dir = client.runDirectory.toPath().resolve("modcrafting-shots");
        try {
            Files.createDirectories(dir);
        } catch (IOException e) {
            return error("IO_ERROR", "无法创建截图目录: " + e.getMessage());
        }
        String name = "shot-" + SHOT_TS.format(Instant.now()) + ".png";
        Path file = dir.resolve(name);
        var image = ScreenshotRecorder.takeScreenshot(client.getFramebuffer());
        try {
            image.writeTo(file);
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("ok", true);
            out.put("path", file.toAbsolutePath().toString());
            out.put("relativePath", "modcrafting-shots/" + name);
            out.put("width", image.getWidth());
            out.put("height", image.getHeight());
            byte[] bytes = Files.readAllBytes(file);
            // Cap embedded base64 for vision models (~1.5MB raw ≈ 2MB base64)
            if (bytes.length <= 1_500_000) {
                out.put("base64", Base64.getEncoder().encodeToString(bytes));
                out.put("mimeType", "image/png");
            } else {
                out.put("base64", null);
                out.put("note", "截图过大，未内嵌 base64，请使用 path 读取文件");
            }
            return out;
        } catch (IOException e) {
            return error("IO_ERROR", "截图写入失败: " + e.getMessage());
        } finally {
            image.close();
        }
    }

    public static Map<String, Object> chatRecent(int limit) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        List<Map<String, Object>> messages = new ArrayList<>();
        for (ChatBuffer.Entry e : ChatBuffer.recent(limit)) {
            messages.add(Map.of("ts", e.ts(), "kind", e.kind(), "text", e.text()));
        }
        out.put("messages", messages);
        return out;
    }

    public static Map<String, Object> sendChat(String text) {
        MinecraftClient client = MinecraftClient.getInstance();
        if (client.player == null || client.getNetworkHandler() == null) {
            return error("NOT_IN_WORLD", "玩家尚未进入世界，无法发送聊天");
        }
        String msg = text == null ? "" : text.trim();
        if (msg.isEmpty()) {
            return error("BAD_REQUEST", "聊天内容为空");
        }
        if (msg.startsWith("/")) {
            client.getNetworkHandler().sendChatCommand(msg.substring(1));
        } else {
            client.getNetworkHandler().sendChatMessage(msg);
        }
        ChatBuffer.add("out", msg);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("sent", msg);
        return out;
    }

    public static Map<String, Object> sendCommand(String command) {
        String cmd = command == null ? "" : command.trim();
        if (cmd.isEmpty()) {
            return error("BAD_REQUEST", "命令为空");
        }
        if (!cmd.startsWith("/")) {
            cmd = "/" + cmd;
        }
        return sendChat(cmd);
    }

    private static List<Map<String, Object>> slotList(PlayerInventory inv, int from, int to) {
        List<Map<String, Object>> list = new ArrayList<>();
        for (int i = from; i < to; i++) {
            ItemStack stack = inv.getStack(i);
            if (stack.isEmpty()) continue;
            Map<String, Object> row = stackSummary(stack);
            row.put("slot", i);
            list.add(row);
        }
        return list;
    }

    private static Map<String, Object> stackSummary(ItemStack stack) {
        Map<String, Object> m = new LinkedHashMap<>();
        if (stack == null || stack.isEmpty()) {
            m.put("empty", true);
            return m;
        }
        m.put("empty", false);
        m.put("id", Registries.ITEM.getId(stack.getItem()).toString());
        m.put("count", stack.getCount());
        m.put("name", stack.getName().getString());
        m.put("damage", stack.getDamage());
        m.put("maxDamage", stack.getMaxDamage());
        return m;
    }

    private static Map<String, Object> entitySummary(Entity entity) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("type", Registries.ENTITY_TYPE.getId(entity.getType()).toString());
        m.put("name", entity.getName().getString());
        m.put("uuid", entity.getUuidAsString());
        m.put("x", round(entity.getX()));
        m.put("y", round(entity.getY()));
        m.put("z", round(entity.getZ()));
        m.put("distance", round(MinecraftClient.getInstance().player != null
                ? Math.sqrt(MinecraftClient.getInstance().player.squaredDistanceTo(entity))
                : 0));
        if (entity instanceof LivingEntity living) {
            m.put("health", living.getHealth());
            m.put("maxHealth", living.getMaxHealth());
        }
        return m;
    }

    private static Map<String, Object> error(String code, String message) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", false);
        out.put("code", code);
        out.put("error", message);
        return out;
    }

    private static double round(double v) {
        return Math.round(v * 1000.0) / 1000.0;
    }
}
