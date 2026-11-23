/**
 * NeoForge platform layer: structural project output (ModDevGradle).
 *
 * This is the loader boundary the capability table points to. It produces a
 * project an Agent can hand to the user and extend — build files, platform
 * metadata (`neoforge.mods.toml`) and a `@Mod` registration skeleton — while the
 * *content* Java emitter is still Fabric/Yarn-only, so content capabilities stay
 * blocked until the Mojmap emitter lands.
 *
 * Compile verification is pending: the NeoForge maven is unreachable from this
 * machine, so the build evidence stays `declared` until a probe runs somewhere
 * with access.
 */
import type { ResolvedTarget } from '../version/targets.ts'
import { neoForgeContentIndex } from './neoforge-content.ts'

export interface PlatformProjectFiles {
  files: Array<{ path: string; content: string }>
  /** The class that carries `@Mod`, for platform metadata wiring. */
  mainClass: string
}

export function neoForgeProjectFiles(target: ResolvedTarget, modId: string, modName: string): PlatformProjectFiles {
  const neoforge = target.release.loaderVersion
  const pluginId = target.release.build?.pluginId ?? 'net.neoforged.moddev'
  const pluginVersion = target.release.build?.pluginVersion ?? ''
  const javaMajor = target.release.javaTarget
  const pkg = `modcrafting.generated.${modId.replaceAll('-', '_')}`
  const javaRoot = `src/main/java/${pkg.replaceAll('.', '/')}`
  // gradle.properties keeps minecraft_version even though ModDevGradle derives the
  // Minecraft version from the NeoForge version: every downstream tool (layout,
  // knowledge lookup, capability table) reads this property instead of parsing TOML.
  const properties = `minecraft_version=${target.minecraft}\nneoforge_version=${neoforge}\n`
  const settings = `rootProject.name = '${modId}'\n`
  const build = `plugins { id '${pluginId}' version '${pluginVersion}' }
version = '0.1.0'
group = '${modId}'
base { archivesName = '${modId}' }
repositories { mavenCentral() }
java { toolchain { languageVersion = JavaLanguageVersion.of(${javaMajor}) } }
neoForge { version = '${neoforge}' }
`
  const metadata = `modLoader = "javafml"
loaderVersion = "[${target.release.javaTarget},)"
license = "MIT"

[[mods]]
modId = "${modId}"
version = "0.1.0"
displayName = "${modName}"

[[dependencies.${modId}]]
modId = "neoforge"
type = "required"
versionRange = "[${neoforge},)"
ordering = "NONE"
side = "BOTH"

[[dependencies.${modId}]]
modId = "minecraft"
type = "required"
versionRange = "[${target.minecraft},)"
ordering = "NONE"
side = "BOTH"
`
  // DeferredRegister containers live in the content classes; ContentIndex is the single
  // aggregation point the @Mod constructor calls, so content is added without editing Main.
  const main = `package ${pkg};

import net.neoforged.bus.api.IEventBus;
import net.neoforged.fml.common.Mod;

@Mod(Main.MOD_ID)
public class Main {
    public static final String MOD_ID = "${modId}";

    public Main(IEventBus modEventBus) {
        ContentIndex.register(modEventBus);
    }
}
`
  return {
    mainClass: `${pkg}.Main`,
    files: [
      { path: 'gradle.properties', content: properties },
      { path: 'settings.gradle', content: settings },
      { path: 'build.gradle', content: build },
      { path: 'src/main/resources/META-INF/neoforge.mods.toml', content: metadata },
      { path: `${javaRoot}/Main.java`, content: main },
      { path: `${javaRoot}/ContentIndex.java`, content: neoForgeContentIndex(modId, []) },
      { path: '.gitignore', content: '.modcrafting/\nrun/\n' }
    ]
  }
}
