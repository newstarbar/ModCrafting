package com.modcrafting.builder;

import com.mojang.brigadier.CommandDispatcher;
import com.mojang.brigadier.context.CommandContext;
import com.mojang.brigadier.exceptions.CommandSyntaxException;
import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.minecraft.server.command.CommandManager;
import net.minecraft.server.command.ServerCommandSource;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.text.Text;
import net.minecraft.util.Formatting;
import net.minecraft.util.math.BlockPos;

import java.util.Map;

/** /modcrafting studio ... */
public final class StudioCommands {
    private StudioCommands() {}

    public static void register() {
        CommandRegistrationCallback.EVENT.register((dispatcher, registryAccess, environment) -> register(dispatcher));
    }

    private static void register(CommandDispatcher<ServerCommandSource> dispatcher) {
        dispatcher.register(CommandManager.literal("modcrafting")
                .then(CommandManager.literal("studio")
                        .requires(source -> source.hasPermissionLevel(2))
                        .then(CommandManager.literal("open")
                                .then(CommandManager.argument("id", com.mojang.brigadier.arguments.StringArgumentType.word())
                                        .executes(context -> open(context, false))
                                        .then(CommandManager.literal("force").executes(context -> open(context, true)))))
                        .then(CommandManager.literal("commit")
                                .executes(context -> commit(context, null))
                                .then(CommandManager.argument("id", com.mojang.brigadier.arguments.StringArgumentType.word())
                                        .executes(context -> commit(context, com.mojang.brigadier.arguments.StringArgumentType.getString(context, "id")))))
                        .then(CommandManager.literal("apply")
                                .then(CommandManager.argument("id", com.mojang.brigadier.arguments.StringArgumentType.word())
                                        .then(CommandManager.argument("pos", net.minecraft.command.argument.BlockPosArgumentType.blockPos())
                                                .executes(context -> apply(context, false))
                                                .then(CommandManager.literal("force").executes(context -> apply(context, true))))))
                        .then(CommandManager.literal("undo").executes(StudioCommands::undo))
                        .then(CommandManager.literal("exit").executes(StudioCommands::exit))
                        .then(CommandManager.literal("teleport").executes(StudioCommands::teleport))
                        .then(CommandManager.literal("clear")
                                .executes(context -> clear(context, null, false))
                                .then(CommandManager.argument("id", com.mojang.brigadier.arguments.StringArgumentType.word())
                                        .executes(context -> clear(context, com.mojang.brigadier.arguments.StringArgumentType.getString(context, "id"), false))
                                        .then(CommandManager.literal("force").executes(context -> clear(context, com.mojang.brigadier.arguments.StringArgumentType.getString(context, "id"), true)))))
                        .then(CommandManager.literal("status").executes(StudioCommands::status))));
    }

    private static int open(CommandContext<ServerCommandSource> context, boolean force) throws CommandSyntaxException {
        ServerPlayerEntity player = context.getSource().getPlayerOrThrow();
        String id = com.mojang.brigadier.arguments.StringArgumentType.getString(context, "id");
        try {
            StudioManager.INSTANCE.open(player, id, force);
            context.getSource().sendFeedback(() -> Text.literal("已在虚空工作室打开 " + id + "。微调后执行 /modcrafting studio commit。").formatted(Formatting.GREEN), false);
            return 1;
        } catch (StudioManager.StudioException error) {
            context.getSource().sendError(Text.literal("[" + error.code + "] " + error.getMessage()));
            return 0;
        }
    }

    private static int commit(CommandContext<ServerCommandSource> context, String id) {
        try {
            StudioManager.INSTANCE.commit(id);
            context.getSource().sendFeedback(() -> Text.literal("已提交到 outbox。").formatted(Formatting.GREEN), false);
            return 1;
        } catch (StudioManager.StudioException error) {
            context.getSource().sendError(Text.literal("[" + error.code + "] " + error.getMessage()));
            return 0;
        }
    }

    private static int apply(CommandContext<ServerCommandSource> context, boolean force) throws CommandSyntaxException {
        ServerPlayerEntity player = context.getSource().getPlayerOrThrow();
        String id = com.mojang.brigadier.arguments.StringArgumentType.getString(context, "id");
        BlockPos pos = net.minecraft.command.argument.BlockPosArgumentType.getBlockPos(context, "pos");
        try {
            Map<String, Object> result = StudioManager.INSTANCE.apply(player, id, pos, force, true);
            context.getSource().sendFeedback(() -> Text.literal("已应用 " + id + " 到 " + pos.toShortString() + "。" + result.getOrDefault("apply", Map.of())).formatted(Formatting.GREEN), false);
            return 1;
        } catch (StudioManager.StudioException error) {
            context.getSource().sendError(Text.literal("[" + error.code + "] " + error.getMessage()));
            return 0;
        }
    }

    private static int undo(CommandContext<ServerCommandSource> context) {
        try {
            StudioManager.INSTANCE.undo(null);
            context.getSource().sendFeedback(() -> Text.literal("已撤销最近一次应用。").formatted(Formatting.GREEN), false);
            return 1;
        } catch (StudioManager.StudioException error) {
            context.getSource().sendError(Text.literal("[" + error.code + "] " + error.getMessage()));
            return 0;
        }
    }

    private static int exit(CommandContext<ServerCommandSource> context) throws CommandSyntaxException {
        ServerPlayerEntity player = context.getSource().getPlayerOrThrow();
        try {
            StudioManager.INSTANCE.exit(player);
            context.getSource().sendFeedback(() -> Text.literal("已退出工作室。").formatted(Formatting.GRAY), false);
            return 1;
        } catch (StudioManager.StudioException error) {
            context.getSource().sendError(Text.literal("[" + error.code + "] " + error.getMessage()));
            return 0;
        }
    }

    private static int teleport(CommandContext<ServerCommandSource> context) throws CommandSyntaxException {
        ServerPlayerEntity player = context.getSource().getPlayerOrThrow();
        try {
            StudioManager.INSTANCE.teleportToView(player);
            return 1;
        } catch (StudioManager.StudioException error) {
            context.getSource().sendError(Text.literal("[" + error.code + "] " + error.getMessage()));
            return 0;
        }
    }

    private static int clear(CommandContext<ServerCommandSource> context, String id, boolean force) {
        try {
            StudioManager.INSTANCE.clear(id, force);
            context.getSource().sendFeedback(() -> Text.literal("工位已清空。").formatted(Formatting.GRAY), false);
            return 1;
        } catch (StudioManager.StudioException error) {
            context.getSource().sendError(Text.literal("[" + error.code + "] " + error.getMessage()));
            return 0;
        }
    }

    private static int status(CommandContext<ServerCommandSource> context) {
        Map<String, Object> status = StudioManager.INSTANCE.status();
        String text = "ready=" + status.get("ready") + " phase=" + status.get("phase")
                + " build=" + status.getOrDefault("buildId", "-")
                + " size=" + status.getOrDefault("size", "-")
                + " blocks=" + status.getOrDefault("blockCount", "-")
                + " lastError=" + status.getOrDefault("lastError", "-");
        context.getSource().sendFeedback(() -> Text.literal(text), false);
        return 1;
    }
}
