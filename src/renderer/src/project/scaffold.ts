export interface FabricVersions {
  minecraft_version: string
  loader_version: string
  fabric_version: string
  yarn_mappings: string
  loom_version: string
  gradle_version: string
}

export interface ProjectCreateConfig {
  projectDir: string
  folderName: string
  displayName: string
  modId: string
  groupId: string
  javaPackage: string
  authors: string
  description: string
  modVersion: string
  versions: FabricVersions
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export function sanitizeModId(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^-+|-+$/g, '') || 'my-mod'
}

export function sanitizeJavaPackage(modId: string): string {
  return modId.replace(/-/g, '_').replace(/[^a-z0-9_]/g, '_') || 'mymod'
}

export function mainClassName(javaPackage: string): string {
  return capitalize(javaPackage)
}

export function getMainClassFqn(config: ProjectCreateConfig): string {
  return `${config.groupId}.${config.javaPackage}.${mainClassName(config.javaPackage)}`
}

export function generateBuildGradle(config: ProjectCreateConfig): string {
  const { folderName, groupId, modId, versions } = config
  return `plugins { id 'fabric-loom' version '${versions.loom_version}'; id 'maven-publish' }
version = project.mod_version; group = "${groupId}"
base { archivesName = "${folderName}" }
repositories { mavenCentral() }
loom { splitEnvironmentSourceSets()
  runs {
    client { vmArgs "-Dfile.encoding=UTF-8" }
    server { vmArgs "-Dfile.encoding=UTF-8" }
  }
  mods { "${modId}" { sourceSet sourceSets.main; sourceSet sourceSets.client } } }
dependencies {
  minecraft "com.mojang:minecraft:\${project.minecraft_version}"
  mappings "net.fabricmc:yarn:\${project.yarn_mappings}:v2"
  modImplementation "net.fabricmc:fabric-loader:\${project.loader_version}"
  modImplementation "net.fabricmc.fabric-api:fabric-api:\${project.fabric_version}"
  modLocalRuntime fileTree(dir: "\${projectDir}/.modcrafting/base-mods", include: ["*.jar"]) }
processResources {
  inputs.property "version", project.version
  inputs.property "minecraft_version", project.minecraft_version
  inputs.property "loader_version", project.loader_version
  filteringCharset "UTF-8"
  filesMatching("fabric.mod.json") { expand "version": project.version, "minecraft_version": project.minecraft_version, "loader_version": project.loader_version } }
tasks.withType(JavaCompile).configureEach { it.options.encoding = "UTF-8"; it.options.release = 21 }
java { withSourcesJar(); sourceCompatibility = JavaVersion.VERSION_21; targetCompatibility = JavaVersion.VERSION_21 }
tasks.named("runClient").configure {
  doFirst {
    def runDir = new File(project.rootDir, "run")
    runDir.mkdirs()
    def opts = new File(runDir, "options.txt")
    if (!opts.exists()) {
      opts.text = "lang:zh_cn\\n"
    }
  }
}`
}

export function generateSettingsGradle(folderName: string): string {
  return `pluginManagement {
    repositories {
        maven {
            name = 'Fabric'
            url = uri('https://maven.fabricmc.net/')
        }
        mavenCentral()
        gradlePluginPortal()
    }
}
rootProject.name = "${folderName}"
`
}

export function generateFabricModJson(config: ProjectCreateConfig): string {
  const { modId, displayName, groupId, javaPackage, authors, description, versions } = config
  const mainCn = mainClassName(javaPackage)
  const mainEntry = `${groupId}.${javaPackage}.${mainCn}`
  const clientEntry = `${groupId}.${javaPackage}.${mainCn}Client`
  return JSON.stringify({
    schemaVersion: 1,
    id: modId,
    version: '${version}',
    name: displayName,
    description: description || 'Minecraft mod created with ModCrafting',
    authors: authors.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
    contact: {},
    license: 'MIT',
    icon: 'assets/' + modId + '/icon.png',
    environment: '*',
    entrypoints: { main: [mainEntry], client: [clientEntry] },
    mixins: [],
    depends: {
      fabricloader: `>=${versions.loader_version}`,
      minecraft: `~${versions.minecraft_version}`,
      java: '>=21'
    }
  }, null, 2)
}

export function generateMainModClass(config: ProjectCreateConfig): string {
  const { modId, groupId, javaPackage } = config
  const cn = mainClassName(javaPackage)
  return `package ${groupId}.${javaPackage};

import net.fabricmc.api.ModInitializer;
import net.minecraft.item.Item;
import net.minecraft.registry.Registries;
import net.minecraft.registry.Registry;
import net.minecraft.registry.RegistryKey;
import net.minecraft.registry.RegistryKeys;
import net.minecraft.util.Identifier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class ${cn} implements ModInitializer {
    public static final String MOD_ID = "${modId}";
    public static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);

    public static Item TEST_ITEM;

    @Override
    public void onInitialize() {
        Identifier itemId = Identifier.of(MOD_ID, "test_item");
        RegistryKey<Item> itemKey = RegistryKey.of(RegistryKeys.ITEM, itemId);
        TEST_ITEM = Registry.register(
            Registries.ITEM,
            itemKey,
            new Item(new Item.Settings().registryKey(itemKey))
        );
        LOGGER.info("{} 模组已加载！", MOD_ID);
    }
}
`
}

export function generateClientModClass(config: ProjectCreateConfig): string {
  const { groupId, javaPackage } = config
  const cn = mainClassName(javaPackage)
  return `package ${groupId}.${javaPackage};
import net.fabricmc.api.ClientModInitializer;
public class ${cn}Client implements ClientModInitializer {
  @Override public void onInitializeClient() {}
}`
}

export function generateGradleProperties(config: ProjectCreateConfig): string {
  const v = config.versions
  return `# Fabric Properties
minecraft_version=${v.minecraft_version}
loader_version=${v.loader_version}
fabric_version=${v.fabric_version}
yarn_mappings=${v.yarn_mappings}

# Mod Properties
mod_version=${config.modVersion}
maven_group=${config.groupId}
archives_base_name=${config.folderName}

# Java Settings
java_version=21

# Offline build (ModCrafting bundled cache)
org.gradle.offline=true
`
}

export function generateGradleWrapperProperties(versions: FabricVersions): string {
  return `distributionBase=GRADLE_USER_HOME
distributionPath=wrapper/dists
distributionUrl=https\\://services.gradle.org/distributions/gradle-${versions.gradle_version}-bin.zip
networkTimeout=120000
validateDistributionUrl=false
zipStoreBase=GRADLE_USER_HOME
zipStorePath=wrapper/dists
`
}

export function generateGitignore(): string {
  return `.gradle/
build/
.idea/
*.iml
.vscode/
.DS_Store
Thumbs.db
run/
*.log
`
}

export function generateLangFile(modId: string): string {
  return JSON.stringify({
    ['item.' + modId + '.test_item']: '测试物品'
  }, null, 2) + '\n'
}

export function generateItemModel(): string {
  return JSON.stringify({
    parent: 'item/generated',
    textures: { layer0: 'minecraft:item/barrier' }
  }, null, 2) + '\n'
}

export async function scaffoldProject(config: ProjectCreateConfig): Promise<void> {
  const pd = config.projectDir
  const { groupId, modId, javaPackage } = config
  const javaPath = `src/main/java/${groupId.replace(/\./g, '/')}/${javaPackage}`
  const clientJavaPath = `src/client/java/${groupId.replace(/\./g, '/')}/${javaPackage}`
  const mainCn = mainClassName(javaPackage)

  const dirs = [
    `${pd}/${javaPath}`,
    `${pd}/${clientJavaPath}`,
    `${pd}/src/main/resources`,
    `${pd}/src/client/resources`,
    `${pd}/src/main/resources/assets/${modId}/lang`,
    `${pd}/src/main/resources/assets/${modId}/models/item`,
    `${pd}/gradle/wrapper`
  ]
  for (const d of dirs) {
    await window.api.createDirectory(d)
  }

  await window.api.writeFile(`${pd}/build.gradle`, generateBuildGradle(config))
  await window.api.writeFile(`${pd}/settings.gradle`, generateSettingsGradle(config.folderName))
  await window.api.writeFile(`${pd}/gradle.properties`, generateGradleProperties(config))
  await window.api.writeFile(`${pd}/src/main/resources/fabric.mod.json`, generateFabricModJson(config))
  await window.api.writeFile(`${pd}/src/main/resources/assets/${modId}/lang/zh_cn.json`, generateLangFile(modId))
  await window.api.writeFile(`${pd}/src/main/resources/assets/${modId}/models/item/test_item.json`, generateItemModel())
  await window.api.writeFile(`${pd}/${javaPath}/${mainCn}.java`, generateMainModClass(config))
  await window.api.writeFile(`${pd}/${clientJavaPath}/${mainCn}Client.java`, generateClientModClass(config))
  await window.api.writeFile(`${pd}/gradle/wrapper/gradle-wrapper.properties`, generateGradleWrapperProperties(config.versions))
  await window.api.writeFile(`${pd}/.gitignore`, generateGitignore())
}
