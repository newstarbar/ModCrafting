---
name: fabric-mod-development
description: Develop, inspect, scaffold, build, and diagnose Fabric 1.21.4 mods with ModCrafting's local MCP tools.
---

Use this skill for a Fabric 1.21.4 mod project on Windows.

1. Start with `modcrafting_environment_status` and `fabric_project_inspect`.
2. Before registering a block, item, entity, enchantment, or recipe, call `minecraft_data_lookup` for every vanilla ID and property used. Do not invent IDs or hardness, resistance, stack-size, or enchantment data from memory.
3. Use `fabric_docs_search` for Fabric APIs and `mc_wiki_search` for game concepts.
4. Make narrow edits with Codex's normal file tools, then call `fabric_validate` and start `fabric_build_start(task="build")`.
5. Poll with `fabric_job_status`; interpret failures from Gradle output before attempting another edit.

The plugin never downloads JDK or Gradle. Require system JDK 21 and the project's `gradlew.bat`.
