/**
 * Forge content emitter (Mojang official mappings + Forge registry API).
 *
 * Forge and NeoForge share the mapping, not the registry API: Forge uses untyped
 * `DeferredRegister.create(ForgeRegistries.ITEMS, MOD_ID)` and `RegistryObject<T>`,
 * while NeoForge exposes typed helpers (`DeferredItem`, `registerSimpleItem`). That is
 * why the two emitters are separate files instead of one with a flag.
 *
 * Same registration contract as NeoForge: each content class owns its registers and
 * exposes `register(IEventBus)`; ContentIndex calls them from the `@Mod` constructor.
 */
import type { ContentObject } from '../content-model.ts'
import type { ResourceLayout } from '../resources/layout.ts'
import { blockLootTableFile, blockModelFile, blockstateFile, itemModelFile } from '../resources/transform.ts'

export interface ForgeBundle {
  files: Array<{ path: string; content: string }>
  entry: { packageName: string; className: string }
  langKey: string
}

const PACKAGE = (modId: string) => `modcrafting.generated.${modId.replaceAll('-', '_')}`

export function forgeRegistrationFor(modId: string, value: Pick<ContentObject, 'id' | 'kind'>): { packageName: string; className: string } | null {
  if (!['item', 'block', 'food'].includes(value.kind)) return null
  const name = value.id.split(':')[1]
  return { packageName: `${PACKAGE(modId)}.o_${name}.content`, className: value.kind === 'block' ? 'ModBlocks' : 'ModItems' }
}

const SOUNDS: Record<string, string> = { stone: 'STONE', wood: 'WOOD', gravel: 'GRAVEL', grass: 'GRASS', sand: 'SAND', glass: 'GLASS', metal: 'METAL', wool: 'WOOL' }

export function forgeItemBundle(value: ContentObject, layout: ResourceLayout): ForgeBundle {
  const [modId, name] = value.id.split(':')
  const entry = forgeRegistrationFor(modId, value)!
  const folder = entry.packageName.replaceAll('.', '/')
  const constant = name.toUpperCase()
  const maxStack = Math.min(64, Math.max(1, Math.floor(Number(value.parameters.maxStackSize ?? 64))))
  const source = `package ${entry.packageName};

import net.minecraft.world.item.Item;
import net.minecraftforge.eventbus.api.IEventBus;
import net.minecraftforge.registries.DeferredRegister;
import net.minecraftforge.registries.ForgeRegistries;
import net.minecraftforge.registries.RegistryObject;
import ${PACKAGE(modId)}.Main;

public final class ModItems {
    public static final DeferredRegister<Item> ITEMS = DeferredRegister.create(ForgeRegistries.ITEMS, Main.MOD_ID);
    public static final RegistryObject<Item> ${constant} = ITEMS.register("${name}", () -> new Item(new Item.Properties().stacksTo(${maxStack})));

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
    entry,
    langKey: `item.${modId}.${name}`
  }
}

export function forgeBlockBundle(value: ContentObject, layout: ResourceLayout): ForgeBundle {
  const [modId, name] = value.id.split(':')
  const entry = forgeRegistrationFor(modId, value)!
  const folder = entry.packageName.replaceAll('.', '/')
  const constant = name.toUpperCase()
  const hardness = Number(value.parameters.hardness ?? 1.5)
  const resistance = Number(value.parameters.resistance ?? 6)
  const luminance = Math.max(0, Math.min(15, Math.floor(Number(value.parameters.luminance ?? 0))))
  const sound = SOUNDS[String(value.parameters.materialStyle ?? 'stone')] ?? 'STONE'
  const source = `package ${entry.packageName};

import net.minecraft.world.item.BlockItem;
import net.minecraft.world.item.Item;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.SoundType;
import net.minecraft.world.level.block.state.BlockBehaviour;
import net.minecraftforge.eventbus.api.IEventBus;
import net.minecraftforge.registries.DeferredRegister;
import net.minecraftforge.registries.ForgeRegistries;
import net.minecraftforge.registries.RegistryObject;
import ${PACKAGE(modId)}.Main;

public final class ModBlocks {
    public static final DeferredRegister<Block> BLOCKS = DeferredRegister.create(ForgeRegistries.BLOCKS, Main.MOD_ID);
    public static final DeferredRegister<Item> ITEMS = DeferredRegister.create(ForgeRegistries.ITEMS, Main.MOD_ID);

    public static final RegistryObject<Block> ${constant} = BLOCKS.register("${name}",
        () -> new Block(BlockBehaviour.Properties.of()
            .strength(${hardness}f, ${resistance}f)${luminance > 0 ? `\n            .lightLevel(state -> ${luminance})` : ''}
            .sound(SoundType.${sound})));
    public static final RegistryObject<BlockItem> ${constant}_ITEM = ITEMS.register("${name}",
        () -> new BlockItem(${constant}.get(), new Item.Properties()));

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
    entry,
    langKey: `block.${modId}.${name}`
  }
}

export function forgeFoodBundle(value: ContentObject, layout: ResourceLayout): ForgeBundle {
  const [modId, name] = value.id.split(':')
  const entry = forgeRegistrationFor(modId, value)!
  const folder = entry.packageName.replaceAll('.', '/')
  const constant = name.toUpperCase()
  const hunger = Math.max(1, Math.floor(Number(value.parameters.hunger ?? 4)))
  const saturation = Number(value.parameters.saturation ?? 0.3)
  const stack = Math.min(64, Math.max(1, Math.floor(Number(value.parameters.maxStackSize ?? 64))))
  const source = `package ${entry.packageName};

import net.minecraft.world.food.FoodProperties;
import net.minecraft.world.item.Item;
import net.minecraftforge.eventbus.api.IEventBus;
import net.minecraftforge.registries.DeferredRegister;
import net.minecraftforge.registries.ForgeRegistries;
import net.minecraftforge.registries.RegistryObject;
import ${PACKAGE(modId)}.Main;

public final class ModItems {
    public static final DeferredRegister<Item> ITEMS = DeferredRegister.create(ForgeRegistries.ITEMS, Main.MOD_ID);
    public static final RegistryObject<Item> ${constant} = ITEMS.register("${name}",
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
    entry,
    langKey: `item.${modId}.${name}`
  }
}
