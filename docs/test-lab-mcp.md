# ModCrafting Test Lab MCP

Test Lab is a development-only, deterministic application test harness. It starts a real Electron process with an isolated `userData` directory, drives the same semantic commands used by the UI, and records structured evidence. It is not included in normal user configuration or packaged releases.

## Start the MCP server

```powershell
npm run build
npm run test:mcp:serve
```

The server uses stdio: stdout is reserved for MCP protocol messages and diagnostics go to stderr. Register `node --experimental-strip-types scripts/mcp/modcrafting-test-mcp.ts` as a local development MCP command.

## Test flow

1. `modcrafting_launch` starts a new Electron process with `--automation` and a unique profile.
2. `modcrafting_configure_provider` supplies an in-memory local replay endpoint for deterministic tests.
3. `modcrafting_open_project` copies a fixture into the run sandbox before opening it. It never opens the original fixture in place.
4. `modcrafting_send_turn`, `modcrafting_wait`, and `modcrafting_snapshot` exercise the real Controller and React lifecycle.
5. `modcrafting_run_scenario` evaluates ordered event, tool, plan-step, process, and file assertions, then writes a report.
6. `modcrafting_stop` cancels the application and retains failed diagnostics.

The bridge only listens on `127.0.0.1`, selects a random port, and requires a fresh 256-bit bearer token on every endpoint, including health/capability reads. It has no arbitrary JavaScript execution endpoint and no CORS policy.

## Artifacts and verdicts

Every run is stored below `%LOCALAPPDATA%/ModCrafting Test Lab/runs/<runId>/` and contains `run.json`, `events.ndjson`, snapshots, screenshots, a redacted provider request log, `workspace.patch` when available, and `process.log`.

- `PASS`: every required structural assertion passed.
- `FAIL`: a deterministic product assertion failed.
- `INCONCLUSIVE`: startup, bridge authentication, environment, real provider, or timeout prevented a product verdict.

Screenshots are supporting artifacts only. A screenshot, successful launch, or sent command cannot independently make a Harness scenario pass.

## Commands

```powershell
npm run test:mcp       # MCP schema/server smoke test
npm run test:app       # real Electron + local replay-provider regression
npm run test:app:live # optional manual real-provider smoke entry point
npm run test:app:game # optional Minecraft/Observer smoke entry point
```

The last two commands are intentionally opt-in. Daily CI and development gates use the replay provider; credentials are never copied to a test profile, sent through an MCP result, or written to reports.
