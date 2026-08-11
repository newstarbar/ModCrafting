# Harness Test Lab and repair-safety recovery

## Trigger

Repeated manual diagnostic exports exposed failures that unit tests could not reproduce: a comment containing `class to` was treated as a Java declaration, a structural Mixin check was treated as compilation proof, a failed registration could leave configuration behind, and the repair loop could keep calling tools or edit outside the declared plan.

## Changes

- Java identity parsing now strips comments, string literals and character literals before locating an anchored top-level declaration. Registration validates the parsed identity against the source path before touching a Mixin config.
- Mixin scaffolding is create-only except for a matching generated `MODCRAFTING_MIXIN` file. Failed two-file registrations roll back the newly written config.
- Mixin validation reports `level: structural`. It is useful evidence but cannot substitute for a compiler or runtime test, and it cannot block a subsequent real build.
- Repair is bounded to three write/build rounds, twenty model turns and forty tool calls. Repeated identical failures stop, and build failures outside plan-declared/current-run paths return `INCONCLUSIVE/out_of_scope_build_failure` rather than changing unrelated code.
- Test Lab adds a loopback authenticated automation bridge to a real isolated Electron instance plus a development-only stdio MCP server. It can open a sandbox fixture, send a real turn, observe Controller/React state and event cursors, capture supporting screenshots, and retain redacted reports.
- The daily application regression uses an in-memory OpenAI-compatible replay service so classifier tool calls and streaming chat are exercised without a real provider key. Real provider and Minecraft tests remain explicit smoke tests.

## Regression coverage

- A Javadoc or string literal mentioning `class to` cannot create a phantom Mixin identity.
- Repair-budget tests cover the fixed limit and out-of-scope compiler path rejection.
- `npm run test:mcp` validates the MCP construction with stdout-safe operation.
- `npm run test:app` builds and launches Electron, checks authenticated discovery, sends a real replayed agent turn, retains an event ledger and verifies the provider artifact does not contain the test API key.

## Operational note

Use Test Lab reports before requesting a user to copy a session diagnostic. An inconclusive bridge, provider or environment failure is actionable diagnostic evidence, not a trigger to rewrite mod code.

## Foreground observation update

The standalone Test Lab runner now displays its isolated Electron window by default, including `test:app:live` and `test:app:game`, so a developer can observe Agent activity and Minecraft handoff during a real smoke test. Passing `--hidden` keeps the former unattended behavior; it does not change the isolated profile, sandbox workspace, bridge authentication or report capture.

## 2026-08-11: sample-overfitting recovery

An attempted complex gameplay regression had leaked its sample-specific implementation advice, exact state fields and additional model-round budget into production Harness code. This was removed. `AcceptanceContract` now expresses requirement-to-oracle mapping without prescribing business code; Observer V2 records generic player snapshots plus bounded renderer and HUD traces; and the complex examples live only under `scripts/test/scenarios/` as Test Lab black-box fixtures. Unsupported observation and visual-only claims remain `INCONCLUSIVE` until a user confirms them, never a weak automatic success or an automatic code rewrite.
