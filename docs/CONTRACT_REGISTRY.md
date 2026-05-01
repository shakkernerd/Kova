# Contract Registry

Kova models OpenClaw coverage with declarative contracts. Add a new OpenClaw
capability or user state by updating JSON first; change engine code only when
the new contract needs evidence that Kova cannot already collect.

## Add A Surface

Create `surfaces/<id>.json`.

Required fields:

- `id`: stable kebab-case surface id.
- `title`: short human name.
- `ownerArea`: OpenClaw subsystem likely to own failures.
- `description`: what OpenClaw behavior this surface proves.
- `requiredStates`: state ids or traits expected for meaningful coverage.
- `targetKinds`: target kinds that can run the surface.
- `requiredMetrics`: metric ids from `metrics/known.json`.
- `processRoles`: role ids from `process-roles/*.json`.
- `thresholds`: default pass/fail thresholds for the surface.
- `diagnostics`: source-build timeline expectations when available.

Then:

1. Add or update one scenario in `scenarios/*.json` with `"surface": "<id>"`.
2. Add missing metric ids to `metrics/known.json`.
3. Add the surface to compatible states in `states/*.json`.
4. Add profile coverage in `profiles/*.json` only when the surface should be
   part of that profile.
5. Run `node bin/kova.mjs plan --json`.
6. Run a dry-run for the scenario.
7. Add self-check coverage if the surface introduces new evidence parsing.

Do not add a surface for an implementation detail. A surface should represent a
real OpenClaw workflow a user or release gate cares about.

## Add A State

Create `states/<id>.json`.

Required fields:

- `id`: stable kebab-case state id.
- `title`: short human name.
- `objective`: what user history or degraded condition this state models.
- `traits`: known traits validated by Kova.
- `compatibleSurfaces`: surface ids this state can be paired with.
- `incompatibleSurfaces`: surface ids this state must not be paired with.
- `riskArea`: what can break when this state is used.
- `ownerArea`: OpenClaw subsystem most likely to own state-specific failures.
- `setupEvidence`: what proves setup happened.
- `cleanupGuarantees`: what Kova must clean or destroy after execution.

Lifecycle command phases are optional. If a state needs setup, keep commands
inside disposable Kova envs and make the evidence explicit. Existing user state
must be represented through clone/import metadata, not direct mutation of a
durable env.

Then:

1. Pair the state with compatible scenarios or profile entries.
2. Add profile trait/state coverage only when it is required for release
   confidence.
3. Run `node bin/kova.mjs plan --json`.
4. Dry-run at least one scenario/state pair.
5. Execute a disposable scenario when the state lifecycle mutates files,
   services, plugins, or runtimes.

## Validation Rules

Self-check and plan validation must fail for:

- unknown surface, state, process role, metric, or profile references
- invalid state traits
- malformed lifecycle phases
- scenario/state pairs that violate compatibility
- profile entries that require unknown surfaces or states

If a new surface or state needs exceptions to these rules, the contract is too
loose. Tighten the JSON or add a focused validator.
