import { generateCustomBlockBundle, generateCustomFoodBundle, generateCustomItemBundle, type GeneratedAsset, type GeneratedFile } from './template-codegen.ts'
import { compileVoxel } from './voxel-codegen.ts'
import type { ContentObject } from './content-model.ts'

/** Isolate each supported object; never patch a handwritten initializer or aggregate ModItems class. */
export function generateContent(value: ContentObject, splitClient = false): { files: GeneratedFile[]; assets: GeneratedAsset[]; main: string; client?: string; langKey: string; previewPng?: Buffer } {
  const [modId, name] = value.id.split(':'), p = value.parameters
  const groupId = `modcrafting.generated.${modId.replaceAll('-', '_')}.o_${name}`, pkg = groupId + '.content', folder = pkg.replaceAll('.', '/')
  const config = { modId, groupId, javaPackage: 'content' }
  const input = { config, name, displayName: value.displayName, mcVersion: '1.21.4', formFields: { ...p, specialFeatures: 'none', customRender: 'no', hasDurability: Number(p.durability) > 0 ? 'yes' : 'no', isMeat: 'no' } }
  const main = pkg + '.Content', java = `src/main/java/${folder}`, files: GeneratedFile[] = []
  const assets: GeneratedAsset[] = []
  let previewPng: Buffer | undefined
  let init = '', client: string | undefined
  const base = value.kind === 'block' ? generateCustomBlockBundle(input) : value.kind === 'food' ? generateCustomFoodBundle(input) : value.kind === 'entity' ? undefined : generateCustomItemBundle({ ...input, formFields: { ...input.formFields, hasDurability: 'no', maxStackSize: p.maxStackSize ?? 1 } })
  if (base) {
    files.push(...base.files.filter(file => !file.path.includes('/lang/')))
    init = base.mainInitCalls.map(call => call + ';').join('\n        ')
    for (const file of files) {
      if (file.path.includes('/loot_table/block/')) file.path = file.path.replace('/loot_table/block/', '/loot_table/blocks/')
      if (file.path.endsWith('ModBlocks.java')) file.content = file.content.replace('Block.Settings.create()', `Block.Settings.create().registryKey(RegistryKey.of(RegistryKeys.BLOCK, Identifier.of(Content.MOD_ID, "${name}"))).luminance(state -> ${p.luminance})`)
      if (file.path.includes('/models/block/')) file.content = JSON.stringify({ parent: 'minecraft:block/cube_all', textures: { all: value.texture } }, null, 2) + '\n'
      if (file.path.includes('/models/item/') && value.kind !== 'block') file.content = JSON.stringify({ parent: value.kind === 'tool' ? 'minecraft:item/handheld' : 'minecraft:item/generated', textures: { layer0: value.texture } }, null, 2) + '\n'
      if (file.path.endsWith('ModItems.java') && value.kind === 'item' && Number(p.durability) > 0) file.content = file.content.replace(`.maxCount(${p.maxStackSize})`, `.maxCount(1).maxDamage(${p.durability})`)
      if (file.path.endsWith('ModItems.java') && value.kind === 'food') file.content = file.content.replace('new FoodComponent.Builder()', `new FoodComponent.Builder()${p.alwaysEdible ? '.alwaysEdible()' : ''}`).replace('new Item.Settings().registryKey(itemKey);', `new Item.Settings().registryKey(itemKey).maxCount(${p.maxStackSize});`)
    }
  }
  const voxel = value.voxel && (value.kind === 'block' || value.kind === 'item') ? compileVoxel(value) : null
  if (voxel) {
    for (const model of voxel.models) {
      const target = files.find(file => file.path === model.path)
      if (target) target.content = model.content
    }
    assets.push(...voxel.assets)
    previewPng = voxel.previewPng
  }
  if (value.kind === 'tool' || value.kind === 'armor') {
    const imports = 'import net.minecraft.item.*;\nimport net.minecraft.item.equipment.*;\nimport java.util.Map;'
    let construction: string
    if (value.kind === 'tool') {
      const cls = ({ sword: 'SwordItem', pickaxe: 'PickaxeItem', axe: 'AxeItem', shovel: 'ShovelItem', hoe: 'HoeItem' } as Record<string, string>)[String(p.toolType)]
      construction = `ToolMaterial base = ToolMaterial.${String(p.material).toUpperCase()};
        ToolMaterial material = new ToolMaterial(base.incorrectBlocksForDrops(), ${p.durability}, ${p.miningSpeed}f, 0f, base.enchantmentValue(), base.repairItems());
        Item item = new ${cls}(material, ${p.attackDamage}f, ${p.attackSpeed}f, settings);`
    } else {
      const type = String(p.armorType).toUpperCase()
      construction = `ArmorMaterial base = ArmorMaterials.${String(p.material).toUpperCase()};
        ArmorMaterial material = new ArmorMaterial(base.durability(), Map.of(EquipmentType.${type}, ${p.protection}), base.enchantmentValue(), base.equipSound(), ${p.toughness}f, ${p.knockbackResistance}f, base.repairIngredient(), base.assetId());
        Item item = new Item(material.applySettings(settings, EquipmentType.${type}).maxDamage(${p.durability}));`
    }
    const target = files.find(file => file.path.endsWith('/ModItems.java'))!
    target.content = `package ${pkg};
${imports}
import net.minecraft.registry.*;
import net.minecraft.util.Identifier;
public class ModItems {
    public static final Item VALUE = register();
    private static Item register() {
        Identifier id = Identifier.of(Content.MOD_ID, "${name}");
        RegistryKey<Item> key = RegistryKey.of(RegistryKeys.ITEM, id);
        Item.Settings settings = new Item.Settings().registryKey(key);
        ${construction}
        return Registry.register(Registries.ITEM, key, item);
    }
    public static void registerModItems() {}
}
`
  }
  if (value.kind === 'entity') {
    const zombie = p.baseEntity === 'zombie', cls = zombie ? 'ZombieEntity' : 'PigEntity', entityPkg = zombie ? 'mob' : 'passive', renderer = zombie ? 'ZombieEntityRenderer' : 'PigEntityRenderer', state = zombie ? 'ZombieEntityRenderState' : 'PigEntityRenderState'
    files.push({ path: `${java}/ContentEntity.java`, content: `package ${pkg};
import net.minecraft.entity.*;
import net.minecraft.entity.${entityPkg}.${cls};
import net.minecraft.world.World;
public class ContentEntity extends ${cls} {
    public ContentEntity(EntityType<? extends ${cls}> type, World world) { super(type, world); }
}
` }, { path: `${java}/ModEntities.java`, content: `package ${pkg};
import net.minecraft.entity.*;
import net.minecraft.entity.${entityPkg}.${cls};
import net.minecraft.entity.attribute.EntityAttributes;
import net.minecraft.registry.*;
import net.minecraft.util.Identifier;
import net.fabricmc.fabric.api.object.builder.v1.entity.FabricDefaultAttributeRegistry;
public class ModEntities {
    public static final EntityType<ContentEntity> VALUE = register();
    private static EntityType<ContentEntity> register() {
        RegistryKey<EntityType<?>> key = RegistryKey.of(RegistryKeys.ENTITY_TYPE, Identifier.of(Content.MOD_ID, "${name}"));
        return Registry.register(Registries.ENTITY_TYPE, key, EntityType.Builder.create(ContentEntity::new, SpawnGroup.${zombie ? 'MONSTER' : 'CREATURE'}).dimensions(${zombie ? '0.6f, 1.95f' : '0.9f, 0.9f'}).build(key));
    }
    public static void registerModEntities() {
        FabricDefaultAttributeRegistry.register(VALUE, ${cls}.${zombie ? 'createZombieAttributes' : 'createPigAttributes'}().add(EntityAttributes.MAX_HEALTH, ${p.health}).add(EntityAttributes.MOVEMENT_SPEED, ${p.movementSpeed}).add(EntityAttributes.ATTACK_DAMAGE, ${p.attackDamage}));
    }
}
` }, { path: `${splitClient ? 'src/client/java' : 'src/main/java'}/${folder}/ContentClient.java`, content: `package ${pkg};
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.rendering.v1.EntityRendererRegistry;
import net.minecraft.client.render.entity.${renderer};
import net.minecraft.client.render.entity.state.${state};
import net.minecraft.util.Identifier;
public class ContentClient implements ClientModInitializer {
    public void onInitializeClient() {
        EntityRendererRegistry.register(ModEntities.VALUE, context -> new ${renderer}(context) {
            @Override public Identifier getTexture(${state} state) { return Identifier.of("${value.texture.split(':')[0]}", "textures/${value.texture.split(':')[1]}.png"); }
        });
    }
}
` })
    init = 'ModEntities.registerModEntities();'; client = pkg + '.ContentClient'
  } else files.push({ path: `src/main/resources/assets/${modId}/items/${name}.json`, content: JSON.stringify({ model: { type: 'minecraft:model', model: `${modId}:item/${name}` } }, null, 2) + '\n' })
  files.push({ path: `${java}/Content.java`, content: `package ${pkg};
import net.fabricmc.api.ModInitializer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
public class Content implements ModInitializer {
    public static final String MOD_ID = "${modId}";
    public static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);
    public void onInitialize() { ${init} }
}
` })
  return { files, assets, main, client, langKey: `${value.kind === 'entity' ? 'entity' : value.kind === 'block' ? 'block' : 'item'}.${modId}.${name}`, ...(previewPng ? { previewPng } : {}) }
}
