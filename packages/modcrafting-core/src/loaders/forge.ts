/**
 * Forge platform layer (structural).
 *
 * Forge differs from NeoForge in three load-bearing ways, so it gets its own module
 * instead of a flag on the NeoForge one: ForgeGradle instead of ModDevGradle,
 * `mods.toml` instead of `neoforge.mods.toml`, and `FMLJavaModLoadingContext` for the
 * event bus. Mapping is Mojang official, same as NeoForge.
 *
 * Content emitters are not wired yet: Forge's registry API (`DeferredRegister.create`,
 * `RegistryObject`) differs from NeoForge's typed helpers, so the kinds stay
 * capability-blocked until each is emitted and probed.
 */
import type { ResolvedTarget } from '../version/targets.ts'
import type { PlatformProjectFiles } from './neoforge.ts'

export function forgeProjectFiles(target: ResolvedTarget, modId: string, modName: string): PlatformProjectFiles {
  const forge = target.release.loaderVersion
  const pluginVersion = target.release.build?.pluginVersion ?? '6.0.54'
  const javaMajor = target.release.javaTarget
  const pkg = `modcrafting.generated.${modId.replaceAll('-', '_')}`
  const javaRoot = `src/main/java/${pkg.replaceAll('.', '/')}`
  const major = forge.split('.')[0]
  const properties = `minecraft_version=${target.minecraft}\nforge_version=${forge}\n`
  // ForgeGradle is published on maven.minecraftforge.net, not on the Gradle plugin
  // portal — probed 2026-11-19: without this repository the plugin cannot resolve.
  const settings = `pluginManagement {
    repositories {
        maven { url = 'https://maven.minecraftforge.net/' }
        gradlePluginPortal()
        mavenCentral()
    }
}
rootProject.name = '${modId}'
`
  // ForgeGradle resolves the plugin from the plugin portal; the toolchain is explicit
  // because Forge targets 17 for 1.20.x and 21/25 for newer milestones.
  const build = `plugins { id 'net.minecraftforge.gradle' version '[${pluginVersion},6.2)' }
version = '0.1.0'
group = '${modId}'
base { archivesName = '${modId}' }
java { toolchain { languageVersion = JavaLanguageVersion.of(${javaMajor}) } }
minecraft {
    mappings channel: 'official', version: '${target.minecraft}'
}
dependencies { minecraft 'net.minecraftforge:forge:${target.minecraft}-${forge}' }
`
  // Forge's metadata uses `mandatory` instead of NeoForge's `type`, and depends on `forge`.
  const metadata = `modLoader = "javafml"
loaderVersion = "[${major},)"
license = "MIT"

[[mods]]
modId = "${modId}"
version = "0.1.0"
displayName = "${modName}"

[[dependencies.${modId}]]
modId = "forge"
mandatory = true
versionRange = "[${forge},)"
ordering = "NONE"
side = "BOTH"

[[dependencies.${modId}]]
modId = "minecraft"
mandatory = true
versionRange = "[${target.minecraft},)"
ordering = "NONE"
side = "BOTH"
`
  const main = `package ${pkg};

import net.minecraftforge.eventbus.api.IEventBus;
import net.minecraftforge.fml.common.Mod;
import net.minecraftforge.fml.javafmlmod.FMLJavaModLoadingContext;

@Mod(Main.MOD_ID)
public class Main {
    public static final String MOD_ID = "${modId}";

    public Main() {
        IEventBus modEventBus = FMLJavaModLoadingContext.get().getModEventBus();
        ContentIndex.register(modEventBus);
    }
}
`
  const index = `package ${pkg};

import net.minecraftforge.eventbus.api.IEventBus;

/** Generated from .modcrafting/content — do not edit by hand. */
public final class ContentIndex {
    private ContentIndex() { }

    public static void register(IEventBus modEventBus) {
        // no generated content yet
    }
}
`
  return {
    mainClass: `${pkg}.Main`,
    files: [
      { path: 'gradle.properties', content: properties },
      { path: 'settings.gradle', content: settings },
      { path: 'build.gradle', content: build },
      { path: 'src/main/resources/META-INF/mods.toml', content: metadata },
      { path: `${javaRoot}/Main.java`, content: main },
      { path: `${javaRoot}/ContentIndex.java`, content: index },
      { path: '.gitignore', content: '.modcrafting/\nrun/\n' }
    ]
  }
}
