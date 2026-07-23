package com.modcrafting.observer;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;

/** Ring buffer of recent client chat/game messages. */
public final class ChatBuffer {
    private static final int MAX = 200;
    private static final ArrayDeque<Entry> ENTRIES = new ArrayDeque<>();

    private ChatBuffer() {}

    public static void init() {
        synchronized (ENTRIES) {
            ENTRIES.clear();
        }
    }

    public static void add(String kind, String text) {
        if (text == null || text.isBlank()) return;
        synchronized (ENTRIES) {
            ENTRIES.addLast(new Entry(System.currentTimeMillis(), kind, text));
            while (ENTRIES.size() > MAX) {
                ENTRIES.removeFirst();
            }
        }
    }

    public static List<Entry> recent(int limit) {
        int n = Math.max(1, Math.min(limit, MAX));
        synchronized (ENTRIES) {
            List<Entry> all = new ArrayList<>(ENTRIES);
            if (all.size() <= n) return all;
            return all.subList(all.size() - n, all.size());
        }
    }

    public record Entry(long ts, String kind, String text) {}
}
