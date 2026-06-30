import { FABRIC_VERSIONS } from './fabric-versions.mjs'

export { FABRIC_VERSIONS }

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export function generateBuildGradle(projectName, groupId) {
  const modId = projectName.toLowerCase().replace(/[^a-z0-9_-]/g, '-')
  return `plugins { id 'fabric-loom' version '${FABRIC_VERSIONS.loom_version}'; id 'maven-publish' }
version = project.mod_version; group = "${groupId}"
base { archivesName = "${projectName}" }
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
      opts.text = "lang:zh_cn\\nonboardAccessibility:false\\nnarrator:0\\n"
    }
  }
}`
}

export function generateSettingsGradle(projectName) {
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
rootProject.name = "${projectName}"
`
}

export function generateFabricModJson(projectName, groupId) {
  const modId = projectName.toLowerCase().replace(/[^a-z0-9_-]/g, '-')
  return JSON.stringify({
    schemaVersion: 1,
    id: modId,
    version: '${version}',
    name: capitalize(projectName.replace(/-/g, ' ')),
    description: 'Minecraft mod created with ModCrafting',
    authors: ['ModCrafting'],
    contact: {},
    license: 'MIT',
    icon: 'assets/' + modId + '/icon.png',
    environment: '*',
    entrypoints: {
      main: [`${groupId}.${projectName.replace(/-/g, '_')}.${capitalize(projectName.replace(/-/g, '_'))}`],
      client: [`${groupId}.${projectName.replace(/-/g, '_')}.${capitalize(projectName.replace(/-/g, '_'))}Client`]
    },
    mixins: [],
    depends: {
      fabricloader: `>=${FABRIC_VERSIONS.loader_version}`,
      minecraft: '~1.21.4',
      java: '>=21'
    }
  }, null, 2)
}

export function generateMainModClass(projectName, groupId, pkg) {
  const cn = capitalize(pkg)
  const modId = projectName.toLowerCase().replace(/[^a-z0-9_-]/g, '-')
  return `package ${groupId}.${pkg};

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
        LOGGER.info("{} mod loaded", MOD_ID);
    }
}
`
}

export function generateClientModClass(projectName, groupId, pkg) {
  const cn = capitalize(pkg)
  return `package ${groupId}.${pkg};
import net.fabricmc.api.ClientModInitializer;
public class ${cn}Client implements ClientModInitializer {
  @Override public void onInitializeClient() {}
}`
}

export function generateGradleProperties() {
  const v = FABRIC_VERSIONS
  return `# Fabric Properties
minecraft_version=${v.minecraft_version}
loader_version=${v.loader_version}
fabric_version=${v.fabric_version}
yarn_mappings=${v.yarn_mappings}

# Mod Properties
mod_version=1.0.0
maven_group=com.example
archives_base_name=modcrafting-mod

# Java Settings
java_version=21

# Offline build (ModCrafting bundled cache)
org.gradle.offline=true
`
}

export function generateGradleWrapperProperties() {
  return `distributionBase=GRADLE_USER_HOME
distributionPath=wrapper/dists
distributionUrl=https\\://services.gradle.org/distributions/gradle-${FABRIC_VERSIONS.gradle_version}-bin.zip
networkTimeout=120000
validateDistributionUrl=false
zipStoreBase=GRADLE_USER_HOME
zipStorePath=wrapper/dists
`
}

export function generateGradlewBat(runtimeRoot, gradleRuntimeDir, gradleLauncherJar) {
  const rt = runtimeRoot.replace(/\\/g, '\\\\')
  return `@echo off
setlocal enabledelayedexpansion
set DIRNAME=%~dp0
set "MODCRAFTING_RUNTIME=${rt}"
set "JAVA_HOME=%MODCRAFTING_RUNTIME%\\jdk-21"
set "PATH=%JAVA_HOME%\\bin;%PATH%"
set "GRADLE_USER_HOME=%MODCRAFTING_RUNTIME%\\gradle-home"
set "MC_BUNDLED_GRADLE=%DIRNAME%.modcrafting\\${gradleRuntimeDir}"
"%JAVA_HOME%\\bin\\java" -Dorg.gradle.appname=gradlew -classpath "%MC_BUNDLED_GRADLE%\\lib\\${gradleLauncherJar}" org.gradle.launcher.GradleMain %*
exit /b !ERRORLEVEL!
`
}

export async function setupPrefetchProject(projectDir, runtimeRoot, gradleSrc) {
  const { mkdirSync, writeFileSync, cpSync, existsSync, rmSync } = await import('fs')
  const pathMod = await import('path')
  const { fileURLToPath } = await import('url')

  const projectName = 'prefetch-mod'
  const groupId = 'com.example'
  const pkg = projectName.replace(/-/g, '_')
  const modId = projectName
  const javaPath = `src/main/java/${groupId.replace(/\./g, '/')}/${pkg}`
  const clientJavaPath = `src/client/java/${groupId.replace(/\./g, '/')}/${pkg}`

  if (existsSync(projectDir)) rmSync(projectDir, { recursive: true, force: true })

  mkdirSync(pathMod.join(projectDir, javaPath), { recursive: true })
  mkdirSync(pathMod.join(projectDir, clientJavaPath), { recursive: true })
  mkdirSync(pathMod.join(projectDir, 'src/main/resources'), { recursive: true })
  mkdirSync(pathMod.join(projectDir, 'src/client/resources'), { recursive: true })
  mkdirSync(pathMod.join(projectDir, `src/main/resources/assets/${modId}/lang`), { recursive: true })
  mkdirSync(pathMod.join(projectDir, `src/main/resources/assets/${modId}/models/item`), { recursive: true })
  mkdirSync(pathMod.join(projectDir, 'gradle/wrapper'), { recursive: true })
  mkdirSync(pathMod.join(projectDir, '.modcrafting'), { recursive: true })

  writeFileSync(pathMod.join(projectDir, 'build.gradle'), generateBuildGradle(projectName, groupId), 'utf-8')
  writeFileSync(pathMod.join(projectDir, 'settings.gradle'), generateSettingsGradle(projectName), 'utf-8')
  writeFileSync(pathMod.join(projectDir, 'gradle.properties'), generateGradleProperties(), 'utf-8')
  writeFileSync(pathMod.join(projectDir, 'src/main/resources/fabric.mod.json'), generateFabricModJson(projectName, groupId), 'utf-8')
  writeFileSync(pathMod.join(projectDir, `${javaPath}/${capitalize(pkg)}.java`), generateMainModClass(projectName, groupId, pkg), 'utf-8')
  writeFileSync(pathMod.join(projectDir, `${clientJavaPath}/${capitalize(pkg)}Client.java`), generateClientModClass(projectName, groupId, pkg), 'utf-8')
  writeFileSync(pathMod.join(projectDir, 'gradle/wrapper/gradle-wrapper.properties'), generateGradleWrapperProperties(), 'utf-8')
  writeFileSync(pathMod.join(projectDir, '.gitignore'), '.gradle/\nbuild/\nrun/\n', 'utf-8')

  const gradleRuntimeDir = 'gradle-9.5'
  const gradleLauncherJar = `gradle-launcher-${FABRIC_VERSIONS.gradle_version}.jar`
  writeFileSync(
    pathMod.join(projectDir, 'gradlew.bat'),
    generateGradlewBat(runtimeRoot, gradleRuntimeDir, gradleLauncherJar),
    'utf-8'
  )

  const wrapperSrc = pathMod.join(pathMod.dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'gradle-wrapper.jar')
  if (existsSync(wrapperSrc)) {
    cpSync(wrapperSrc, pathMod.join(projectDir, 'gradle/wrapper/gradle-wrapper.jar'))
  }

  const modGradle = pathMod.join(projectDir, '.modcrafting', gradleRuntimeDir)
  if (existsSync(gradleSrc)) {
    cpSync(gradleSrc, modGradle, { recursive: true })
  }

  return { gradleRuntimeDir, gradleLauncherJar }
}
