package com.modcrafting.observer;

import net.minecraft.client.MinecraftClient;
import net.minecraft.client.font.TextRenderer;
import net.minecraft.entity.Entity;
import net.minecraft.registry.Registries;
import net.minecraft.client.render.entity.EntityRenderer;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Small, generic client-observation rings. They record rendering facts only;
 * they intentionally know nothing about a tested mod, entity, key binding, or feature.
 */
public final class ObservationTrace {
    private static final int LIMIT = 256;
    private static final Deque<Map<String, Object>> HUD = new ArrayDeque<>();
    private static final Deque<Map<String, Object>> RENDER = new ArrayDeque<>();
    private static final Deque<Map<String, Object>> COMBAT = new ArrayDeque<>();
    private static long hudSequence;
    private static long renderSequence;
    private static long combatSequence;

    private ObservationTrace() {}

    public static synchronized void hudText(String text, int x, int y, int color) {
        hudText(null, text, x, y, color, false);
    }

    public static synchronized void hudText(TextRenderer renderer, String text, int x, int y, int color, boolean shadow) {
        if (text == null || text.isBlank()) return;
        Map<String, Object> entry = base();
        entry.put("text", text);
        entry.put("x", x);
        entry.put("y", y);
        int alpha = (color >>> 24) & 0xff;
        // Minecraft accepts legacy RGB colors without an explicit alpha byte;
        // those draw fully opaque and must not be reported as transparent.
        entry.put("alpha", alpha == 0 ? 255 : alpha);
        entry.put("color", (color & 0x00ffffff) | ((alpha == 0 ? 255 : alpha) << 24));
        entry.put("shadow", shadow);
        MinecraftClient client = MinecraftClient.getInstance();
        entry.put("screen", client != null && client.currentScreen != null ? client.currentScreen.getClass().getName() : null);
        int width = renderer == null ? text.length() * 6 : renderer.getWidth(text);
        int screenWidth = client == null ? 0 : client.getWindow().getScaledWidth();
        int screenHeight = client == null ? 0 : client.getWindow().getScaledHeight();
        entry.put("textWidth", width);
        entry.put("screenWidth", screenWidth);
        entry.put("screenHeight", screenHeight);
        entry.put("normalizedX", screenWidth > 0 ? (double) x / screenWidth : null);
        entry.put("normalizedY", screenHeight > 0 ? (double) y / screenHeight : null);
        entry.put("rightMargin", screenWidth > 0 ? (double) (screenWidth - x - width) / screenWidth : null);
        entry.put("sequence", ++hudSequence);
        append(HUD, entry);
    }

    public static synchronized void render(Entity entity, EntityRenderer<?, ?> renderer) {
        if (entity == null || renderer == null) return;
        Map<String, Object> entry = base();
        entry.put("entityUuid", entity.getUuidAsString());
        entry.put("entityType", Registries.ENTITY_TYPE.getId(entity.getType()).toString());
        entry.put("rendererClass", renderer.getClass().getName());
        entry.put("sequence", ++renderSequence);
        // Model and texture are renderer-specific in modern Minecraft. Their absence
        // is advertised as an unavailable field instead of guessed from class names.
        append(RENDER, entry);
    }

    public static synchronized List<Map<String, Object>> hudSnapshot() { return new ArrayList<>(HUD); }
    public static synchronized List<Map<String, Object>> renderSnapshot() { return new ArrayList<>(RENDER); }
    public static synchronized List<Map<String, Object>> combatSnapshot() { return new ArrayList<>(COMBAT); }

    public static synchronized void combatDeath(Entity victim, Entity attacker, String damageType) {
        if (victim == null) return;
        Map<String, Object> entry = base();
        entry.put("sequence", ++combatSequence);
        entry.put("victimUuid", victim.getUuidAsString());
        entry.put("victimType", Registries.ENTITY_TYPE.getId(victim.getType()).toString());
        entry.put("victimName", victim.getName().getString());
        entry.put("victimTags", new ArrayList<>(victim.getCommandTags()));
        entry.put("attackerUuid", attacker == null ? null : attacker.getUuidAsString());
        entry.put("attackerType", attacker == null ? null : Registries.ENTITY_TYPE.getId(attacker.getType()).toString());
        entry.put("attackerIsPlayer", attacker instanceof net.minecraft.entity.player.PlayerEntity);
        entry.put("damageType", damageType);
        entry.put("killed", true);
        append(COMBAT, entry);
    }

    private static Map<String, Object> base() {
        MinecraftClient client = MinecraftClient.getInstance();
        Map<String, Object> entry = new LinkedHashMap<>();
        entry.put("observedAt", System.currentTimeMillis());
        entry.put("worldTick", client != null && client.world != null ? client.world.getTime() : null);
        return entry;
    }

    private static void append(Deque<Map<String, Object>> target, Map<String, Object> entry) {
        target.addLast(entry);
        while (target.size() > LIMIT) target.removeFirst();
    }
}
