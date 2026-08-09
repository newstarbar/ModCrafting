package com.modcrafting.observer;

import net.minecraft.client.MinecraftClient;
import net.minecraft.entity.Entity;
import net.minecraft.registry.Registries;
import net.minecraft.recipe.RecipeEntry;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.command.ServerCommandSource;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.util.Identifier;
import net.minecraft.util.math.BlockPos;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

/** V2 test-only API: deterministic commands and fresh structured snapshots. */
public final class GameTestApi {
    private static final long SERVER_TIMEOUT_MS = 8_000;

    private GameTestApi() {}

    public static Map<String, Object> capabilities() {
        MinecraftClient client = MinecraftClient.getInstance();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("protocolVersion", 2);
        out.put("commandExecution", client != null && client.getServer() != null);
        out.put("snapshot", true);
        out.put("queryKinds", List.of("registry", "block", "entities", "recipe"));
        out.put("testWorld", "ModCrafting Test World");
        return out;
    }

    public static Map<String, Object> command(String command) {
        MinecraftClient client = MinecraftClient.getInstance();
        if (client == null || client.player == null || client.getServer() == null) {
            return error("NOT_IN_INTEGRATED_WORLD", "需要已进入单人集成服务器世界");
        }
        String normalized = command == null ? "" : command.trim();
        if (normalized.startsWith("/")) normalized = normalized.substring(1);
        if (normalized.isEmpty()) return error("BAD_REQUEST", "命令为空");
        if (isDangerous(normalized)) return error("COMMAND_DENIED", "测试协议禁止该服务器管理命令");

        MinecraftServer server = client.getServer();
        ServerPlayerEntity player = server.getPlayerManager().getPlayer(client.player.getUuid());
        if (player == null) return error("PLAYER_NOT_READY", "服务端玩家尚未就绪");
        CompletableFuture<Map<String, Object>> future = new CompletableFuture<>();
        String finalCommand = normalized;
        server.execute(() -> {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("requestId", "cmd_" + System.nanoTime());
            out.put("command", finalCommand);
            try {
                ServerCommandSource source = player.getCommandSource().withLevel(4);
                int result = server.getCommandManager().getDispatcher().execute(finalCommand, source);
                out.put("ok", true);
                out.put("accepted", true);
                out.put("executed", true);
                out.put("result", result);
            } catch (Exception error) {
                out.put("ok", false);
                out.put("accepted", true);
                out.put("executed", false);
                out.put("code", "COMMAND_FAILED");
                out.put("error", error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage());
            }
            future.complete(out);
        });
        try {
            return future.get(SERVER_TIMEOUT_MS, TimeUnit.MILLISECONDS);
        } catch (Exception error) {
            return error("COMMAND_TIMEOUT", "等待服务端命令结果超时: " + error.getMessage());
        }
    }

    public static Map<String, Object> snapshot(Map<String, Object> body) {
        MinecraftClient client = MinecraftClient.getInstance();
        if (client == null || client.player == null || client.world == null) {
            return error("NOT_IN_WORLD", "玩家尚未进入世界");
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("requestId", "snap_" + System.nanoTime());
        out.put("observedAt", System.currentTimeMillis());
        out.put("worldTime", client.world.getTime());
        out.put("worldName", client.getServer() == null ? null : client.getServer().getSaveProperties().getLevelName());
        out.put("player", GameQueries.player());
        out.put("inventory", GameQueries.inventory());
        out.put("screen", GameQueries.screen());
        Map<String, Object> widgetState = GameQueries.widgets();
        out.put("widgets", widgetState.getOrDefault("widgets", List.of()));

        List<Map<String, Object>> blocks = new ArrayList<>();
        Object rawBlocks = body == null ? null : body.get("blocks");
        if (rawBlocks instanceof List<?> list) {
            for (Object entry : list) {
                if (!(entry instanceof Map<?, ?> map)) continue;
                int x = number(map.get("x"));
                int y = number(map.get("y"));
                int z = number(map.get("z"));
                BlockPos pos = new BlockPos(x, y, z);
                Map<String, Object> block = new LinkedHashMap<>();
                block.put("x", x);
                block.put("y", y);
                block.put("z", z);
                block.put("blockId", Registries.BLOCK.getId(client.world.getBlockState(pos).getBlock()).toString());
                blocks.add(block);
            }
        }
        out.put("blocks", blocks);
        double radius = body != null && body.get("entityRadius") != null ? Math.max(1, Math.min(64, doubleValue(body.get("entityRadius")))) : 32;
        Map<String, Object> nearby = GameQueries.nearby(radius);
        out.put("entities", nearby.getOrDefault("entities", List.of()));
        List<String> recipes = new ArrayList<>();
        MinecraftServer server = client.getServer();
        if (server != null) {
            for (RecipeEntry<?> entry : server.getRecipeManager().values()) recipes.add(entry.id().toString());
            out.put("recipeQuerySupported", true);
        } else {
            out.put("recipeQuerySupported", false);
        }
        out.put("recipes", recipes);
        return out;
    }

    public static Map<String, Object> query(Map<String, Object> body) {
        String kind = String.valueOf(body == null ? "" : body.getOrDefault("kind", "")).toLowerCase(Locale.ROOT);
        if ("registry".equals(kind)) {
            String registryKind = String.valueOf(body.getOrDefault("registryKind", ""));
            String id = String.valueOf(body.getOrDefault("id", ""));
            Identifier identifier;
            try { identifier = Identifier.of(id); } catch (Exception e) { return error("BAD_ID", "无效资源 ID: " + id); }
            boolean exists = switch (registryKind) {
                case "item" -> Registries.ITEM.getIds().contains(identifier);
                case "block" -> Registries.BLOCK.getIds().contains(identifier);
                case "entity" -> Registries.ENTITY_TYPE.getIds().contains(identifier);
                default -> false;
            };
            return Map.of("ok", true, "kind", "registry", "exists", exists, "id", id, "registryKind", registryKind);
        }
        if ("recipe".equals(kind)) {
            String id = String.valueOf(body.getOrDefault("id", ""));
            try {
                Identifier identifier = Identifier.of(id);
                MinecraftClient client = MinecraftClient.getInstance();
                MinecraftServer server = client == null ? null : client.getServer();
                if (server == null) return error("NOT_IN_INTEGRATED_WORLD", "需要已进入单人集成服务器世界");
                boolean exists = server.getRecipeManager().values().stream().anyMatch(entry -> entry.id().equals(identifier));
                return Map.of("ok", true, "kind", "recipe", "supported", true, "id", id, "exists", exists);
            } catch (Exception error) {
                return error("BAD_ID", "无效配方 ID: " + id);
            }
        }
        return error("UNSUPPORTED_QUERY", "不支持的 V2 query kind: " + kind);
    }

    private static boolean isDangerous(String command) {
        String head = command.trim().toLowerCase(Locale.ROOT);
        return head.matches("^(?:stop|save-all|op|deop|ban|pardon|kick|whitelist|publish|reload)(?:\\s|$).*");
    }

    private static int number(Object value) {
        return value instanceof Number n ? n.intValue() : Integer.parseInt(String.valueOf(value));
    }

    private static double doubleValue(Object value) {
        return value instanceof Number n ? n.doubleValue() : Double.parseDouble(String.valueOf(value));
    }

    private static Map<String, Object> error(String code, String message) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", false);
        out.put("code", code);
        out.put("error", message);
        return out;
    }
}
