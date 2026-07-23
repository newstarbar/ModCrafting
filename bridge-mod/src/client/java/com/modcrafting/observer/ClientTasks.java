package com.modcrafting.observer;

import net.minecraft.client.MinecraftClient;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;

/** Run work on the Minecraft client thread and wait for the result. */
public final class ClientTasks {
    private static final long DEFAULT_TIMEOUT_MS = 8_000;

    private ClientTasks() {}

    public static <T> T supply(Supplier<T> supplier) {
        return supply(supplier, DEFAULT_TIMEOUT_MS);
    }

    public static <T> T supply(Supplier<T> supplier, long timeoutMs) {
        MinecraftClient client = MinecraftClient.getInstance();
        if (client == null) {
            throw new IllegalStateException("MinecraftClient not ready");
        }
        if (client.isOnThread()) {
            return supplier.get();
        }
        CompletableFuture<T> future = new CompletableFuture<>();
        client.execute(() -> {
            try {
                future.complete(supplier.get());
            } catch (Throwable t) {
                future.completeExceptionally(t);
            }
        });
        try {
            return future.get(timeoutMs, TimeUnit.MILLISECONDS);
        } catch (Exception e) {
            throw new RuntimeException("Client task failed: " + e.getMessage(), e);
        }
    }

    public static void run(Runnable runnable) {
        supply(() -> {
            runnable.run();
            return Boolean.TRUE;
        });
    }
}
