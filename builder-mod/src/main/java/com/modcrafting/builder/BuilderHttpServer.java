package com.modcrafting.builder;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.reflect.TypeToken;
import com.sun.net.httpserver.Headers;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.util.math.BlockPos;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.function.Supplier;

/** Loopback HTTP API for the local ModCrafting plugin. All world work runs on the server thread. */
public final class BuilderHttpServer {
    private static final Gson GSON = new GsonBuilder().disableHtmlEscaping().create();
    private static final TypeToken<Map<String, Object>> MAP_TYPE = new TypeToken<>() {};
    private static final int MAX_BODY = 64 * 1024;

    private final HttpServer http;
    private final int port;
    private final String token;
    private final MinecraftServer server;

    private BuilderHttpServer(HttpServer http, int port, String token, MinecraftServer server) {
        this.http = http;
        this.port = port;
        this.token = token;
        this.server = server;
    }

    public static BuilderHttpServer start(MinecraftServer server) throws IOException {
        String token = StudioFiles.randomToken();
        HttpServer http = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        BuilderHttpServer bridge = new BuilderHttpServer(http, http.getAddress().getPort(), token, server);
        http.createContext("/", bridge::handle);
        http.setExecutor(Executors.newCachedThreadPool(runnable -> {
            Thread thread = new Thread(runnable, "modcrafting-builder-http");
            thread.setDaemon(true);
            return thread;
        }));
        http.start();
        bridge.writeDiscovery();
        return bridge;
    }

    public int getPort() {
        return port;
    }

    public void stop() {
        http.stop(0);
        try {
            Files.deleteIfExists(discoveryPath());
        } catch (IOException ignored) {
        }
    }

    private void writeDiscovery() throws IOException {
        Path file = discoveryPath();
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("version", 1);
        payload.put("protocol", 1);
        payload.put("port", port);
        payload.put("token", token);
        payload.put("modVersion", ModCraftingBuilder.MOD_VERSION);
        payload.put("dimension", StudioManager.STUDIO_WORLD.getValue().toString());
        Files.writeString(file, GSON.toJson(payload), StandardCharsets.UTF_8);
    }

    private Path discoveryPath() {
        return server.getRunDirectory().resolve("modcrafting-builder.json");
    }

    private void handle(HttpExchange exchange) throws IOException {
        try {
            String method = exchange.getRequestMethod();
            String path = exchange.getRequestURI().getPath();
            if (path == null) path = "/";
            if (path.endsWith("/") && path.length() > 1) path = path.substring(0, path.length() - 1);
            if (!authorize(exchange)) {
                writeJson(exchange, 401, Map.of("ok", false, "code", "UNAUTHORIZED", "error", "缺少或错误的 Authorization Bearer token"));
                return;
            }
            Map<String, Object> result;
            if ("GET".equalsIgnoreCase(method)) {
                result = "/v1/studio/status".equals(path)
                        ? execute(15_000, StudioManager.INSTANCE::status)
                        : Map.of("ok", false, "code", "NOT_FOUND", "error", "未知路径: " + path);
            } else if ("POST".equalsIgnoreCase(method)) {
                Map<String, Object> body = readBody(exchange);
                result = routePost(path, body);
            } else {
                result = Map.of("ok", false, "code", "METHOD_NOT_ALLOWED", "error", "仅支持 GET/POST");
            }
            writeJson(exchange, 200, result);
        } catch (Exception error) {
            ModCraftingBuilder.LOGGER.error("Builder HTTP request failed", error);
            writeJson(exchange, 500, Map.of("ok", false, "code", "INTERNAL", "error", String.valueOf(error)));
        } finally {
            exchange.close();
        }
    }

    private Map<String, Object> routePost(String path, Map<String, Object> body) {
        String buildId = StudioFiles.text(body, "buildId");
        boolean force = StudioFiles.bool(body, "force", false);
        return switch (path) {
            case "/v1/studio/open" -> execute(120_000, () -> {
                ServerPlayerEntity player = StudioManager.INSTANCE.activePlayerOrThrow();
                return StudioManager.INSTANCE.open(player, requireId(buildId), force);
            });
            case "/v1/studio/commit" -> execute(120_000, () -> StudioManager.INSTANCE.commit(buildId));
            case "/v1/studio/apply" -> execute(120_000, () -> {
                Integer x = StudioFiles.integer(body, "x");
                Integer y = StudioFiles.integer(body, "y");
                Integer z = StudioFiles.integer(body, "z");
                BlockPos pos = x != null && y != null && z != null ? new BlockPos(x, y, z) : null;
                boolean teleport = StudioFiles.bool(body, "teleport", true);
                return StudioManager.INSTANCE.apply(StudioManager.INSTANCE.activePlayerOrThrow(), requireId(buildId), pos, force, teleport);
            });
            case "/v1/studio/undo" -> execute(120_000, () -> StudioManager.INSTANCE.undo(StudioFiles.text(body, "token")));
            case "/v1/studio/exit" -> execute(30_000, () -> StudioManager.INSTANCE.exit(StudioManager.INSTANCE.activePlayerOrThrow()));
            case "/v1/studio/clear" -> execute(120_000, () -> StudioManager.INSTANCE.clear(buildId, force));
            case "/v1/studio/teleport" -> execute(30_000, () -> StudioManager.INSTANCE.teleportToView(StudioManager.INSTANCE.activePlayerOrThrow()));
            default -> Map.of("ok", false, "code", "NOT_FOUND", "error", "未知路径: " + path);
        };
    }

    private Map<String, Object> execute(long timeoutMs, Supplier<Map<String, Object>> work) {
        CompletableFuture<Map<String, Object>> future = new CompletableFuture<>();
        try {
            server.execute(() -> {
                try {
                    future.complete(work.get());
                } catch (Throwable error) {
                    future.completeExceptionally(error);
                }
            });
        } catch (Throwable error) {
            return failure(error);
        }
        try {
            return future.get(timeoutMs, TimeUnit.MILLISECONDS);
        } catch (TimeoutException error) {
            return failure(new StudioManager.StudioException("TIMEOUT", "操作超时，请查看游戏日志。"));
        } catch (Exception error) {
            return failure(error.getCause() != null ? error.getCause() : error);
        }
    }

    private static Map<String, Object> failure(Throwable error) {
        String code = error instanceof StudioManager.StudioException studio ? studio.code : "INTERNAL";
        String message = error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage();
        return Map.of("ok", false, "code", code, "error", message);
    }

    private static String requireId(String id) {
        if (id == null || id.isBlank()) throw new StudioManager.StudioException("BUILD_REQUIRED", "缺少 buildId。");
        return id;
    }

    private boolean authorize(HttpExchange exchange) {
        String auth = exchange.getRequestHeaders().getFirst("Authorization");
        return auth != null && ("Bearer " + token).equals(auth.trim());
    }

    private static Map<String, Object> readBody(HttpExchange exchange) throws IOException {
        try (InputStream input = exchange.getRequestBody()) {
            byte[] bytes = input.readNBytes(MAX_BODY + 1);
            if (bytes.length > MAX_BODY) throw new IOException("request body too large");
            if (bytes.length == 0) return Map.of();
            Map<String, Object> value = GSON.fromJson(new String(bytes, StandardCharsets.UTF_8), MAP_TYPE.getType());
            return value == null ? Map.of() : value;
        }
    }

    private static void writeJson(HttpExchange exchange, int status, Object body) throws IOException {
        byte[] bytes = GSON.toJson(body).getBytes(StandardCharsets.UTF_8);
        Headers headers = exchange.getResponseHeaders();
        headers.set("Content-Type", "application/json; charset=utf-8");
        headers.set("Cache-Control", "no-store");
        headers.set("X-Content-Type-Options", "nosniff");
        exchange.sendResponseHeaders(status, bytes.length);
        try (OutputStream output = exchange.getResponseBody()) {
            output.write(bytes);
        }
    }
}
