import { generateCustomBlockBundle, generateCustomFoodBundle, generateCustomItemBundle, type GeneratedAsset, type GeneratedFile } from './template-codegen.ts'
import { compileVoxel } from './voxel-codegen.ts'
import type { ContentObject } from './content-model.ts'
import { entityBoxMotion, layoutEntityBoxes, orderedEntityBoxes } from './entity-appearance.ts'
import { FABRIC_TARGET } from './domain.ts'
import { deriveResourceLayout, type ResourceLayout } from './resources/layout.ts'
import { blockModelFile, itemModelDefinitionFiles, itemModelFile } from './resources/transform.ts'
import { getRegistry } from './version/registry.ts'
import { deriveJavaApiProfile } from './version/java-profile.ts'
import { capabilitiesFor } from './version/capabilities.ts'
import { neoForgeBlockBundle, neoForgeFoodBundle, neoForgeItemBundle } from './loaders/neoforge-content.ts'
import { forgeBlockBundle, forgeFoodBundle, forgeItemBundle } from './loaders/forge-content.ts'
import { applyJavaDialect } from './version/java-dialect.ts'
import { CoreError } from './runtime.ts'

const javaFloat = (value: number) => Number.isInteger(value) ? `${value}.0f` : `${value}f`
const javaRadians = (degrees: number) => `(float) Math.toRadians(${Number.isInteger(degrees) ? `${degrees}.0` : degrees})`

/**
 * Isolate each supported object; never patch a handwritten initializer or aggregate ModItems class.
 *
 * `options.layout` defaults to the pinned target so existing callers that pass a
 * boolean keep working, but every production caller should pass the project's
 * own layout — a default in a 26.x project would emit 1.21.4 resources.
 */
export function generateContent(value: ContentObject, options: boolean | { splitClient?: boolean; layout?: ResourceLayout; loader?: string } = false): { files: GeneratedFile[]; assets: GeneratedAsset[]; main: string; client?: string; langKey: string; previewPng?: Buffer; registration?: { packageName: string; className: string } } {
  const normalized = typeof options === 'boolean' ? { splitClient: options } : options
  const splitClient = normalized.splitClient ?? false
  const loader = normalized.loader ?? 'fabric'
  const layout = normalized.layout ?? deriveResourceLayout(FABRIC_TARGET.minecraft, getRegistry())
  // The mapping kind decides both the dialect and the capability answer: 26.x uses
  // Mojang official mappings, so the Yarn-structural emitter must refuse there.
  const mappingKind = (getRegistry().cell('fabric' as 'fabric', layout.minecraft)?.release.mappings.kind ?? 'yarn') as 'yarn' | 'mojmap'
  const api = deriveJavaApiProfile(layout.minecraft, mappingKind, getRegistry())
  const [modId, name] = value.id.split(':'), p = value.parameters
  const groupId = `modcrafting.generated.${modId.replaceAll('-', '_')}.o_${name}`, pkg = groupId + '.content', folder = pkg.replaceAll('.', '/')
  // The refusal comes from the capability table with the project's real loader, so an
  // Agent sees the same answer whether it checks capabilities first or hits the generator.
  const capability = capabilitiesFor({ loader: loader as 'fabric', minecraft: layout.minecraft }, api).content[value.kind]
  if (capability.state === 'blocked') throw new CoreError('JAVA_DIALECT_UNSUPPORTED', `${capability.reason}；${capability.requirement ?? ''}`.trim())
  // Forge and NeoForge share the mapping but not the registry API, so each owns an emitter.
  if (loader === 'forge') {
    const bundle = value.kind === 'block' ? forgeBlockBundle(value, layout) : value.kind === 'food' ? forgeFoodBundle(value, layout) : forgeItemBundle(value, layout)
    return { files: bundle.files, assets: [], main: '', registration: bundle.entry, langKey: bundle.langKey }
  }
  if (loader === 'neoforge') {
    const bundle = value.kind === 'block' ? neoForgeBlockBundle(value, layout) : value.kind === 'food' ? neoForgeFoodBundle(value, layout) : neoForgeItemBundle(value, layout)
    return { files: bundle.files, assets: [], main: '', registration: bundle.entry, langKey: bundle.langKey }
  }
  const config = { modId, groupId, javaPackage: 'content' }
  const input = { config, name, displayName: value.displayName, layout, formFields: { ...p, specialFeatures: 'none', customRender: 'no', hasDurability: Number(p.durability) > 0 ? 'yes' : 'no', isMeat: 'no' } }
  const main = pkg + '.Content', java = `src/main/java/${folder}`, files: GeneratedFile[] = []
  const assets: GeneratedAsset[] = []
  let previewPng: Buffer | undefined
  let init = '', client: string | undefined
  const base = value.kind === 'block' ? generateCustomBlockBundle(input) : value.kind === 'food' ? generateCustomFoodBundle(input) : value.kind === 'entity' ? undefined : generateCustomItemBundle({ ...input, formFields: { ...input.formFields, hasDurability: 'no', maxStackSize: p.maxStackSize ?? 1 } })
  if (base) {
    files.push(...base.files.filter(file => !file.path.includes('/lang/')))
    init = base.mainInitCalls.map(call => call + ';').join('\n        ')
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index]
      if (file.path.endsWith('ModBlocks.java')) file.content = file.content.replace('Block.Settings.create()', `Block.Settings.create().registryKey(RegistryKey.of(RegistryKeys.BLOCK, Identifier.of(Content.MOD_ID, "${name}"))).luminance(state -> ${p.luminance})`)
      // Replacing the whole entry keeps path and content from the same layout.
      if (file.path.includes('/models/block/')) files[index] = blockModelFile(layout, { namespace: modId, name, parent: 'minecraft:block/cube_all', textures: { all: value.texture } })
      if (file.path.includes('/models/item/') && value.kind !== 'block') files[index] = itemModelFile(layout, { namespace: modId, name, parent: value.kind === 'tool' ? 'minecraft:item/handheld' : 'minecraft:item/generated', textures: { layer0: value.texture } })
      if (file.path.endsWith('ModItems.java') && value.kind === 'item' && Number(p.durability) > 0) file.content = file.content.replace(`.maxCount(${p.maxStackSize})`, `.maxCount(1).maxDamage(${p.durability})`)
      if (file.path.endsWith('ModItems.java') && value.kind === 'food') file.content = file.content.replace('new FoodComponent.Builder()', `new FoodComponent.Builder()${p.alwaysEdible ? '.alwaysEdible()' : ''}`).replace('new Item.Settings().registryKey(itemKey);', `new Item.Settings().registryKey(itemKey).maxCount(${p.maxStackSize});`)
    }
  }
  const voxel = value.voxel && (value.kind === 'block' || value.kind === 'item') ? compileVoxel(value, layout) : null
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
    const zombie = p.baseEntity === 'zombie', cls = zombie ? 'ZombieEntity' : 'PigEntity', entityPkg = zombie ? 'mob' : 'passive'
    const custom = value.appearance?.mode === 'custom'
    const clientFolder = `${splitClient ? 'src/client/java' : 'src/main/java'}/${folder}`
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
` })
    if (custom) {
      const boxes = value.appearance!.boxes as import('./entity-appearance.ts').EntityBox[]
      const layout = layoutEntityBoxes(boxes, value.appearance!.textureSize as import('./entity-appearance.ts').EntityTextureSize)
      const ordered = orderedEntityBoxes(boxes)
      const byId = new Map(boxes.map(box => [box.id, box]))
      const parts = ordered.map(box => {
        const region = layout.regions.find(region => region.boxId === box.id)!
        const origin = box.origin.map((value, axis) => value - box.pivot[axis])
        const parent = box.parent ? byId.get(box.parent)! : undefined
        // Only root parts receive vanilla's +24px foot offset; descendants use parent-relative pivots.
        const pivot = box.pivot.map((value, axis) => value - (parent?.pivot[axis] ?? 0) + (!parent && axis === 1 ? 24 : 0))
        return `        ModelPartData part_${box.id} = ${parent ? `part_${parent.id}` : 'root'}.addChild("${box.id}", ModelPartBuilder.create().uv(${region.u}, ${region.v})${box.mirror ? '.mirrored()' : ''}.cuboid(${origin.map(javaFloat).join(', ')}, ${box.size.map(javaFloat).join(', ')}), ModelTransform.of(${pivot.map(javaFloat).join(', ')}, ${box.rotation.map(javaRadians).join(', ')}));`
      }).join('\n')
      const fields = ordered.map(box => `    private final ModelPart part_${box.id};`).join('\n')
      const bind = ordered.map(box => `        this.part_${box.id} = ${box.parent ? `this.part_${box.parent}` : 'this.root'}.getChild("${box.id}");`).join('\n')
      const poses = ordered.flatMap(box => {
        const motion = entityBoxMotion(box)
        const swing = ({ none: '', walk_left: 'wave * 0.7f', walk_right: '-wave * 0.7f', knee_left: 'Math.max(0.0f, -wave) * 0.9f', knee_right: 'Math.max(0.0f, wave) * 0.9f', arm_left: '-wave * 0.35f', arm_right: 'wave * 0.35f' })[motion]
        return [
          ...(swing ? [`        part_${box.id}.pitch += (${swing}) * amplitude;`] : []),
          ...(box.deathRotation ?? []).flatMap((degrees, axis) => degrees ? [`        part_${box.id}.${['pitch', 'yaw', 'roll'][axis]} += ${javaRadians(degrees)} * death;`] : [])
        ]
      }).join('\n')
      files.push({ path: `${clientFolder}/ContentEntityModel.java`, content: `package ${pkg};
import net.minecraft.client.model.*;
import net.minecraft.client.render.entity.model.EntityModel;
import net.minecraft.client.render.entity.state.LivingEntityRenderState;
public class ContentEntityModel extends EntityModel<LivingEntityRenderState> {
${fields}
    public ContentEntityModel() {
        super(createTexturedModelData().createModel());
${bind}
    }
    private static TexturedModelData createTexturedModelData() {
        ModelData data = new ModelData();
        ModelPartData root = data.getRoot();
${parts}
        return TexturedModelData.of(data, ${layout.textureSize[0]}, ${layout.textureSize[1]});
    }
    @Override public void setAngles(LivingEntityRenderState state) {
        super.setAngles(state);
        float t = Math.max(0.0f, Math.min(1.0f, state.deathTime / 20.0f));
        float death = t * t * (3.0f - 2.0f * t);
        float wave = (float) Math.cos(state.limbFrequency);
        float amplitude = state.limbAmplitudeMultiplier * (1.0f - death);
${poses}
    }
}
` }, { path: `${clientFolder}/ContentEntityRenderer.java`, content: `package ${pkg};
import net.minecraft.client.render.entity.EntityRendererFactory;
import net.minecraft.client.render.entity.LivingEntityRenderer;
import net.minecraft.client.render.entity.state.LivingEntityRenderState;
import net.minecraft.util.Identifier;
public class ContentEntityRenderer extends LivingEntityRenderer<ContentEntity, LivingEntityRenderState, ContentEntityModel> {
    public ContentEntityRenderer(EntityRendererFactory.Context context) { super(context, new ContentEntityModel(), 0.5f); }
    @Override public Identifier getTexture(LivingEntityRenderState state) { return Identifier.of("${value.texture.split(':')[0]}", "textures/${value.texture.split(':')[1]}.png"); }
    @Override public LivingEntityRenderState createRenderState() { return new LivingEntityRenderState(); }
}
` })
      files.push({ path: `${clientFolder}/ContentClient.java`, content: `package ${pkg};
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.rendering.v1.EntityRendererRegistry;
public class ContentClient implements ClientModInitializer {
    public void onInitializeClient() { EntityRendererRegistry.register(ModEntities.VALUE, ContentEntityRenderer::new); }
}
` })
    } else {
      const renderer = zombie ? 'ZombieEntityRenderer' : 'PigEntityRenderer', state = zombie ? 'ZombieEntityRenderState' : 'PigEntityRenderState'
      files.push({ path: `${clientFolder}/ContentClient.java`, content: `package ${pkg};
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
    }
    init = 'ModEntities.registerModEntities();'; client = pkg + '.ContentClient'
  } else files.push(...itemModelDefinitionFiles(layout, { namespace: modId, name }))
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
  return { files: files.map(file => file.path.endsWith('.java') ? { ...file, content: applyJavaDialect(file.content, api) } : file), assets, main, client, langKey: `${value.kind === 'entity' ? 'entity' : value.kind === 'block' ? 'block' : 'item'}.${modId}.${name}`, ...(previewPng ? { previewPng } : {}) }
}
