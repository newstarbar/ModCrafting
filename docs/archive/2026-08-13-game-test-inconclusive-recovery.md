# Game-test INCONCLUSIVE recovery

## Problem

An inconclusive `mc_run_test` was converted into a generic clarification. The
user response resumed the same plan, contract and scenario, so the same result
could repeat forever.

## Resolution

- Added machine-readable `inconclusiveCode`, `responsibility`, scenario revision,
  fingerprint and superseded scenario IDs to the V2 game-test protocol.
- Routed invalid test specifications to bounded internal evidence repair and
  environment failures to bounded recovery. Neither route emits clarification.
- Required executable actions, objective assertions and Observer-capability
  compatible fields before a scenario/plan can run.
- Rejected stale scenario PASS evidence when a repaired scenario is active.
- Added `GameTestStatus` events and a UI status card for repair/recovery states.
- Preserved the existing explicit Agent `ask_clarification` path for real product
  choices.
- Added host-owned environment recovery probes (runtime status, test-world/cheat
  preparation, and Observer V2 capability check) without exposing product tools.
- Added field-level Observer V2 pointer validation and AcceptanceContract-to-
  scenario assertion coverage checks.
- Added a separate AcceptanceContract fingerprint and scenario supersession audit
  trail, plus a dedicated visual-review card with fresh screenshot evidence;
  accepted reviews persist `user_confirmation`, while rejected reviews enter
  product repair.
- The complete-project Test Lab contract now requires two full PASS runs for its
  final scenario, making the final Luna replay requirement machine-checkable.
- V2 scenarios can declare `requiredPassCount` (1–3); the workflow host restarts
  Minecraft and replays the same scenario before advancing when more than one
  independent PASS is required.

## Verification

- `npm test`: 487/487 passing.
- `npm run build`: passing.
- `npm run test:app:hidden`: passing.
- `npm run test:mcp`: passing.
- `npm run bridge:build`: passing.
