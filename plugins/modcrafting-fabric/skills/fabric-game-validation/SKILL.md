---
name: fabric-game-validation
description: Validate Fabric 1.21.4 gameplay changes with Observer V2 and deterministic ModCrafting game tests.
---

Use this skill when a Fabric change needs in-game evidence.

1. Build successfully, then use `minecraft_run_client` and poll `minecraft_runtime_status` until Observer V2 is ready.
2. Use `minecraft_snapshot`, `minecraft_command`, and `minecraft_input` only against the running local instance.
3. Submit a V2 test through `minecraft_test_start`. Its spec must include setup, actions, assertions, and cleanup.
4. Tests run only in `ModCrafting Test World` and the reserved test region. Never use a developer's ordinary world for automated cleanup.
5. Treat `PASS` as all structured assertions passing; use `FAIL` for observed product failures and `INCONCLUSIVE` for unavailable bridge capabilities, visual-only claims, or environment failures. A screenshot or command dispatch alone is not PASS.
