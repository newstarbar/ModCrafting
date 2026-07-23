package com.modcrafting.observer;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.reflect.TypeToken;
import com.sun.net.httpserver.Headers;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import net.minecraft.client.MinecraftClient;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.SecureRandom;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.Executors;

public final class BridgeHttpServer {
    private static final Gson GSON = new GsonBuilder().disableHtmlEscaping().create();
    private static final TypeToken<Map<String, Object>> MAP_TYPE = new TypeToken<>() {};

    private final HttpServer http;
    private final int port;
    private final String token;

    private BridgeHttpServer(HttpServer http, int port, String token) {
        this.http = http;
        this.port = port;
        this.token = token;
    }

    public int getPort() {
        return port;
    }

    public static BridgeHttpServer start() throws IOException {
        String token = randomToken();
        HttpServer http = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        int port = http.getAddress().getPort();
        BridgeHttpServer bridge = new BridgeHttpServer(http, port, token);
        http.createContext("/", bridge::handle);
        http.setExecutor(Executors.newCachedThreadPool(r -> {
            Thread t = new Thread(r, "modcrafting-observer-http");
            t.setDaemon(true);
            return t;
        }));
        http.start();
        bridge.writeDiscoveryFile();
        return bridge;
    }

    public void stop() {
        http.stop(0);
        try {
            Path file = discoveryPath();
            if (file != null) {
                Files.deleteIfExists(file);
            }
        } catch (IOException ignored) {
        }
    }

    private void writeDiscoveryFile() throws IOException {
        Path file = discoveryPath();
        if (file == null) {
            throw new IOException("runDirectory unavailable");
        }
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("version", 1);
        payload.put("port", port);
        payload.put("token", token);
        payload.put("modVersion", ModCraftingObserverClient.MOD_VERSION);
        Files.writeString(file, GSON.toJson(payload), StandardCharsets.UTF_8);
    }

    private static Path discoveryPath() {
        MinecraftClient client = MinecraftClient.getInstance();
        if (client == null || client.runDirectory == null) return null;
        return client.runDirectory.toPath().resolve("modcrafting-bridge.json");
    }

    private void handle(HttpExchange exchange) throws IOException {
        try {
            String method = exchange.getRequestMethod();
            if ("OPTIONS".equalsIgnoreCase(method)) {
                Headers h = exchange.getResponseHeaders();
                h.add("Access-Control-Allow-Origin", "*");
                h.add("Access-Control-Allow-Headers", "Authorization, Content-Type");
                h.add("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
                exchange.sendResponseHeaders(204, -1);
                return;
            }

            String path = exchange.getRequestURI().getPath();
            if (path == null) path = "/";
            if (path.endsWith("/") && path.length() > 1) {
                path = path.substring(0, path.length() - 1);
            }

            if (!"/v1/health".equals(path) && !authorize(exchange)) {
                writeJson(exchange, 401, Map.of(
                        "ok", false,
                        "code", "UNAUTHORIZED",
                        "error", "缺少或错误的 Authorization Bearer token"
                ));
                return;
            }

            Map<String, Object> result;
            long timeout = path.contains("screenshot") ? 15_000 : 8_000;
            String finalPath = path;
            if ("GET".equalsIgnoreCase(method)) {
                result = ClientTasks.supply(() -> routeGet(finalPath, exchange.getRequestURI().getRawQuery()), timeout);
            } else if ("POST".equalsIgnoreCase(method)) {
                String bodyText = readBody(exchange);
                Map<String, Object> body = bodyText.isBlank()
                        ? Map.of()
                        : GSON.fromJson(bodyText, MAP_TYPE.getType());
                if (body == null) body = Map.of();
                Map<String, Object> finalBody = body;
                result = ClientTasks.supply(() -> routePost(finalPath, finalBody), timeout);
            } else {
                writeJson(exchange, 405, Map.of("ok", false, "code", "METHOD_NOT_ALLOWED", "error", "仅支持 GET/POST"));
                return;
            }

            int status = Boolean.FALSE.equals(result.get("ok")) ? mapErrorStatus(result) : 200;
            writeJson(exchange, status, result);
        } catch (Exception e) {
            ModCraftingObserverClient.LOGGER.error("Bridge request failed", e);
            writeJson(exchange, 500, Map.of(
                    "ok", false,
                    "code", "INTERNAL",
                    "error", e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage()
            ));
        } finally {
            exchange.close();
        }
    }

    private Map<String, Object> routeGet(String path, String rawQuery) {
        return switch (path) {
            case "/v1/health" -> GameQueries.health();
            case "/v1/screenshot" -> GameQueries.screenshot();
            case "/v1/player" -> GameQueries.player();
            case "/v1/inventory" -> GameQueries.inventory();
            case "/v1/screen" -> GameQueries.screen();
            case "/v1/widgets" -> GameQueries.widgets();
            case "/v1/look" -> GameQueries.look();
            case "/v1/nearby" -> GameQueries.nearby(queryDouble(rawQuery, "radius", 8.0));
            case "/v1/chat" -> GameQueries.chatRecent((int) queryDouble(rawQuery, "limit", 50));
            case "/v1/inspect" -> {
                Map<String, Object> out = new LinkedHashMap<>();
                out.put("ok", true);
                out.put("player", GameQueries.player());
                out.put("screen", GameQueries.screen());
                out.put("look", GameQueries.look());
                out.put("widgets", GameQueries.widgets());
                yield out;
            }
            default -> Map.of("ok", false, "code", "NOT_FOUND", "error", "未知路径: " + path);
        };
    }

    private Map<String, Object> routePost(String path, Map<String, Object> body) {
        return switch (path) {
            case "/v1/chat" -> GameQueries.sendChat(string(body.get("text"), body.get("message")));
            case "/v1/command" -> GameQueries.sendCommand(string(body.get("command"), body.get("text")));
            case "/v1/input" -> InputActions.handle(body);
            default -> Map.of("ok", false, "code", "NOT_FOUND", "error", "未知路径: " + path);
        };
    }

    private boolean authorize(HttpExchange exchange) {
        String auth = exchange.getRequestHeaders().getFirst("Authorization");
        if (auth == null) return false;
        String expected = "Bearer " + token;
        return expected.equals(auth.trim());
    }

    private static String readBody(HttpExchange exchange) throws IOException {
        try (InputStream in = exchange.getRequestBody()) {
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    private static void writeJson(HttpExchange exchange, int status, Object body) throws IOException {
        byte[] bytes = GSON.toJson(body).getBytes(StandardCharsets.UTF_8);
        Headers h = exchange.getResponseHeaders();
        h.set("Content-Type", "application/json; charset=utf-8");
        h.set("Access-Control-Allow-Origin", "*");
        exchange.sendResponseHeaders(status, bytes.length);
        try (OutputStream out = exchange.getResponseBody()) {
            out.write(bytes);
        }
    }

    private static int mapErrorStatus(Map<String, Object> result) {
        Object code = result.get("code");
        if ("UNAUTHORIZED".equals(code)) return 401;
        if ("NOT_FOUND".equals(code)) return 404;
        if ("NOT_IN_WORLD".equals(code) || "BAD_REQUEST".equals(code)) return 400;
        return 500;
    }

    private static double queryDouble(String rawQuery, String key, double def) {
        if (rawQuery == null || rawQuery.isBlank()) return def;
        for (String part : rawQuery.split("&")) {
            int eq = part.indexOf('=');
            if (eq <= 0) continue;
            if (!key.equals(part.substring(0, eq))) continue;
            try {
                return Double.parseDouble(java.net.URLDecoder.decode(part.substring(eq + 1), StandardCharsets.UTF_8));
            } catch (Exception ignored) {
                return def;
            }
        }
        return def;
    }

    private static String string(Object primary, Object fallback) {
        if (primary != null) return String.valueOf(primary);
        if (fallback != null) return String.valueOf(fallback);
        return "";
    }

    private static String randomToken() {
        byte[] bytes = new byte[16];
        new SecureRandom().nextBytes(bytes);
        return HexFormat.of().formatHex(bytes);
    }
}
