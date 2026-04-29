# Kova

Kova is the OpenClaw runtime validation lab.

Kova runs real OpenClaw release, upgrade, plugin, gateway, and performance
scenarios. It uses OCM as the lab control plane for isolated envs and runtimes,
but Kova reports on OpenClaw behavior.

## What Kova Tests

- fresh OpenClaw installs
- existing-user upgrades
- gateway startup and readiness
- bundled plugin/runtime dependency behavior
- plugin lifecycle paths
- model/provider discovery paths
- dashboard/TUI/API responsiveness
- memory, CPU, latency, and startup regressions

Kova is not a unit test runner. It should exercise OpenClaw the way users and
release builds actually run it.

Kova is designed for agents and humans:

- agents consume JSON plans and JSON reports
- humans read concise Markdown reports
- successful command output stays out of Markdown noise
- real execution is explicit and cleanup-aware

When Codex or another agent has access to the `ocm-operator` skill, it should
load that skill before executing Kova scenarios. The skill gives the agent the
OCM operating knowledge needed for safe env cloning, runtime builds, upgrades,
service inspection, logs, and cleanup. Kova still reports OpenClaw behavior.

Install the skill when it is missing:

```sh
codex skills install https://github.com/shakkernerd/ocm/tree/main/skills/ocm-operator
```

## Commands

```sh
node bin/kova.mjs version
node bin/kova.mjs setup
node bin/kova.mjs setup --json
node bin/kova.mjs self-check
node bin/kova.mjs plan
node bin/kova.mjs plan --json
node bin/kova.mjs matrix plan --profile smoke --target runtime:stable --json
node bin/kova.mjs matrix run --profile smoke --target runtime:stable --json
node bin/kova.mjs matrix run --profile release --target channel:beta --include tag:plugins --parallel 2 --json
node bin/kova.mjs report compare reports/baseline.json reports/current.json --json
node bin/kova.mjs plan --scenario fresh-install
node bin/kova.mjs run --target npm:2026.4.27 --scenario fresh-install
node bin/kova.mjs run --target npm:2026.4.27 --scenario fresh-install --state missing-plugin-index --json
node bin/kova.mjs cleanup envs
```

`run` is dry-run by default. It writes Markdown and JSON reports showing the
planned OpenClaw scenario.

Real execution is explicit:

```sh
node bin/kova.mjs run --target npm:2026.4.27 --scenario fresh-install --execute
node bin/kova.mjs run --target npm:2026.4.27 --scenario fresh-install --state stale-runtime-deps --execute
node bin/kova.mjs run --target npm:2026.4.27 --scenario gateway-performance --execute --node-profile
node bin/kova.mjs matrix run --profile smoke --target npm:2026.4.27 --execute
node bin/kova.mjs matrix run --profile release --target npm:2026.4.27 --include tag:plugins --exclude state:broken-plugin-deps --parallel 2 --execute
```

Matrix filters accept `scenario:<id>`, `state:<id>`, `tag:<tag>`, or a bare
scenario/state/tag value. Matrix runs bundle their report automatically.

Gateway readiness is deadline-based. Kova polls TCP listening and `/health`
until the scenario readiness threshold expires, records every failed attempt in
JSON, and reports time-to-listening plus time-to-health-ready.

Kova destroys temporary envs by default after execution. Keep an env for
debugging only when needed:

```sh
node bin/kova.mjs run --target npm:2026.4.27 --scenario fresh-install --execute --keep-env
node bin/kova.mjs run --target npm:2026.4.27 --scenario fresh-install --execute --retain-on-failure
```

## Target Selectors

```text
npm:<version>              published OpenClaw release
channel:<name>             published channel such as stable or beta
runtime:<name>             existing OCM runtime name
local-build:<repo-path>    OpenClaw checkout built as a release-shaped runtime
```

Examples:

```sh
node bin/kova.mjs run --target npm:2026.4.26 --scenario fresh-install --execute
node bin/kova.mjs run --target channel:beta --scenario gateway-performance --execute
node bin/kova.mjs run --target runtime:test-build-1 --scenario plugin-lifecycle --execute
node bin/kova.mjs run --target local-build:/path/to/openclaw --scenario fresh-install --execute
```

## Existing User Upgrade

Existing-user scenarios must clone a source env. Do not run upgrade scenarios
directly against durable user envs.

```sh
node bin/kova.mjs run \
  --scenario upgrade-existing-user \
  --source-env Violet \
  --from npm:2026.4.20 \
  --target npm:2026.4.27 \
  --execute
```

## Reports

Reports are written to `reports/`:

- Markdown for humans
- JSON for agents, CI, and regression comparison

Reports should answer:

- what OpenClaw runtime was tested
- what scenario ran
- what passed, failed, or blocked
- what command failed
- what evidence was captured
- what OpenClaw area likely owns the issue
- whether temporary envs were cleaned up

Agents should use `node bin/kova.mjs plan --json` to choose scenarios and then
read the generated JSON report after `run`. Markdown is intentionally compact.
Use `run --json` when an agent needs stable report paths without parsing text.

Summarize generated reports:

```sh
node bin/kova.mjs report summarize reports/<run>.json
node bin/kova.mjs report summarize reports/<run>.json --json
node bin/kova.mjs report paste reports/<run>.json
node bin/kova.mjs report compare reports/<baseline>.json reports/<current>.json
node bin/kova.mjs report bundle reports/<run>.json
```

`report paste` produces a short handoff summary for another agent or fixer.
`report compare` flags status and metric regressions between two Kova JSON
reports. `report bundle` packages the JSON report, Markdown report, paste
summary, and run artifacts for handoff.

## Current Status

The repo has the first production skeleton:

- scenario matrix
- OCM-backed command execution
- timeout handling
- stdout/stderr capture
- gateway service snapshots
- gateway health snapshots
- gateway health latency samples
- gateway log diagnostic counts
- gateway PID/RSS/CPU metrics on executed scenarios
- continuous resource sampling during commands
- optional Node CPU, heap, and trace profile artifacts with `--node-profile`
- optional OpenClaw diagnostics timeline ingestion
- threshold evaluation for command latency, peak RSS, missing dependency errors,
  and final gateway state
- Markdown and JSON reports
- explicit execution mode
- default cleanup of temporary envs

Next work should make OpenClaw emit the diagnostics timeline contract so Kova can
attribute slow spans, repeated plugin metadata scans, runtime dependency staging,
provider/model loading, and event-loop delay to concrete OpenClaw phases.
