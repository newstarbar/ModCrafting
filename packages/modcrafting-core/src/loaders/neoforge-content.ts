/**
 * NeoForge content emitter (Mojmap + DeferredRegister).
 *
 * Registration ownership: each content class owns its own `DeferredRegister` and
 * exposes `register(IEventBus)`. A generated `ContentIndex` calls them from the
 * `@Mod` constructor, so registration order is deterministic and adding content never
 * means editing `Main.java` by hand.
 *
 * Scope: item first. Block/food stay capability-blocked until each one is proven, so
 * the table never advertises a kind this file cannot emit.
 *
 * Compile verification is CI's job (the NeoForge maven is unreachable here); the
 * shape is pinned by unit tests until `probe:target --target neoforge@1.21.4` passes.
 */
import { blockLootTableFile, blockModelFile, blockstateFile, itemModelFile } from '../resources/transform.ts'
import type { ResourceLayout } from '../resources/layout.ts'
import type { ContentObject } from '../content-model.ts'

export interface NeoForgeBundle {
  files: Array<{ path: string; content: string }>
  /** Class that owns the registration; ContentIndex calls `<class>.register(bus)`. */
  entry: { packageName: string; className: string }
  langKey: string
}

const PACKAGE = (modId: string) => `modcrafting.generated.${modId.replaceAll('-', '_')}`

/** Per-object package: two items must never share one generated class. */
export function registrationFor(modId: string, value: Pick<ContentObject, 'id' | 'kind'>): { packageName: string; className: string } | null {
  if (!['item', 'block', 'food'].includes(value.kind)) return null
  const name = value.id.split(':')[1]
  return { packageName: `${PACKAGE(modId)}.o_${name}.content`, className: value.kind === 'block' ? 'ModBlocks' : 'ModItems' }
}

export function neoForgeItemBundle(value: ContentObject, layout: ResourceLayout): NeoForgeBundle {
  const [modId, name] = value.id.split(':')
  const registration = registrationFor(modId, value)!
  const pkg = registration.packageName
  const folder = pkg.replaceAll('.', '/')
  const constant = name.toUpperCase()
  const maxStack = Math.min(64, Math.max(1, Math.floor(Number(value.parameters.maxStackSize ?? 64))))
  const source = `package ${pkg};

import net.minecraft.world.item.Item;
import net.neoforged.neoforge.registries.DeferredItem;
import net.neoforged.neoforge.registries.DeferredRegister;
import net.neoforged.bus.api.IEventBus;
import ${PACKAGE(modId)}.Main;

public final class ModItems {
    public static final DeferredRegister.Items ITEMS = DeferredRegister.createItems(Main.MOD_ID);
    public static final DeferredItem<Item> ${constant} = ITEMS.registerSimpleItem("${name}", new Item.Properties().stacksTo(${maxStack}));

    private ModItems() { }

    public static void register(IEventBus bus) {
        ITEMS.register(bus);
    }
}
`
  return {
    files: [
      { path: `src/main/java/${folder}/ModItems.java`, content: source },
      itemModelFile(layout, { namespace: modId, name, parent: 'item/generated', textures: { layer0: `${modId}:item/${name}` } })
    ],
    entry: { packageName: pkg, className: 'ModItems' },
    langKey: `item.${modId}.${name}`
  }
}

/** The aggregator the `@Mod` constructor calls; regenerated from the content manifests. */
export function neoForgeContentIndex(modId: string, entries: Array<{ packageName: string; className: string }>, busImport = 'net.neoforged.bus.api.IEventBus'): string {
  const pkg = PACKAGE(modId)
  const calls = entries
    .sort((left, right) => left.packageName < right.packageName ? -1 : 1)
    .map((entry) => `        ${entry.packageName}.${entry.className}.register(modEventBus);`)
    .join('\n')
  return `package ${pkg};

import ${busImport};

/** Generated from .modcrafting/content — do not edit by hand. */
public final class ContentIndex {
    private ContentIndex() { }

    public static void register(IEventBus modEventBus) {
${calls || '        // no generated content yet'}
    }
}
`
}

const SOUNDS: Record<string, string> = { stone: 'STONE', wood: 'WOOD', gravel: 'GRAVEL', grass: 'GRASS', sand: 'SAND', glass: 'GLASS', metal: 'METAL', wool: 'WOOL' }

export function neoForgeBlockBundle(value: ContentObject, layout: ResourceLayout): NeoForgeBundle {
  const [modId, name] = value.id.split(':')
  const pkg = `${PACKAGE(modId)}.o_${name}.content`
  const folder = pkg.replaceAll('.', '/')
  const constant = name.toUpperCase()
  const hardness = Number(value.parameters.hardness ?? 1.5)
  const resistance = Number(value.parameters.resistance ?? 6)
  const luminance = Math.max(0, Math.min(15, Math.floor(Number(value.parameters.luminance ?? 0))))
  const sound = SOUNDS[String(value.parameters.materialStyle ?? 'stone')] ?? 'STONE'
  const source = `package ${pkg};

import net.minecraft.world.item.BlockItem;
import net.minecraft.world.item.Item;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.SoundType;
import net.minecraft.world.level.block.state.BlockBehaviour;
import net.neoforged.bus.api.IEventBus;
import net.neoforged.neoforge.registries.DeferredBlock;
import net.neoforged.neoforge.registries.DeferredItem;
import net.neoforged.neoforge.registries.DeferredRegister;
import ${PACKAGE(modId)}.Main;

public final class ModBlocks {
    public static final DeferredRegister.Blocks BLOCKS = DeferredRegister.createBlocks(Main.MOD_ID);
    public static final DeferredRegister.Items ITEMS = DeferredRegister.createItems(Main.MOD_ID);

    public static final DeferredBlock<Block> ${constant} = BLOCKS.register("${name}",
        () -> new Block(BlockBehaviour.Properties.of()
            .strength(${hardness}f, ${resistance}f)${luminance > 0 ? `\n            .lightLevel(state -> ${luminance})` : ''}
            .sound(SoundType.${sound})));
    public static final DeferredItem<BlockItem> ${constant}_BLOCK_ITEM = ITEMS.registerSimpleBlockItem("${name}", ${constant});

    private ModBlocks() { }

    public static void register(IEventBus bus) {
        BLOCKS.register(bus);
        ITEMS.register(bus);
    }
}
`
  return {
    files: [
      { path: `src/main/java/${folder}/ModBlocks.java`, content: source },
      blockstateFile(layout, { namespace: modId, name, model: `${modId}:block/${name}` }),
      blockModelFile(layout, { namespace: modId, name, parent: 'block/cube_all', textures: { all: `${modId}:block/${name}` } }),
      itemModelFile(layout, { namespace: modId, name, parent: `${modId}:block/${name}` }),
      blockLootTableFile(layout, { namespace: modId, name, item: `${modId}:${name}` })
    ],
    entry: { packageName: pkg, className: 'ModBlocks' },
    langKey: `block.${modId}.${name}`
  }
}

export function neoForgeFoodBundle(value: ContentObject, layout: ResourceLayout): NeoForgeBundle {
  const [modId, name] = value.id.split(':')
  const pkg = `${PACKAGE(modId)}.o_${name}.content`
  const folder = pkg.replaceAll('.', '/')
  const constant = name.toUpperCase()
  const hunger = Math.max(1, Math.floor(Number(value.parameters.hunger ?? 4)))
  const saturation = Number(value.parameters.saturation ?? 0.3)
  const stack = Math.min(64, Math.max(1, Math.floor(Number(value.parameters.maxStackSize ?? 64))))
  // alwaysEdible lives on the consumable component from 1.20.5 on; the builder here
  // only carries nutrition, so that flag is reported as unsupported instead of faked.
  const source = `package ${pkg};

import net.minecraft.world.food.FoodProperties;
import net.minecraft.world.item.Item;
import net.neoforged.bus.api.IEventBus;
import net.neoforged.neoforge.registries.DeferredItem;
import net.neoforged.neoforge.registries.DeferredRegister;
import ${PACKAGE(modId)}.Main;

public final class ModItems {
    public static final DeferredRegister.Items ITEMS = DeferredRegister.createItems(Main.MOD_ID);
    public static final DeferredItem<Item> ${constant} = ITEMS.register("${name}",
        () -> new Item(new Item.Properties()
            .stacksTo(${stack})
            .food(new FoodProperties.Builder().nutrition(${hunger}).saturationModifier(${saturation}f).build())));

    private ModItems() { }

    public static void register(IEventBus bus) {
        ITEMS.register(bus);
    }
}
`
  return {
    files: [
      { path: `src/main/java/${folder}/ModItems.java`, content: source },
      itemModelFile(layout, { namespace: modId, name, parent: 'item/generated', textures: { layer0: `${modId}:item/${name}` } })
    ],
    entry: { packageName: pkg, className: 'ModItems' },
    langKey: `item.${modId}.${name}`
  }
}
