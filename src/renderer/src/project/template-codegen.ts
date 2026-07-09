import type { ProjectCreateConfig } from './scaffold.ts'
import { mainClassName } from './scaffold.ts'

export interface TemplateCodegenParams {
  config: ProjectCreateConfig
  name: string
  displayName?: string
  mcVersion?: string
  formFields?: Record<string, unknown>
}

export interface GeneratedFile {
  path: string
  content: string
}

export interface TemplateCodegenResult {
  files: GeneratedFile[]
  /** Extra registration calls to ensure exist in main initializer */
  mainInitCalls: string[]
}

function num(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : fallback
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function boolYes(value: unknown): boolean {
  return value === true || value === 'yes' || value === 'true'
}

function javaPath(config: ProjectCreateConfig): string {
  return `src/main/java/${config.groupId.replace(/\./g, '/')}/${config.javaPackage}`
}

function clientJavaPath(config: ProjectCreateConfig): string {
  return `src/client/java/${config.groupId.replace(/\./g, '/')}/${config.javaPackage}`
}

function simpleName(name: string): string {
  return name.replace(/-/g, '_')
}

function classNameFrom(name: string): string {
  const s = simpleName(name)
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export function lootTableBlockPath(modId: string, blockName: string): string {
  const id = simpleName(blockName)
  return `src/main/resources/data/${modId}/loot_table/block/${id}.json`
}

export function mergeLangEntries(existingJson: string | null, entries: Record<string, string>): string {
  let base: Record<string, string> = {}
  if (existingJson?.trim()) {
    try {
      const parsed = JSON.parse(existingJson) as Record<string, string>
      if (parsed && typeof parsed === 'object') base = { ...parsed }
    } catch {
      base = {}
    }
  }
  return JSON.stringify({ ...base, ...entries }, null, 2) + '\n'
}

function blockSoundGroup(materialStyle: string): string {
  switch (materialStyle) {
    case 'wood':
      return 'BlockSoundGroup.WOOD'
    case 'metal':
      return 'BlockSoundGroup.METAL'
    case 'crystal':
      return 'BlockSoundGroup.AMETHYST_BLOCK'
    case 'dirt':
      return 'BlockSoundGroup.GRAVEL'
    default:
      return 'BlockSoundGroup.STONE'
  }
}

function statusEffectExpr(effect: string): string | null {
  switch (effect) {
    case 'speed':
      return 'StatusEffects.SPEED'
    case 'strength':
      return 'StatusEffects.STRENGTH'
    case 'jump_boost':
      return 'StatusEffects.JUMP_BOOST'
    case 'night_vision':
      return 'StatusEffects.NIGHT_VISION'
    case 'regeneration':
      return 'StatusEffects.REGENERATION'
    default:
      return null
  }
}

function toolTypeClass(toolType: string): string {
  switch (toolType) {
    case 'pickaxe':
      return 'PickaxeItem'
    case 'axe':
      return 'AxeItem'
    case 'shovel':
      return 'ShovelItem'
    case 'hoe':
      return 'HoeItem'
    default:
      return 'SwordItem'
  }
}

function toolMaterialExpr(material: string): string {
  switch (material) {
    case 'wood':
      return 'ToolMaterials.WOOD'
    case 'stone':
      return 'ToolMaterials.STONE'
    case 'gold':
      return 'ToolMaterials.GOLD'
    case 'diamond':
      return 'ToolMaterials.DIAMOND'
    case 'netherite':
      return 'ToolMaterials.NETHERITE'
    default:
      return 'ToolMaterials.IRON'
  }
}

function armorSlotExpr(armorType: string): string {
  switch (armorType) {
    case 'helmet':
      return 'EquipmentSlot.HEAD'
    case 'leggings':
      return 'EquipmentSlot.LEGS'
    case 'boots':
      return 'EquipmentSlot.FEET'
    default:
      return 'EquipmentSlot.CHEST'
  }
}

function armorItemClass(armorType: string): string {
  switch (armorType) {
    case 'helmet':
      return 'ArmorItem.Type.HELMET'
    case 'leggings':
      return 'ArmorItem.Type.LEGGINGS'
    case 'boots':
      return 'ArmorItem.Type.BOOTS'
    default:
      return 'ArmorItem.Type.CHESTPLATE'
  }
}

function entityDimensions(size: string): { width: number; height: number } {
  switch (size) {
    case 'small':
      return { width: 0.4, height: 0.5 }
    case 'large':
      return { width: 0.9, height: 1.4 }
    case 'huge':
      return { width: 2.0, height: 2.0 }
    default:
      return { width: 0.6, height: 1.8 }
  }
}

function spawnGroup(entityType: string): string {
  switch (entityType) {
    case 'hostile':
      return 'SpawnGroup.MONSTER'
    case 'neutral':
      return 'SpawnGroup.CREATURE'
    case 'flying':
      return 'SpawnGroup.AMBIENT'
    default:
      return 'SpawnGroup.CREATURE'
  }
}

export function generateModItemsRegistrationClass(config: ProjectCreateConfig): string {
  const { groupId, javaPackage, modId } = config
  const main = mainClassName(javaPackage)
  return `package ${groupId}.${javaPackage};

import net.minecraft.item.Item;
import net.minecraft.registry.Registries;
import net.minecraft.registry.Registry;
import net.minecraft.registry.RegistryKey;
import net.minecraft.registry.RegistryKeys;
import net.minecraft.util.Identifier;

public class ModItems {
    private static Item register(String name, Item.Settings settings) {
        Identifier itemId = Identifier.of(${main}.MOD_ID, name);
        RegistryKey<Item> itemKey = RegistryKey.of(RegistryKeys.ITEM, itemId);
        return Registry.register(Registries.ITEM, itemKey, new Item(settings.registryKey(itemKey)));
    }

    public static void registerModItems() {
        ${main}.LOGGER.info("Registering items for ${modId}");
    }
}
`
}

export function generateModBlocksRegistrationClass(config: ProjectCreateConfig): string {
  const { groupId, javaPackage, modId } = config
  const main = mainClassName(javaPackage)
  return `package ${groupId}.${javaPackage};

import net.minecraft.block.Block;
import net.minecraft.registry.Registries;
import net.minecraft.registry.Registry;
import net.minecraft.registry.RegistryKey;
import net.minecraft.registry.RegistryKeys;
import net.minecraft.util.Identifier;

public class ModBlocks {
    private static Block register(String name, Block block) {
        Identifier id = Identifier.of(${main}.MOD_ID, name);
        RegistryKey<Block> key = RegistryKey.of(RegistryKeys.BLOCK, id);
        return Registry.register(Registries.BLOCK, key, block);
    }

    public static void registerModBlocks() {
        ${main}.LOGGER.info("Registering blocks for ${modId}");
    }
}
`
}

export function generateModBlockEntitiesRegistrationClass(config: ProjectCreateConfig): string {
  const { groupId, javaPackage, modId } = config
  const main = mainClassName(javaPackage)
  return `package ${groupId}.${javaPackage};

import net.minecraft.block.entity.BlockEntityType;
import net.minecraft.registry.Registries;
import net.minecraft.registry.Registry;
import net.minecraft.registry.RegistryKey;
import net.minecraft.registry.RegistryKeys;
import net.minecraft.util.Identifier;

public class ModBlockEntities {
    public static void registerModBlockEntities() {
        ${main}.LOGGER.info("Registering block entities for ${modId}");
    }
}
`
}

export function generateModEntitiesRegistrationClass(config: ProjectCreateConfig): string {
  const { groupId, javaPackage, modId } = config
  const main = mainClassName(javaPackage)
  return `package ${groupId}.${javaPackage};

import net.minecraft.entity.EntityType;
import net.minecraft.registry.Registries;
import net.minecraft.registry.Registry;
import net.minecraft.registry.RegistryKey;
import net.minecraft.registry.RegistryKeys;
import net.minecraft.util.Identifier;

public class ModEntities {
    private static <T extends net.minecraft.entity.Entity> EntityType<T> register(String name, EntityType<T> type) {
        Identifier id = Identifier.of(${main}.MOD_ID, name);
        RegistryKey<EntityType<?>> key = RegistryKey.of(RegistryKeys.ENTITY_TYPE, id);
        return Registry.register(Registries.ENTITY_TYPE, key, type);
    }

    public static void registerModEntities() {
        ${main}.LOGGER.info("Registering entities for ${modId}");
    }
}
`
}

export function generateCustomBlockBundle(input: TemplateCodegenParams): TemplateCodegenResult {
  const { config, name, displayName, formFields = {} } = input
  const { modId, groupId, javaPackage } = config
  const id = simpleName(name)
  const cls = classNameFrom(name)
  const main = mainClassName(javaPackage)
  const hardness = num(formFields.hardness, 1.5)
  const resistance = num(formFields.resistance, 6)
  const glowing = str(formFields.specialFeatures) === 'glowing'
  const particles = str(formFields.customRender) === 'particles'
  const materialStyle = str(formFields.materialStyle, 'stone')
  const luminance = glowing ? 15 : 0
  const jp = javaPath(config)

  const blockClass = particles
    ? `package ${groupId}.${javaPackage};

import net.minecraft.block.Block;
import net.minecraft.block.BlockState;
import net.minecraft.particle.ParticleTypes;
import net.minecraft.server.world.ServerWorld;
import net.minecraft.sound.BlockSoundGroup;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.random.Random;

public class ${cls}Block extends Block {
    public ${cls}Block(Settings settings) {
        super(settings);
    }

    @Override
    public void randomDisplayTick(BlockState state, net.minecraft.world.World world, BlockPos pos, Random random) {
        if (world.isClient && random.nextInt(5) == 0) {
            double x = pos.getX() + 0.5 + (random.nextDouble() - 0.5) * 0.4;
            double y = pos.getY() + 0.6;
            double z = pos.getZ() + 0.5 + (random.nextDouble() - 0.5) * 0.4;
            world.addParticleClient(ParticleTypes.END_ROD, x, y, z, 0, 0.02, 0);
        }
    }
}
`
    : `package ${groupId}.${javaPackage};

import net.minecraft.block.Block;

public class ${cls}Block extends Block {
    public ${cls}Block(Settings settings) {
        super(settings);
    }
}
`

  const modBlocks = `package ${groupId}.${javaPackage};

import net.minecraft.block.Block;
import net.minecraft.item.BlockItem;
import net.minecraft.item.Item;
import net.minecraft.registry.Registries;
import net.minecraft.registry.Registry;
import net.minecraft.registry.RegistryKey;
import net.minecraft.registry.RegistryKeys;
import net.minecraft.sound.BlockSoundGroup;
import net.minecraft.util.Identifier;

public class ModBlocks {
    public static final Block ${id.toUpperCase()} = registerBlock("${id}",
        new ${cls}Block(Block.Settings.create()
            .strength(${hardness}f, ${resistance}f)
            .sounds(${blockSoundGroup(materialStyle)})${luminance > 0 ? `\n            .luminance(state -> ${luminance})` : ''}));

    private static Block registerBlock(String name, Block block) {
        registerBlockItem(name, block);
        Identifier blockId = Identifier.of(${main}.MOD_ID, name);
        RegistryKey<Block> blockKey = RegistryKey.of(RegistryKeys.BLOCK, blockId);
        return Registry.register(Registries.BLOCK, blockKey, block);
    }

    private static void registerBlockItem(String name, Block block) {
        Identifier itemId = Identifier.of(${main}.MOD_ID, name);
        RegistryKey<Item> itemKey = RegistryKey.of(RegistryKeys.ITEM, itemId);
        BlockItem blockItem = new BlockItem(block, new Item.Settings().registryKey(itemKey).useBlockDescriptionPrefix());
        Registry.register(Registries.ITEM, itemKey, blockItem);
    }

    public static void registerModBlocks() {
        ${main}.LOGGER.info("Registering blocks for ${modId}");
    }
}
`

  const langKey = `block.${modId}.${id}`
  const lang = { [langKey]: displayName || id }

  return {
    files: [
      { path: `${jp}/${cls}Block.java`, content: blockClass },
      { path: `${jp}/ModBlocks.java`, content: modBlocks },
      {
        path: `src/main/resources/assets/${modId}/blockstates/${id}.json`,
        content: JSON.stringify({ variants: { '': { model: `${modId}:block/${id}` } } }, null, 2) + '\n'
      },
      {
        path: `src/main/resources/assets/${modId}/models/block/${id}.json`,
        content: JSON.stringify({ parent: 'block/cube_all', textures: { all: `${modId}:block/${id}` } }, null, 2) + '\n'
      },
      {
        path: `src/main/resources/assets/${modId}/models/item/${id}.json`,
        content: JSON.stringify({ parent: `${modId}:block/${id}` }, null, 2) + '\n'
      },
      {
        path: lootTableBlockPath(modId, id),
        content: JSON.stringify({
          type: 'minecraft:block',
          pools: [{ rolls: 1, entries: [{ type: 'minecraft:item', name: `${modId}:${id}` }] }]
        }, null, 2) + '\n'
      },
      { path: `src/main/resources/assets/${modId}/lang/zh_cn.json`, content: mergeLangEntries(null, lang) }
    ],
    mainInitCalls: ['ModBlocks.registerModBlocks()']
  }
}

export function generateCustomItemBundle(input: TemplateCodegenParams): TemplateCodegenResult {
  const { config, name, displayName, formFields = {} } = input
  const { modId, groupId, javaPackage } = config
  const id = simpleName(name)
  const main = mainClassName(javaPackage)
  const maxStack = Math.min(64, Math.max(1, Math.floor(num(formFields.maxStackSize, 64))))
  const jp = javaPath(config)

  const modItems = `package ${groupId}.${javaPackage};

import net.minecraft.item.Item;
import net.minecraft.registry.Registries;
import net.minecraft.registry.Registry;
import net.minecraft.registry.RegistryKey;
import net.minecraft.registry.RegistryKeys;
import net.minecraft.util.Identifier;

public class ModItems {
    public static final Item ${id.toUpperCase()} = register("${id}", new Item.Settings().maxCount(${maxStack}));

    private static Item register(String name, Item.Settings settings) {
        Identifier itemId = Identifier.of(${main}.MOD_ID, name);
        RegistryKey<Item> itemKey = RegistryKey.of(RegistryKeys.ITEM, itemId);
        return Registry.register(Registries.ITEM, itemKey, new Item(settings.registryKey(itemKey)));
    }

    public static void registerModItems() {
        ${main}.LOGGER.info("Registering items for ${modId}");
    }
}
`

  return {
    files: [
      { path: `${jp}/ModItems.java`, content: modItems },
      {
        path: `src/main/resources/assets/${modId}/models/item/${id}.json`,
        content: JSON.stringify({ parent: 'item/generated', textures: { layer0: `${modId}:item/${id}` } }, null, 2) + '\n'
      },
      {
        path: `src/main/resources/assets/${modId}/lang/zh_cn.json`,
        content: mergeLangEntries(null, { [`item.${modId}.${id}`]: displayName || id })
      }
    ],
    mainInitCalls: ['ModItems.registerModItems()']
  }
}

export function generateCustomFoodBundle(input: TemplateCodegenParams): TemplateCodegenResult {
  const { config, name, displayName, formFields = {} } = input
  const { modId, groupId, javaPackage } = config
  const id = simpleName(name)
  const main = mainClassName(javaPackage)
  const nutrition = Math.floor(num(formFields.hunger, 6))
  const saturation = num(formFields.saturation, 0.6)
  const effect = str(formFields.effect, 'none')
  const effectExpr = statusEffectExpr(effect)
  const jp = javaPath(config)

  const consumableBlock = effectExpr
    ? `
        ConsumableComponent consumable = ConsumableComponent.builder()
            .consumeSeconds(1.6f)
            .consumeEffect(new ApplyEffectsConsumeEffect(
                new StatusEffectInstance(${effectExpr}, 30 * 20, 0), 1.0f))
            .build();
        FoodComponent food = new FoodComponent.Builder()
            .nutrition(${nutrition})
            .saturationModifier(${saturation}f)
            .build();
        settings.food(food, consumable);`
    : `
        FoodComponent food = new FoodComponent.Builder()
            .nutrition(${nutrition})
            .saturationModifier(${saturation}f)
            .build();
        settings.food(food);`

  const imports = effectExpr
    ? `import net.minecraft.component.type.ConsumableComponent;
import net.minecraft.component.type.FoodComponent;
import net.minecraft.entity.effect.StatusEffectInstance;
import net.minecraft.entity.effect.StatusEffects;
import net.minecraft.item.consume.ApplyEffectsConsumeEffect;`
    : `import net.minecraft.component.type.FoodComponent;`

  const modItems = `package ${groupId}.${javaPackage};

${imports}
import net.minecraft.item.Item;
import net.minecraft.registry.Registries;
import net.minecraft.registry.Registry;
import net.minecraft.registry.RegistryKey;
import net.minecraft.registry.RegistryKeys;
import net.minecraft.util.Identifier;

public class ModItems {
    public static final Item ${id.toUpperCase()} = register("${id}");

    private static Item register(String name) {
        Identifier itemId = Identifier.of(${main}.MOD_ID, name);
        RegistryKey<Item> itemKey = RegistryKey.of(RegistryKeys.ITEM, itemId);
        Item.Settings settings = new Item.Settings().registryKey(itemKey);${consumableBlock}
        return Registry.register(Registries.ITEM, itemKey, new Item(settings));
    }

    public static void registerModItems() {
        ${main}.LOGGER.info("Registering items for ${modId}");
    }
}
`

  return {
    files: [
      { path: `${jp}/ModItems.java`, content: modItems },
      {
        path: `src/main/resources/assets/${modId}/models/item/${id}.json`,
        content: JSON.stringify({ parent: 'item/generated', textures: { layer0: `${modId}:item/${id}` } }, null, 2) + '\n'
      },
      {
        path: `src/main/resources/assets/${modId}/lang/zh_cn.json`,
        content: mergeLangEntries(null, { [`item.${modId}.${id}`]: displayName || id })
      }
    ],
    mainInitCalls: ['ModItems.registerModItems()']
  }
}

export function generateCustomToolBundle(input: TemplateCodegenParams): TemplateCodegenResult {
  const { config, name, displayName, formFields = {} } = input
  const { modId, groupId, javaPackage } = config
  const id = simpleName(name)
  const main = mainClassName(javaPackage)
  const toolType = str(formFields.toolType, 'sword')
  const toolClass = toolTypeClass(toolType)
  const material = toolMaterialExpr(str(formFields.material, 'iron'))
  const durability = Math.floor(num(formFields.durability, 250))
  const jp = javaPath(config)

  const modItems = `package ${groupId}.${javaPackage};

import net.minecraft.item.Item;
import net.minecraft.item.${toolClass};
import net.minecraft.registry.Registries;
import net.minecraft.registry.Registry;
import net.minecraft.registry.RegistryKey;
import net.minecraft.registry.RegistryKeys;
import net.minecraft.util.Identifier;

public class ModItems {
    public static final Item ${id.toUpperCase()} = register("${id}");

    private static Item register(String name) {
        Identifier itemId = Identifier.of(${main}.MOD_ID, name);
        RegistryKey<Item> itemKey = RegistryKey.of(RegistryKeys.ITEM, itemId);
        Item.Settings settings = new Item.Settings().registryKey(itemKey).maxDamage(${durability});
        ${toolClass} item = new ${toolClass}(${material}, settings);
        return Registry.register(Registries.ITEM, itemKey, item);
    }

    public static void registerModItems() {
        ${main}.LOGGER.info("Registering items for ${modId}");
    }
}
`

  return {
    files: [
      { path: `${jp}/ModItems.java`, content: modItems },
      {
        path: `src/main/resources/assets/${modId}/models/item/${id}.json`,
        content: JSON.stringify({ parent: 'item/handheld', textures: { layer0: `${modId}:item/${id}` } }, null, 2) + '\n'
      },
      {
        path: `src/main/resources/assets/${modId}/lang/zh_cn.json`,
        content: mergeLangEntries(null, { [`item.${modId}.${id}`]: displayName || id })
      }
    ],
    mainInitCalls: ['ModItems.registerModItems()']
  }
}

export function generateCustomArmorBundle(input: TemplateCodegenParams): TemplateCodegenResult {
  const { config, name, displayName, formFields = {} } = input
  const { modId, groupId, javaPackage } = config
  const id = simpleName(name)
  const main = mainClassName(javaPackage)
  const armorType = str(formFields.armorType, 'chestplate')
  const durability = Math.floor(num(formFields.durability, 240))
  const typeConst = armorItemClass(armorType)
  const jp = javaPath(config)

  const modItems = `package ${groupId}.${javaPackage};

import net.minecraft.item.ArmorItem;
import net.minecraft.item.Item;
import net.minecraft.item.equipment.ArmorMaterials;
import net.minecraft.registry.RegistryKey;
import net.minecraft.registry.RegistryKeys;
import net.minecraft.registry.Registries;
import net.minecraft.registry.Registry;
import net.minecraft.util.Identifier;

public class ModItems {
    public static final Item ${id.toUpperCase()} = register("${id}");

    private static Item register(String name) {
        Identifier itemId = Identifier.of(${main}.MOD_ID, name);
        RegistryKey<Item> itemKey = RegistryKey.of(RegistryKeys.ITEM, itemId);
        Item.Settings settings = new Item.Settings().registryKey(itemKey).maxDamage(${durability});
        ArmorItem item = new ArmorItem(ArmorMaterials.IRON, ${typeConst}, settings);
        return Registry.register(Registries.ITEM, itemKey, item);
    }

    public static void registerModItems() {
        ${main}.LOGGER.info("Registering items for ${modId}");
    }
}
`

  return {
    files: [
      { path: `${jp}/ModItems.java`, content: modItems },
      {
        path: `src/main/resources/assets/${modId}/models/item/${id}.json`,
        content: JSON.stringify({ parent: 'item/generated', textures: { layer0: `${modId}:item/${id}` } }, null, 2) + '\n'
      },
      {
        path: `src/main/resources/assets/${modId}/lang/zh_cn.json`,
        content: mergeLangEntries(null, { [`item.${modId}.${id}`]: displayName || id })
      }
    ],
    mainInitCalls: ['ModItems.registerModItems()']
  }
}

export function generateCustomEntityBundle(input: TemplateCodegenParams): TemplateCodegenResult {
  const { config, name, displayName, formFields = {} } = input
  const { modId, groupId, javaPackage } = config
  const id = simpleName(name)
  const cls = classNameFrom(name)
  const main = mainClassName(javaPackage)
  const health = num(formFields.health, 20)
  const entityType = str(formFields.entityType, 'passive')
  const size = str(formFields.size, 'normal')
  const dims = entityDimensions(size)
  const jp = javaPath(config)
  const cjp = clientJavaPath(config)

  const entityJava = `package ${groupId}.${javaPackage};

import net.minecraft.entity.EntityType;
import net.minecraft.entity.SpawnGroup;
import net.minecraft.entity.attribute.DefaultAttributeContainer;
import net.minecraft.entity.attribute.EntityAttributes;
import net.minecraft.entity.mob.PathAwareEntity;
import net.minecraft.world.World;

public class ${cls}Entity extends PathAwareEntity {
    public ${cls}Entity(EntityType<? extends PathAwareEntity> entityType, World world) {
        super(entityType, world);
    }

    public static DefaultAttributeContainer.Builder createAttributes() {
        return PathAwareEntity.createMobAttributes()
            .add(EntityAttributes.MAX_HEALTH, ${health})
            .add(EntityAttributes.MOVEMENT_SPEED, 0.25);
    }
}
`

  const modEntities = `package ${groupId}.${javaPackage};

import net.minecraft.entity.EntityType;
import net.minecraft.entity.SpawnGroup;
import net.minecraft.registry.Registries;
import net.minecraft.registry.Registry;
import net.minecraft.registry.RegistryKey;
import net.minecraft.registry.RegistryKeys;
import net.minecraft.util.Identifier;

public class ModEntities {
    public static final EntityType<${cls}Entity> ${id.toUpperCase()} = register("${id}",
        EntityType.Builder.create(${cls}Entity::new, ${spawnGroup(entityType)})
            .dimensions(${dims.width}f, ${dims.height}f)
            .build(RegistryKey.of(RegistryKeys.ENTITY_TYPE, Identifier.of(${main}.MOD_ID, "${id}"))));

    private static <T extends net.minecraft.entity.Entity> EntityType<T> register(String name, EntityType<T> type) {
        Identifier entityId = Identifier.of(${main}.MOD_ID, name);
        RegistryKey<EntityType<?>> key = RegistryKey.of(RegistryKeys.ENTITY_TYPE, entityId);
        return Registry.register(Registries.ENTITY_TYPE, key, type);
    }

    public static void registerModEntities() {
        net.fabricmc.fabric.api.object.builder.v1.entity.FabricDefaultAttributeRegistry.register(
            ${id.toUpperCase()}, ${cls}Entity.createAttributes());
        ${main}.LOGGER.info("Registering entities for ${modId}");
    }
}
`

  const clientInit = `package ${groupId}.${javaPackage};

import net.fabricmc.fabric.api.client.rendering.v1.EntityRendererRegistry;
import net.minecraft.client.render.entity.MobEntityRenderer;
import net.minecraft.client.render.entity.EntityRendererFactory;
import net.minecraft.client.render.entity.model.EntityModelLayers;
import net.minecraft.client.render.entity.model.CowEntityModel;
import net.minecraft.util.Identifier;

public class ${main}ClientEntityRenderers {
    public static void register() {
        EntityRendererRegistry.register(ModEntities.${id.toUpperCase()}, (EntityRendererFactory.Context ctx) ->
            new MobEntityRenderer<>(ctx, new CowEntityModel(ctx.getPart(EntityModelLayers.COW)), 0.7f) {
                @Override
                public Identifier getTexture(${cls}Entity entity) {
                    return Identifier.of("minecraft", "textures/entity/cow/cow.png");
                }
            });
    }
}
`

  return {
    files: [
      { path: `${jp}/${cls}Entity.java`, content: entityJava },
      { path: `${jp}/ModEntities.java`, content: modEntities },
      { path: `${cjp}/${main}ClientEntityRenderers.java`, content: clientInit },
      {
        path: `src/main/resources/assets/${modId}/lang/zh_cn.json`,
        content: mergeLangEntries(null, { [`entity.${modId}.${id}`]: displayName || id })
      }
    ],
    mainInitCalls: ['ModEntities.registerModEntities()']
  }
}

export function patchMainInitializer(content: string, mainClass: string, calls: string[]): string {
  if (!calls.length) return content
  let result = content
  for (const call of calls) {
    if (result.includes(call)) continue
    const insert = `        ${call}\n`
    if (result.includes('public void onInitialize()')) {
      result = result.replace(/(public void onInitialize\(\)\s*\{)/, `$1\n${insert}`)
    }
  }
  if (calls.some((c) => c.includes('ModEntities')) && !result.includes('ModEntities')) {
    // already inserted via call
  }
  return result
}

export function patchClientInitializer(content: string, mainClass: string): string {
  if (content.includes(`${mainClass}ClientEntityRenderers.register()`)) return content
  if (!content.includes('onInitializeClient')) return content
  return content.replace(
    /(public void onInitializeClient\(\)\s*\{)/,
    `$1\n        ${mainClass}ClientEntityRenderers.register();\n`
  )
}

export function runTemplateCodegen(input: TemplateCodegenParams & { templateId: string }): TemplateCodegenResult {
  switch (input.templateId) {
    case 'custom-block':
      return generateCustomBlockBundle(input)
    case 'custom-item':
      return generateCustomItemBundle(input)
    case 'custom-food':
      return generateCustomFoodBundle(input)
    case 'custom-tool':
      return generateCustomToolBundle(input)
    case 'custom-armor':
      return generateCustomArmorBundle(input)
    case 'custom-entity':
      return generateCustomEntityBundle(input)
    default:
      return { files: [], mainInitCalls: [] }
  }
}
