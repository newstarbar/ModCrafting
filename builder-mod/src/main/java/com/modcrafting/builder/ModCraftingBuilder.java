package com.modcrafting.builder;

import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public final class ModCraftingBuilder implements ModInitializer {
    public static final String MOD_ID = "modcrafting_builder";
    public static final String MOD_VERSION = "0.1.0";
    public static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);

    private BuilderHttpServer httpServer;

    @Override
    public void onInitialize() {
        StudioCommands.register();
        ServerLifecycleEvents.SERVER_STARTED.register(server -> {
            StudioManager.INSTANCE.onServerStarted(server);
            try {
                httpServer = BuilderHttpServer.start(server);
                LOGGER.info("ModCrafting Builder HTTP listening on 127.0.0.1:{}", httpServer.getPort());
            } catch (Exception error) {
                LOGGER.error("Failed to start ModCrafting Builder HTTP", error);
            }
        });
        ServerLifecycleEvents.SERVER_STOPPING.register(server -> {
            if (httpServer != null) {
                httpServer.stop();
                httpServer = null;
            }
            StudioManager.INSTANCE.onServerStopping();
        });
        ServerTickEvents.END_SERVER_TICK.register(server -> StudioManager.INSTANCE.tick(server));
        LOGGER.info("ModCrafting Builder initialized");
    }
}
