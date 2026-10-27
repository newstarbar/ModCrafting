package com.modcrafting.builder;

import net.minecraft.block.Block;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.entity.player.PlayerAbilities;
import net.minecraft.nbt.NbtCompound;
import net.minecraft.nbt.NbtElement;
import net.minecraft.nbt.NbtList;
import net.minecraft.network.packet.s2c.play.PositionFlag;
import net.minecraft.registry.RegistryEntryLookup;
import net.minecraft.registry.RegistryKey;
import net.minecraft.registry.RegistryKeys;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.server.world.ServerWorld;
import net.minecraft.structure.StructurePlacementData;
import net.minecraft.structure.StructureTemplate;
import net.minecraft.text.ClickEvent;
import net.minecraft.text.MutableText;
import net.minecraft.text.Text;
import net.minecraft.util.BlockMirror;
import net.minecraft.util.BlockRotation;
import net.minecraft.util.Formatting;
import net.minecraft.util.Identifier;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Vec3i;
import net.minecraft.util.math.random.Random;
import net.minecraft.world.GameMode;
import net.minecraft.world.World;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/** Single-plot server-side studio. All mutating methods must run on the server thread. */
public final class StudioManager {
    public static final StudioManager INSTANCE = new StudioManager();
    public static final RegistryKey<World> STUDIO_WORLD = RegistryKey.of(RegistryKeys.WORLD, Identifier.of("modcrafting_builder", "studio"));
    private static final BlockPos PLOT_ORIGIN = new BlockPos(0, 64, 0);
    private static final int MAX_AXIS = 192;
    private static final int MAX_VOLUME = 4_000_000;
    private static final int MAX_UNDO = 5;
    private static final int FLAGS = Block.NOTIFY_ALL | Block.FORCE_STATE | Block.SKIP_DROPS;

    private final Object lock = new Object();
    private final Deque<String> undoStack = new ArrayDeque<>();
    private MinecraftServer server;
    private ServerWorld studioWorld;
    private String buildId;
    private Vec3i size = new Vec3i(0, 0, 0);
    private BlockPos origin = PLOT_ORIGIN;
    private int blockCount;
    private String baselineHash = "";
    private String phase = "idle";
    private String lastCommitHash;
    private String lastCommitAt;
    private String lastError;
    private PlayerReturn returnState;

    private StudioManager() {}

    public void onServerStarted(MinecraftServer server) {
        synchronized (lock) {
            this.server = server;
            this.studioWorld = server.getWorld(STUDIO_WORLD);
            this.phase = studioWorld == null ? "dimension_missing" : "idle";
            if (studioWorld == null) {
                ModCraftingBuilder.LOGGER.error("Studio dimension {} did not load. Check the builder data pack and Minecraft version.", STUDIO_WORLD.getValue());
            } else {
                ModCraftingBuilder.LOGGER.info("Studio dimension ready: {}", STUDIO_WORLD.getValue());
            }
        }
    }

    public void onServerStopping() {
        synchronized (lock) {
            this.server = null;
            this.studioWorld = null;
            this.returnState = null;
            this.phase = "stopped";
        }
    }

    public void tick(MinecraftServer server) {
        ServerWorld world;
        synchronized (lock) {
            world = studioWorld;
        }
        if (world == null) return;
        for (ServerPlayerEntity player : world.getPlayers()) {
            if (player.getY() < world.getBottomY() + 16) {
                teleportToViewInternal(player);
            }
        }
    }

    public Map<String, Object> status() {
        synchronized (lock) {
            return statusLocked();
        }
    }

    public ServerPlayerEntity activePlayerOrThrow() {
        synchronized (lock) {
            ServerPlayerEntity player = currentPlayer();
            if (player == null) throw fail("PLAYER_REQUIRED", "需要一个在线玩家来执行这个操作。");
            return player;
        }
    }

    public Map<String, Object> open(ServerPlayerEntity player, String id, boolean force) {
        synchronized (lock) {
            requireReady();
            try {
                StudioFiles.validateId(id);
                Path inbox = StudioFiles.inbox(server.getRunDirectory(), id);
                Path structureFile = StudioFiles.structure(inbox);
                Map<String, Object> manifest = StudioFiles.readManifest(StudioFiles.manifest(inbox));
                String expected = StudioFiles.text(manifest, "sha256");
                if (expected != null && !expected.equals(StudioFiles.sha256(structureFile))) {
                    throw fail("HASH_MISMATCH", "结构文件与 manifest 的 sha256 不一致，请重新生成。");
                }
                StructureTemplate template = loadTemplate(structureFile);
                Vec3i nextSize = template.getSize();
                validateSize(nextSize);
                if (this.buildId != null && this.size.getX() > 0) {
                    String current = hashPlot();
                    if (!current.equals(baselineHash) && !force) {
                        throw fail("STUDIO_DIRTY", "当前工位有未提交的游戏内修改；先 /modcrafting studio commit，或加 force 放弃。");
                    }
                }
                if (returnState == null || !returnState.playerId.equals(player.getUuid())) {
                    returnState = PlayerReturn.of(player, server, studioWorld);
                }
                if (this.buildId != null && this.size.getX() > 0) {
                    clearBox(studioWorld, origin, size);
                }
                clearBox(studioWorld, PLOT_ORIGIN, nextSize);
                StructurePlacementData placement = placement(false);
                if (!template.place(studioWorld, PLOT_ORIGIN, PLOT_ORIGIN, placement, Random.create(0L), FLAGS)) {
                    throw fail("PLACE_FAILED", "结构放置返回失败。");
                }
                this.buildId = id;
                this.size = nextSize;
                this.origin = PLOT_ORIGIN;
                this.blockCount = countNonAir(studioWorld, origin, size);
                this.baselineHash = hashPlot();
                this.phase = "ready";
                this.lastError = null;
                studioWorld.setWeather(0, 0, false, false);
                teleportToViewInternal(player);
                sendStudioMessage(player);
                return statusLocked();
            } catch (StudioException error) {
                throw error;
            } catch (Exception error) {
                throw fail("OPEN_FAILED", String.valueOf(error));
            }
        }
    }

    public Map<String, Object> commit(String id) {
        synchronized (lock) {
            requireReady();
            if (buildId == null || size.getX() <= 0) throw fail("NO_ACTIVE_BUILD", "工作室里没有打开的 build。");
            if (id != null && !id.equals(buildId)) throw fail("BUILD_MISMATCH", "当前打开的是 " + buildId + "，不是 " + id + "。");
            try {
                StructureTemplate template = new StructureTemplate();
                template.saveFromWorld(studioWorld, origin, size, false, null);
                NbtCompound nbt = template.writeNbt(new NbtCompound());
                filterAir(nbt);
                Path outbox = StudioFiles.outbox(server.getRunDirectory(), buildId);
                Path file = StudioFiles.structure(outbox);
                StudioFiles.writeNbt(file, nbt);
                String hash = hashPlot();
                int count = countNonAir(studioWorld, origin, size);
                Map<String, Object> manifest = new LinkedHashMap<>();
                manifest.put("version", 1);
                manifest.put("buildId", buildId);
                manifest.put("size", List.of(size.getX(), size.getY(), size.getZ()));
                manifest.put("blockCount", count);
                manifest.put("hash", hash);
                manifest.put("sha256", StudioFiles.sha256(file));
                manifest.put("createdAt", Instant.now().toString());
                StudioFiles.writeManifest(StudioFiles.manifest(outbox), manifest);
                this.blockCount = count;
                this.baselineHash = hash;
                this.lastCommitHash = hash;
                this.lastCommitAt = Instant.now().toString();
                this.lastError = null;
                Map<String, Object> out = statusLocked();
                out.put("commit", manifest);
                return out;
            } catch (StudioException error) {
                throw error;
            } catch (Exception error) {
                throw fail("COMMIT_FAILED", String.valueOf(error));
            }
        }
    }

    public Map<String, Object> apply(ServerPlayerEntity player, String id, BlockPos requestedPos, boolean force, boolean teleport) {
        synchronized (lock) {
            requireReady();
            try {
                StudioFiles.validateId(id);
                Path inbox = StudioFiles.inbox(server.getRunDirectory(), id);
                StructureTemplate template = loadTemplate(StudioFiles.structure(inbox));
                Vec3i targetSize = template.getSize();
                validateSize(targetSize);
                PlayerReturn previous = returnState;
                ServerWorld targetWorld;
                BlockPos targetPos;
                if (player.getServerWorld() == studioWorld) {
                    targetWorld = previous != null ? server.getWorld(previous.dimension) : server.getOverworld();
                    if (targetWorld == null) targetWorld = server.getOverworld();
                    targetPos = requestedPos != null ? requestedPos : previous != null ? new BlockPos((int) previous.x, (int) previous.y, (int) previous.z) : targetWorld.getSpawnPos();
                } else {
                    targetWorld = player.getServerWorld();
                    targetPos = requestedPos != null ? requestedPos : player.getBlockPos();
                }
                if (targetWorld.getRegistryKey().equals(STUDIO_WORLD)) throw fail("TARGET_STUDIO", "不能应用到虚空维度本身。");
                if (targetPos.getY() < targetWorld.getBottomY() || targetPos.getY() + targetSize.getY() - 1 > targetWorld.getTopYInclusive()) {
                    throw fail("TARGET_OUT_OF_BOUNDS", "目标区域超出世界高度。");
                }
                preloadChunks(targetWorld, targetPos, targetSize);
                Scan scan = scanNonAir(targetWorld, targetPos, targetSize);
                if (scan.count > 0 && !force) {
                    throw fail("TARGET_OCCUPIED", "目标区域有 " + scan.count + " 个非空气方块（示例：" + scan.samples + "）；确认后加 force。");
                }
                StructureTemplate old = new StructureTemplate();
                old.saveFromWorld(targetWorld, targetPos, targetSize, false, null);
                NbtCompound oldNbt = old.writeNbt(new NbtCompound());
                filterAir(oldNbt);
                String token = StudioFiles.randomToken().substring(0, 16);
                Path undoDir = StudioFiles.undo(server.getRunDirectory(), token);
                StudioFiles.writeNbt(StudioFiles.structure(undoDir), oldNbt);
                Map<String, Object> meta = new LinkedHashMap<>();
                meta.put("token", token);
                meta.put("dimension", targetWorld.getRegistryKey().getValue().toString());
                meta.put("x", targetPos.getX());
                meta.put("y", targetPos.getY());
                meta.put("z", targetPos.getZ());
                meta.put("size", List.of(targetSize.getX(), targetSize.getY(), targetSize.getZ()));
                meta.put("blockCount", scan.count);
                meta.put("createdAt", Instant.now().toString());
                StudioFiles.writeManifest(StudioFiles.manifest(undoDir), meta);
                clearBox(targetWorld, targetPos, targetSize);
                if (!template.place(targetWorld, targetPos, targetPos, placement(true), Random.create(0L), FLAGS)) {
                    throw fail("PLACE_FAILED", "结构放置返回失败。");
                }
                undoStack.addLast(token);
                while (undoStack.size() > MAX_UNDO) undoStack.removeFirst();
                if (teleport) teleportToBuild(player, targetWorld, targetPos, targetSize);
                Map<String, Object> out = statusLocked();
                Map<String, Object> applied = new LinkedHashMap<>();
                applied.put("token", token);
                applied.put("dimension", targetWorld.getRegistryKey().getValue().toString());
                applied.put("x", targetPos.getX());
                applied.put("y", targetPos.getY());
                applied.put("z", targetPos.getZ());
                applied.put("cleared", scan.count);
                out.put("apply", applied);
                player.sendMessage(Text.literal("ModCrafting: 已应用，撤销 token=" + token).formatted(Formatting.GREEN), false);
                return out;
            } catch (StudioException error) {
                throw error;
            } catch (Exception error) {
                throw fail("APPLY_FAILED", String.valueOf(error));
            }
        }
    }

    public Map<String, Object> undo(String token) {
        synchronized (lock) {
            requireReady();
            try {
                String selected = token != null && !token.isBlank() ? token : undoStack.peekLast();
                if (selected == null) throw fail("NO_UNDO", "没有可撤销的应用记录。");
                StudioFiles.validateId(selected);
                Path dir = StudioFiles.undo(server.getRunDirectory(), selected);
                Map<String, Object> meta = StudioFiles.readManifest(StudioFiles.manifest(dir));
                String dimension = StudioFiles.text(meta, "dimension");
                Integer x = StudioFiles.integer(meta, "x");
                Integer y = StudioFiles.integer(meta, "y");
                Integer z = StudioFiles.integer(meta, "z");
                if (dimension == null || x == null || y == null || z == null) throw fail("UNDO_INVALID", "撤销记录不完整。");
                Identifier identifier = Identifier.tryParse(dimension);
                if (identifier == null) throw fail("UNDO_INVALID", "撤销记录的世界无效。");
                ServerWorld world = server.getWorld(RegistryKey.of(RegistryKeys.WORLD, identifier));
                if (world == null) throw fail("UNDO_WORLD_MISSING", "撤销目标世界当前未加载。");
                StructureTemplate old = loadTemplate(StudioFiles.structure(dir));
                Vec3i oldSize = old.getSize();
                BlockPos pos = new BlockPos(x, y, z);
                preloadChunks(world, pos, oldSize);
                clearBox(world, pos, oldSize);
                Integer storedCount = StudioFiles.integer(meta, "blockCount");
                int oldCount = storedCount != null ? storedCount : StudioFiles.readNbt(StudioFiles.structure(dir)).getList("blocks", NbtElement.COMPOUND_TYPE).size();
                if (oldCount > 0 && !old.place(world, pos, pos, placement(true), Random.create(0L), FLAGS)) {
                    throw fail("PLACE_FAILED", "撤销结构放置失败。");
                }
                undoStack.remove(selected);
                Map<String, Object> out = statusLocked();
                out.put("undo", Map.of("token", selected, "dimension", dimension, "x", x, "y", y, "z", z));
                return out;
            } catch (StudioException error) {
                throw error;
            } catch (Exception error) {
                throw fail("UNDO_FAILED", String.valueOf(error));
            }
        }
    }

    public Map<String, Object> exit(ServerPlayerEntity player) {
        synchronized (lock) {
            requireReady();
            PlayerReturn state = returnState;
            if (state == null) throw fail("NO_RETURN", "当前没有记录进入工作室前的位置。");
            try {
                ServerWorld world = server.getWorld(state.dimension);
                if (world == null) world = server.getOverworld();
                player.teleport(world, state.x, state.y, state.z, Set.of(), state.yaw, state.pitch, false);
                player.changeGameMode(state.gameMode);
                PlayerAbilities abilities = player.getAbilities();
                abilities.allowFlying = state.allowFlying;
                abilities.flying = state.flying;
                abilities.invulnerable = state.invulnerable;
                player.sendAbilitiesUpdate();
                player.setVelocity(0, 0, 0);
                returnState = null;
                player.sendMessage(Text.literal("ModCrafting: 已退出工作室").formatted(Formatting.GRAY), false);
                return statusLocked();
            } catch (Exception error) {
                throw fail("EXIT_FAILED", String.valueOf(error));
            }
        }
    }

    public Map<String, Object> clear(String id, boolean force) {
        synchronized (lock) {
            requireReady();
            if (buildId == null) throw fail("NO_ACTIVE_BUILD", "工作室里没有打开的 build。");
            if (id != null && !id.equals(buildId)) throw fail("BUILD_MISMATCH", "当前打开的是 " + buildId + "。");
            String current = hashPlot();
            if (!current.equals(baselineHash) && !force) throw fail("STUDIO_DIRTY", "工位有未提交的修改；先 commit 或加 force。");
            clearBox(studioWorld, origin, size);
            this.blockCount = 0;
            this.baselineHash = hashPlot();
            this.phase = "ready";
            this.lastError = null;
            return statusLocked();
        }
    }

    public Map<String, Object> teleportToView(ServerPlayerEntity player) {
        synchronized (lock) {
            requireReady();
            teleportToViewInternal(player);
            return statusLocked();
        }
    }

    private void teleportToViewInternal(ServerPlayerEntity player) {
        if (studioWorld == null) return;
        double x;
        double z;
        double y;
        if (size.getX() > 0) {
            x = origin.getX() + size.getX() / 2.0 + 0.5;
            z = origin.getZ() + size.getZ() + Math.max(6.0, size.getZ() / 2.0);
            y = origin.getY() + size.getY() + 6.0;
        } else {
            x = 0.5;
            z = 8.5;
            y = 80.0;
        }
        y = Math.min(y, studioWorld.getTopYInclusive() - 2.0);
        player.teleport(studioWorld, x, y, z, Set.of(), 180.0f, 20.0f, false);
        player.setVelocity(0, 0, 0);
        if (player.interactionManager.getGameMode() != GameMode.CREATIVE) player.changeGameMode(GameMode.CREATIVE);
        PlayerAbilities abilities = player.getAbilities();
        abilities.allowFlying = true;
        abilities.flying = true;
        player.sendAbilitiesUpdate();
    }

    private void teleportToBuild(ServerPlayerEntity player, ServerWorld world, BlockPos start, Vec3i box) {
        double x = start.getX() + box.getX() / 2.0 + 0.5;
        double z = start.getZ() + box.getZ() + Math.max(6.0, box.getZ() / 2.0);
        double y = Math.min(start.getY() + box.getY() + 4.0, world.getTopYInclusive() - 2.0);
        player.teleport(world, x, y, z, Set.of(), 180.0f, 20.0f, false);
        player.setVelocity(0, 0, 0);
    }

    private void sendStudioMessage(ServerPlayerEntity player) {
        MutableText message = Text.literal("ModCrafting 工作室：").formatted(Formatting.GOLD)
                .append(Text.literal(buildId + " " + size.getX() + "x" + size.getY() + "x" + size.getZ()).formatted(Formatting.WHITE));
        message = message.append(Text.literal("  "));
        message = message.append(Text.literal("[提交]").styled(style -> style.withColor(Formatting.GREEN).withClickEvent(new ClickEvent(ClickEvent.Action.RUN_COMMAND, "/modcrafting studio commit " + buildId))));
        message = message.append(Text.literal("  "));
        message = message.append(Text.literal("[退出]").styled(style -> style.withColor(Formatting.YELLOW).withClickEvent(new ClickEvent(ClickEvent.Action.RUN_COMMAND, "/modcrafting studio exit"))));
        player.sendMessage(message, false);
    }

    private StructureTemplate loadTemplate(Path file) throws IOException {
        NbtCompound nbt = StudioFiles.readNbt(file);
        StructureTemplate template = new StructureTemplate();
        RegistryEntryLookup<Block> blocks = server.getRegistryManager().getOrThrow(RegistryKeys.BLOCK);
        template.readNbt(blocks, nbt);
        Vec3i value = template.getSize();
        if (value.getX() < 1 || value.getY() < 1 || value.getZ() < 1) throw fail("INVALID_STRUCTURE", "结构尺寸无效。");
        return template;
    }

    private void validateSize(Vec3i value) {
        int x = value.getX();
        int y = value.getY();
        int z = value.getZ();
        if (x < 1 || y < 1 || z < 1) throw fail("INVALID_STRUCTURE", "结构尺寸必须大于 0。");
        if (x > MAX_AXIS || y > MAX_AXIS || z > MAX_AXIS) throw fail("SIZE_LIMIT", "结构单轴不能超过 " + MAX_AXIS + "。");
        if ((long) x * y * z > MAX_VOLUME) throw fail("SIZE_LIMIT", "结构体积超过 " + MAX_VOLUME + "。");
        if (studioWorld != null && PLOT_ORIGIN.getY() + y - 1 > studioWorld.getTopYInclusive()) throw fail("SIZE_LIMIT", "结构高度超出虚空世界。");
    }

    private StructurePlacementData placement(boolean updateNeighbors) {
        return new StructurePlacementData()
                .setIgnoreEntities(true)
                .setUpdateNeighbors(updateNeighbors)
                .setRotation(BlockRotation.NONE)
                .setMirror(BlockMirror.NONE);
    }

    private void preloadChunks(ServerWorld world, BlockPos start, Vec3i box) {
        if (box.getX() < 1 || box.getZ() < 1) return;
        int minChunkX = start.getX() >> 4;
        int maxChunkX = (start.getX() + box.getX() - 1) >> 4;
        int minChunkZ = start.getZ() >> 4;
        int maxChunkZ = (start.getZ() + box.getZ() - 1) >> 4;
        for (int chunkX = minChunkX; chunkX <= maxChunkX; chunkX++) {
            for (int chunkZ = minChunkZ; chunkZ <= maxChunkZ; chunkZ++) {
                world.getChunk(chunkX, chunkZ);
            }
        }
    }

    private void clearBox(ServerWorld world, BlockPos start, Vec3i box) {
        if (box.getX() < 1 || box.getY() < 1 || box.getZ() < 1) return;
        preloadChunks(world, start, box);
        BlockPos.Mutable pos = new BlockPos.Mutable();
        int maxX = start.getX() + box.getX();
        int maxY = start.getY() + box.getY();
        int maxZ = start.getZ() + box.getZ();
        for (int y = start.getY(); y < maxY; y++) {
            for (int z = start.getZ(); z < maxZ; z++) {
                for (int x = start.getX(); x < maxX; x++) {
                    pos.set(x, y, z);
                    if (!world.getBlockState(pos).isAir()) world.setBlockState(pos, Blocks.AIR.getDefaultState(), FLAGS);
                }
            }
        }
    }

    private int countNonAir(ServerWorld world, BlockPos start, Vec3i box) {
        int count = 0;
        BlockPos.Mutable pos = new BlockPos.Mutable();
        int maxX = start.getX() + box.getX();
        int maxY = start.getY() + box.getY();
        int maxZ = start.getZ() + box.getZ();
        for (int y = start.getY(); y < maxY; y++) {
            for (int z = start.getZ(); z < maxZ; z++) {
                for (int x = start.getX(); x < maxX; x++) {
                    pos.set(x, y, z);
                    if (!world.getBlockState(pos).isAir()) count++;
                }
            }
        }
        return count;
    }

    private Scan scanNonAir(ServerWorld world, BlockPos start, Vec3i box) {
        int count = 0;
        List<String> samples = new ArrayList<>();
        BlockPos.Mutable pos = new BlockPos.Mutable();
        int maxX = start.getX() + box.getX();
        int maxY = start.getY() + box.getY();
        int maxZ = start.getZ() + box.getZ();
        for (int y = start.getY(); y < maxY; y++) {
            for (int z = start.getZ(); z < maxZ; z++) {
                for (int x = start.getX(); x < maxX; x++) {
                    pos.set(x, y, z);
                    if (!world.getBlockState(pos).isAir()) {
                        count++;
                        if (samples.size() < 5) samples.add(x + "," + y + "," + z);
                    }
                }
            }
        }
        return new Scan(count, String.join("; ", samples));
    }

    private String hashPlot() {
        if (studioWorld == null || size.getX() < 1) return "";
        MessageDigest digest = StudioFiles.digest();
        BlockPos.Mutable pos = new BlockPos.Mutable();
        int maxX = origin.getX() + size.getX();
        int maxY = origin.getY() + size.getY();
        int maxZ = origin.getZ() + size.getZ();
        for (int y = origin.getY(); y < maxY; y++) {
            for (int z = origin.getZ(); z < maxZ; z++) {
                for (int x = origin.getX(); x < maxX; x++) {
                    pos.set(x, y, z);
                    BlockState state = studioWorld.getBlockState(pos);
                    if (!state.isAir()) digest.update((x + "," + y + "," + z + "," + state + "\n").getBytes(StandardCharsets.UTF_8));
                }
            }
        }
        return HexFormat.of().formatHex(digest.digest());
    }

    private void filterAir(NbtCompound nbt) {
        NbtList palette = nbt.getList("palette", NbtElement.COMPOUND_TYPE);
        NbtList blocks = nbt.getList("blocks", NbtElement.COMPOUND_TYPE);
        if (palette.isEmpty() || blocks.isEmpty()) return;
        NbtList kept = new NbtList();
        for (int index = 0; index < blocks.size(); index++) {
            NbtCompound entry = blocks.getCompound(index);
            int state = entry.getInt("state");
            if (state < 0 || state >= palette.size()) continue;
            String name = palette.getCompound(state).getString("Name");
            if (name.equals("minecraft:air") || name.equals("minecraft:cave_air") || name.equals("minecraft:void_air")) continue;
            kept.add(entry);
        }
        nbt.put("blocks", kept);
    }

    private Map<String, Object> statusLocked() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("ready", studioWorld != null);
        out.put("protocol", 1);
        out.put("dimension", STUDIO_WORLD.getValue().toString());
        out.put("phase", phase);
        out.put("active", buildId != null);
        if (buildId != null) {
            out.put("buildId", buildId);
            out.put("size", List.of(size.getX(), size.getY(), size.getZ()));
            if (size.getX() > 0) {
                Map<String, Object> bounds = new LinkedHashMap<>();
                bounds.put("minX", origin.getX());
                bounds.put("minY", origin.getY());
                bounds.put("minZ", origin.getZ());
                bounds.put("maxX", origin.getX() + size.getX() - 1);
                bounds.put("maxY", origin.getY() + size.getY() - 1);
                bounds.put("maxZ", origin.getZ() + size.getZ() - 1);
                out.put("bounds", bounds);
            }
            out.put("blockCount", blockCount);
            out.put("canCommit", true);
        }
        out.put("undoCount", undoStack.size());
        if (lastCommitHash != null) out.put("lastCommit", Map.of("hash", lastCommitHash, "at", lastCommitAt));
        if (lastError != null) out.put("lastError", lastError);
        ServerPlayerEntity player = currentPlayer();
        if (player != null) {
            Map<String, Object> value = new LinkedHashMap<>();
            value.put("name", player.getName().getString());
            value.put("dimension", player.getServerWorld().getRegistryKey().getValue().toString());
            value.put("x", player.getX());
            value.put("y", player.getY());
            value.put("z", player.getZ());
            out.put("player", value);
        }
        return out;
    }

    private ServerPlayerEntity currentPlayer() {
        if (server == null) return null;
        List<ServerPlayerEntity> players = server.getPlayerManager().getPlayerList();
        for (ServerPlayerEntity player : players) {
            if (player.getServerWorld() == studioWorld) return player;
        }
        return players.isEmpty() ? null : players.get(0);
    }

    private void requireReady() {
        if (server == null) throw fail("SERVER_NOT_READY", "服务端尚未启动。");
        if (studioWorld == null) throw fail("DIMENSION_MISSING", "虚空维度 modcrafting_builder:studio 未加载；检查 builder mod 与数据包。");
    }

    private StudioException fail(String code, String message) {
        this.lastError = code + ": " + message;
        return new StudioException(code, message);
    }

    private record Scan(int count, String samples) {}

    public static final class StudioException extends RuntimeException {
        public final String code;

        public StudioException(String code, String message) {
            super(message);
            this.code = code;
        }
    }

    private static final class PlayerReturn {
        final UUID playerId;
        final RegistryKey<World> dimension;
        final double x;
        final double y;
        final double z;
        final float yaw;
        final float pitch;
        final GameMode gameMode;
        final boolean allowFlying;
        final boolean flying;
        final boolean invulnerable;

        private PlayerReturn(UUID playerId, RegistryKey<World> dimension, double x, double y, double z, float yaw, float pitch, GameMode gameMode, boolean allowFlying, boolean flying, boolean invulnerable) {
            this.playerId = playerId;
            this.dimension = dimension;
            this.x = x;
            this.y = y;
            this.z = z;
            this.yaw = yaw;
            this.pitch = pitch;
            this.gameMode = gameMode;
            this.allowFlying = allowFlying;
            this.flying = flying;
            this.invulnerable = invulnerable;
        }

        static PlayerReturn of(ServerPlayerEntity player, MinecraftServer server, ServerWorld studioWorld) {
            boolean inStudio = player.getServerWorld() == studioWorld;
            ServerWorld world = inStudio ? server.getOverworld() : player.getServerWorld();
            BlockPos pos = inStudio ? world.getSpawnPos() : player.getBlockPos();
            PlayerAbilities abilities = player.getAbilities();
            return new PlayerReturn(player.getUuid(), world.getRegistryKey(), pos.getX(), pos.getY(), pos.getZ(), player.getYaw(), player.getPitch(), player.interactionManager.getGameMode(), abilities.allowFlying, abilities.flying, abilities.invulnerable);
        }
    }
}
