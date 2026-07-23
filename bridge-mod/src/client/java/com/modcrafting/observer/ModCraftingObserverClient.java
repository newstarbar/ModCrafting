package com.modcrafting.observer;

import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.message.v1.ClientReceiveMessageEvents;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientLifecycleEvents;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class ModCraftingObserverClient implements ClientModInitializer {
    public static final String MOD_ID = "modcrafting_observer";
    public static final String MOD_VERSION = "1.0.0";
    public static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);

    private static BridgeHttpServer server;

    @Override
    public void onInitializeClient() {
        ChatBuffer.init();
        ClientReceiveMessageEvents.GAME.register((message, overlay) -> {
            if (!overlay) {
                ChatBuffer.add("game", message.getString());
            }
        });
        ClientReceiveMessageEvents.CHAT.register((message, signedMessage, sender, params, receptionTimestamp) -> {
            String name = sender != null ? sender.getName() : "unknown";
            ChatBuffer.add("chat", "<" + name + "> " + message.getString());
        });

        ClientLifecycleEvents.CLIENT_STARTED.register(client -> {
            try {
                server = BridgeHttpServer.start();
                LOGGER.info("ModCrafting Observer bridge listening on 127.0.0.1:{}", server.getPort());
            } catch (Exception e) {
                LOGGER.error("Failed to start ModCrafting Observer bridge", e);
            }
        });

        ClientLifecycleEvents.CLIENT_STOPPING.register(client -> {
            if (server != null) {
                server.stop();
                server = null;
            }
        });

        LOGGER.info("ModCrafting Observer client initialized");
    }
}
