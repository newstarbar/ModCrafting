# ModCrafting Builder

Server-side Fabric 1.21.4 companion mod for the ModCrafting building studio.

It registers a data-driven void dimension (`modcrafting_builder:studio`), a small command set, and a loopback HTTP API used by the ModCrafting plugin. The dimension contains only the active build; the player edits it in vanilla creative mode and commits the result back to the plugin.

## Build

Requires JDK 21 and the repository Gradle wrapper:

```powershell
cd builder-mod
.\gradlew.bat build --no-daemon
```

The runtime jar is `build/libs/modcrafting-builder-0.1.0.jar`.

## Commands

```
/modcrafting studio open <buildId> [force]
/modcrafting studio commit [buildId]
/modcrafting studio apply <buildId> <pos> [force]
/modcrafting studio undo
/modcrafting studio exit
/modcrafting studio clear [buildId] [force]
/modcrafting studio status
```

Commands require permission level 2. In singleplayer the integrated server loads the mod automatically; on a dedicated server install it on the server only. A vanilla client can join and use the dimension because the dimension is data-driven.

## Boundaries

- Does not write a user's real save; the ModCrafting plugin applies builds only to its session-owned test world and exports `.schem` / `.nbt` files.
- One active studio plot at a time. Opening another build clears the previous plot after a dirty check.
- Entities are not copied; block entities are preserved through the structure NBT.
- HTTP binds to `127.0.0.1` with a random bearer token and is intended for the local ModCrafting plugin.
