package com.modcrafting.builder;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.reflect.TypeToken;
import net.minecraft.nbt.NbtCompound;
import net.minecraft.nbt.NbtIo;
import net.minecraft.nbt.NbtSizeTracker;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.HexFormat;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Pattern;

/** File-system boundary for the studio inbox/outbox. Never reads arbitrary paths. */
public final class StudioFiles {
    public static final long MAX_BYTES = 64L * 1024 * 1024;
    private static final Pattern ID = Pattern.compile("[a-z0-9_]{1,64}");
    private static final Gson GSON = new GsonBuilder().disableHtmlEscaping().create();
    private static final SecureRandom RANDOM = new SecureRandom();

    private StudioFiles() {}

    public static Path root(Path gameDirectory) {
        return gameDirectory.resolve("modcrafting-studio");
    }

    public static Path directory(Path gameDirectory, String kind, String id) throws IOException {
        validateId(id);
        Path root = root(gameDirectory);
        Path target = root.resolve(kind).resolve(id).normalize();
        if (!target.startsWith(root.normalize())) throw new IOException("studio path escaped its root");
        checkLinks(root, target);
        return target;
    }

    public static Path inbox(Path gameDirectory, String buildId) throws IOException {
        return directory(gameDirectory, "inbox", buildId);
    }

    public static Path outbox(Path gameDirectory, String buildId) throws IOException {
        return directory(gameDirectory, "outbox", buildId);
    }

    public static Path undo(Path gameDirectory, String token) throws IOException {
        return directory(gameDirectory, "undo", token);
    }

    public static Path structure(Path directory) {
        return directory.resolve("structure.nbt");
    }

    public static Path manifest(Path directory) {
        return directory.resolve("manifest.json");
    }

    public static void validateId(String id) throws IOException {
        if (id == null || !ID.matcher(id).matches()) throw new IOException("invalid studio id");
    }

    private static void checkLinks(Path root, Path target) throws IOException {
        Path current = root;
        for (Path part : root.relativize(target)) {
            current = current.resolve(part);
            if (Files.isSymbolicLink(current)) throw new IOException("studio path contains a link");
        }
    }

    public static NbtCompound readNbt(Path file) throws IOException {
        if (Files.isSymbolicLink(file) || !Files.isRegularFile(file)) throw new IOException("not a regular structure file");
        long size = Files.size(file);
        if (size <= 0 || size > MAX_BYTES) throw new IOException("structure file size is outside the allowed range");
        try (InputStream input = Files.newInputStream(file)) {
            return NbtIo.readCompressed(input, NbtSizeTracker.ofUnlimitedBytes());
        }
    }

    public static void writeNbt(Path file, NbtCompound nbt) throws IOException {
        Files.createDirectories(file.getParent());
        Path temporary = file.resolveSibling(file.getFileName() + ".tmp-" + UUID.randomUUID());
        try {
            NbtIo.writeCompressed(nbt, temporary);
            move(temporary, file);
        } finally {
            Files.deleteIfExists(temporary);
        }
    }

    public static Map<String, Object> readManifest(Path file) {
        try {
            if (!Files.isRegularFile(file) || Files.isSymbolicLink(file) || Files.size(file) > 256 * 1024) return Map.of();
            String text = Files.readString(file, StandardCharsets.UTF_8);
            Map<String, Object> value = GSON.fromJson(text, new TypeToken<Map<String, Object>>() {}.getType());
            return value == null ? Map.of() : value;
        } catch (Exception ignored) {
            return Map.of();
        }
    }

    public static void writeManifest(Path file, Map<String, Object> value) throws IOException {
        Files.createDirectories(file.getParent());
        Path temporary = file.resolveSibling(file.getFileName() + ".tmp-" + UUID.randomUUID());
        try {
            Files.writeString(temporary, GSON.toJson(value) + "\n", StandardCharsets.UTF_8);
            move(temporary, file);
        } finally {
            Files.deleteIfExists(temporary);
        }
    }

    public static String sha256(Path file) throws IOException {
        MessageDigest digest = digest();
        try (InputStream input = Files.newInputStream(file)) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = input.read(buffer)) >= 0) digest.update(buffer, 0, read);
        }
        return HexFormat.of().formatHex(digest.digest());
    }

    public static String randomToken() {
        byte[] bytes = new byte[32];
        RANDOM.nextBytes(bytes);
        return HexFormat.of().formatHex(bytes);
    }

    public static MessageDigest digest() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (Exception error) {
            throw new IllegalStateException("SHA-256 is unavailable", error);
        }
    }

    public static String text(Map<String, Object> value, String key) {
        Object raw = value.get(key);
        return raw instanceof String text ? text : null;
    }

    public static boolean bool(Map<String, Object> value, String key, boolean fallback) {
        Object raw = value.get(key);
        return raw instanceof Boolean flag ? flag : fallback;
    }

    public static Integer integer(Map<String, Object> value, String key) {
        Object raw = value.get(key);
        return raw instanceof Number number ? number.intValue() : null;
    }

    private static void move(Path source, Path target) throws IOException {
        try {
            Files.move(source, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (AtomicMoveNotSupportedException ignored) {
            Files.move(source, target, StandardCopyOption.REPLACE_EXISTING);
        }
    }
}
