/**
 * Scaffold a minimal Fabric eval project (reuses fabric-template generators).
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  FABRIC_VERSIONS,
  generateBuildGradle,
  generateGradleProperties,
  generateGradleWrapperProperties,
  generateSettingsGradle
} from '../fabric-template.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

export function defaultRuntimeRoot() {
  return path.join(root, 'runtime')
}

export function ensureRuntime(runtimeRoot = defaultRuntimeRoot()) {
  const jdkSrc = path.join(root, 'resources', 'jdk-21')
  const gradleSrc = path.join(root, 'resources', 'gradle-9.5')
  mkdirSync(runtimeRoot, { recursive: true })
  const jdkDest = path.join(runtimeRoot, 'jdk-21')
  const gradleDest = path.join(runtimeRoot, 'gradle-9.5')
  if (!existsSync(jdkDest) && existsSync(jdkSrc)) cpSync(jdkSrc, jdkDest, { recursive: true })
  if (!existsSync(gradleDest) && existsSync(gradleSrc)) cpSync(gradleSrc, gradleDest, { recursive: true })
  return { jdkDest, gradleDest, gradleSrc }
}

export function wipeDir(dir) {
  if (!existsSync(dir)) return
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  } catch (err) {
    if (err.code === 'EBUSY' || err.code === 'EPERM') {
      for (const name of readdirSync(dir)) {
        const p = path.join(dir, name)
        try {
          rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
        } catch {
          /* ignore locked children */
        }
      }
      return
    }
    throw err
  }
}

/**
 * @param {string} projectDir
 * @param {{ projectName?: string, groupId?: string, runtimeRoot?: string }} opts
 */
export function scaffoldEvalProject(projectDir, opts = {}) {
  const projectName = opts.projectName || 'evalmod'
  const groupId = opts.groupId || 'com.example'
  const pkg = 'eval_mod'
  const modId = 'evalmod'
  const runtimeRoot = opts.runtimeRoot || defaultRuntimeRoot()
  const { gradleSrc: _gradleSrc } = ensureRuntime(runtimeRoot)
  void _gradleSrc

  wipeDir(projectDir)

  const javaPath = `src/main/java/${groupId.replace(/\./g, '/')}/${pkg}`
  const clientJavaPath = `src/client/java/${groupId.replace(/\./g, '/')}/${pkg}`

  const dirs = [
    javaPath,
    clientJavaPath,
    'src/main/resources',
    'src/main/generated',
    'src/client/resources',
    `src/main/resources/assets/${modId}/lang`,
    `src/main/resources/assets/${modId}/models/item`,
    `src/main/resources/assets/${modId}/models/block`,
    `src/main/resources/assets/${modId}/blockstates`,
    `src/main/resources/data/${modId}/recipe`,
    'gradle/wrapper',
    '.modcrafting'
  ]
  for (const d of dirs) mkdirSync(path.join(projectDir, d), { recursive: true })

  const fabricModJson = {
    schemaVersion: 1,
    id: modId,
    version: '${version}',
    name: 'Eval Mod',
    description: 'OpenCode eval fixture',
    authors: ['ModCraftingEval'],
    license: 'MIT',
    environment: '*',
    entrypoints: {
      main: [`${groupId}.${pkg}.EvalMod`],
      client: [`${groupId}.${pkg}.EvalModClient`]
    },
    mixins: [`${modId}.mixins.json`],
    depends: {
      fabricloader: `>=${FABRIC_VERSIONS.loader_version}`,
      minecraft: '~1.21.4',
      java: '>=21'
    }
  }

  writeFileSync(path.join(projectDir, 'build.gradle'), generateBuildGradle(projectName, groupId), 'utf-8')
  writeFileSync(path.join(projectDir, 'settings.gradle'), generateSettingsGradle(projectName), 'utf-8')
  writeFileSync(path.join(projectDir, 'gradle.properties'), generateGradleProperties(), 'utf-8')
  writeFileSync(path.join(projectDir, 'src/main/resources/fabric.mod.json'), JSON.stringify(fabricModJson, null, 2), 'utf-8')

  writeFileSync(
    path.join(projectDir, `${javaPath}/EvalMod.java`),
    `package ${groupId}.${pkg};

import net.fabricmc.api.ModInitializer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class EvalMod implements ModInitializer {
    public static final String MOD_ID = "${modId}";
    public static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);

    @Override
    public void onInitialize() {
        ModItems.registerModItems();
        LOGGER.info("{} mod loaded", MOD_ID);
    }
}
`,
    'utf-8'
  )

  writeFileSync(
    path.join(projectDir, `${javaPath}/ModItems.java`),
    `package ${groupId}.${pkg};

import net.minecraft.item.Item;
import net.minecraft.registry.Registries;
import net.minecraft.registry.Registry;
import net.minecraft.registry.RegistryKey;
import net.minecraft.registry.RegistryKeys;
import net.minecraft.util.Identifier;

public class ModItems {
    public static final Item TEST_ITEM = register("test_item", new Item.Settings());

    private static Item register(String name, Item.Settings settings) {
        Identifier id = Identifier.of(EvalMod.MOD_ID, name);
        RegistryKey<Item> key = RegistryKey.of(RegistryKeys.ITEM, id);
        return Registry.register(Registries.ITEM, key, new Item(settings.registryKey(key)));
    }

    public static void registerModItems() {
        EvalMod.LOGGER.info("Registering items for ${modId}");
    }
}
`,
    'utf-8'
  )

  writeFileSync(
    path.join(projectDir, `${clientJavaPath}/EvalModClient.java`),
    `package ${groupId}.${pkg};
import net.fabricmc.api.ClientModInitializer;
public class EvalModClient implements ClientModInitializer {
  @Override public void onInitializeClient() {}
}
`,
    'utf-8'
  )
  writeFileSync(
    path.join(projectDir, `src/main/resources/${modId}.mixins.json`),
    JSON.stringify({ required: true, package: `${groupId}.${pkg}.mixin`, mixins: [], client: [], injectors: { defaultRequire: 1 } }, null, 2),
    'utf-8'
  )
  writeFileSync(path.join(projectDir, 'gradle/wrapper/gradle-wrapper.properties'), generateGradleWrapperProperties(), 'utf-8')
  writeFileSync(path.join(projectDir, '.gitignore'), '.gradle/\nbuild/\nrun/\n', 'utf-8')
  writeFileSync(
    path.join(projectDir, `src/main/resources/assets/${modId}/lang/en_us.json`),
    JSON.stringify({ [`item.${modId}.test_item`]: 'Test Item' }, null, 2),
    'utf-8'
  )

  const gradleRuntimeDir = 'gradle-9.5'
  const gradleLauncherJar = `gradle-launcher-${FABRIC_VERSIONS.gradle_version}.jar`
  // Point gradlew at shared runtime Gradle to avoid copying ~hundreds of MB per task
  writeFileSync(
    path.join(projectDir, 'gradlew.bat'),
    `@echo off
setlocal enabledelayedexpansion
set "MODCRAFTING_RUNTIME=${runtimeRoot.replace(/\\/g, '\\\\')}"
set "JAVA_HOME=%MODCRAFTING_RUNTIME%\\jdk-21"
set "PATH=%JAVA_HOME%\\bin;%PATH%"
set "GRADLE_USER_HOME=%MODCRAFTING_RUNTIME%\\gradle-home"
set "MC_BUNDLED_GRADLE=%MODCRAFTING_RUNTIME%\\${gradleRuntimeDir}"
"%JAVA_HOME%\\bin\\java" -Dorg.gradle.appname=gradlew -classpath "%MC_BUNDLED_GRADLE%\\lib\\${gradleLauncherJar}" org.gradle.launcher.GradleMain %*
exit /b !ERRORLEVEL!
`,
    'utf-8'
  )

  const wrapperSrc = path.join(root, 'resources', 'gradle-wrapper.jar')
  if (existsSync(wrapperSrc)) {
    cpSync(wrapperSrc, path.join(projectDir, 'gradle/wrapper/gradle-wrapper.jar'))
  }

  return {
    projectDir,
    projectName,
    groupId,
    pkg,
    modId,
    mainClass: `${groupId}.${pkg}.EvalMod`,
    runtimeRoot
  }
}