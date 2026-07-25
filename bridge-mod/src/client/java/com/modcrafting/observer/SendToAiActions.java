package com.modcrafting.observer;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.reflect.TypeToken;
import net.minecraft.client.MinecraftClient;
import net.minecraft.text.Text;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;

/** Capture screenshot and POST it to ModCrafting Electron ContextIngress. */
public final class SendToAiActions {
    private static final Gson GSON = new GsonBuilder().disableHtmlEscaping().create();
    private static final TypeToken<Map<String, Object>> MAP_TYPE = new TypeToken<>() {};
    private static volatile boolean busy = false;

    private SendToAiActions() {}

    public static boolean isBusy() {
        return busy;
    }

    public static void sendAsync() {
        if (busy) {
            toast("正在发送截图，请稍候…");
            return;
        }
        busy = true;
        Thread t = new Thread(() -> {
            try {
                sendBlocking();
            } finally {
                busy = false;
            }
        }, "modcrafting-send-to-ai");
        t.setDaemon(true);
        t.start();
    }

    private static void sendBlocking() {
        MinecraftClient client = MinecraftClient.getInstance();
        if (client == null) return;

        Map<String, Object> shot;
        try {
            shot = ClientTasks.supply(GameQueries::screenshot, 15_000);
        } catch (Exception e) {
            toast("发送给 AI 失败：" + e.getMessage());
            return;
        }
        if (shot == null || Boolean.FALSE.equals(shot.get("ok"))) {
            String err = shot == null ? "截图失败" : String.valueOf(shot.getOrDefault("error", "截图失败"));
            toast("发送给 AI 失败：" + err);
            return;
        }

        Path discovery = discoveryPath();
        if (discovery == null || !Files.isRegularFile(discovery)) {
            toast("未找到 ModCrafting（~/.modcrafting/context-ingress.json）。请先打开应用并加载项目。");
            return;
        }

        Map<String, Object> disc;
        try {
            disc = GSON.fromJson(Files.readString(discovery, StandardCharsets.UTF_8), MAP_TYPE.getType());
        } catch (IOException e) {
            toast("读取 Electron 发现文件失败：" + e.getMessage());
            return;
        }
        if (disc == null) {
            toast("Electron 发现文件无效");
            return;
        }

        int port = ((Number) disc.getOrDefault("port", 0)).intValue();
        String token = String.valueOf(disc.getOrDefault("token", ""));
        String host = String.valueOf(disc.getOrDefault("host", "127.0.0.1"));
        if (port <= 0 || token.isBlank()) {
            toast("Electron Ingress 未就绪");
            return;
        }

        Map<String, Object> body = new LinkedHashMap<>();
        body.put("kind", "image");
        body.put("source", "game-hud");
        if (shot.get("path") != null) body.put("path", shot.get("path"));
        if (shot.get("base64") != null) body.put("base64", shot.get("base64"));
        if (shot.get("mimeType") != null) body.put("mimeType", shot.get("mimeType"));
        body.put("name", "game-screenshot.png");

        try {
            HttpURLConnection conn = (HttpURLConnection) URI.create(
                    "http://" + host + ":" + port + "/v1/context"
            ).toURL().openConnection();
            conn.setConnectTimeout(3000);
            conn.setReadTimeout(10_000);
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            conn.setRequestProperty("Authorization", "Bearer " + token);
            byte[] raw = GSON.toJson(body).getBytes(StandardCharsets.UTF_8);
            conn.setFixedLengthStreamingMode(raw.length);
            try (OutputStream os = conn.getOutputStream()) {
                os.write(raw);
            }
            int status = conn.getResponseCode();
            String resp = readStream(status >= 400 ? conn.getErrorStream() : conn.getInputStream());
            Map<String, Object> parsed = resp.isBlank()
                    ? Map.of()
                    : GSON.fromJson(resp, MAP_TYPE.getType());
            if (status >= 200 && status < 300 && parsed != null && !Boolean.FALSE.equals(parsed.get("ok"))) {
                toast("已发送截图到 ModCrafting 输入框");
            } else {
                String err = parsed != null
                        ? String.valueOf(parsed.getOrDefault("error", "HTTP " + status))
                        : ("HTTP " + status);
                toast("发送失败：" + err);
            }
            conn.disconnect();
        } catch (Exception e) {
            toast("无法连接 ModCrafting：" + e.getMessage());
        }
    }

    private static Path discoveryPath() {
        String home = System.getProperty("user.home");
        if (home == null || home.isBlank()) return null;
        return Path.of(home, ".modcrafting", "context-ingress.json");
    }

    private static String readStream(InputStream in) throws IOException {
        if (in == null) return "";
        return new String(in.readAllBytes(), StandardCharsets.UTF_8);
    }

    private static void toast(String message) {
        MinecraftClient client = MinecraftClient.getInstance();
        if (client == null) return;
        client.execute(() -> {
            if (client.player != null) {
                client.player.sendMessage(Text.literal("[ModCrafting] " + message), false);
            } else {
                ModCraftingObserverClient.LOGGER.info("[SendToAI] {}", message);
            }
        });
    }
}
