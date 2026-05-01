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
- dashboard, TUI, and API responsiveness
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
node bin/kova.mjs setup --non-interactive --auth env-only --provider openai --env-var OPENAI_API_KEY
node bin/kova.mjs setup --ci --json
node bin/kova.mjs self-check
node bin/kova.mjs plan
node bin/kova.mjs plan --json
node bin/kova.mjs matrix plan --profile smoke --target runtime:stable --json
node bin/kova.mjs matrix run --profile smoke --target runtime:stable --json
node bin/kova.mjs matrix run --profile release --target channel:beta --include tag:plugins --parallel 2 --json
node bin/kova.mjs matrix run --profile release --target local-build:/path/to/openclaw --execute --gate --json
node bin/kova.mjs report compare reports/baseline.json reports/current.json --json
node bin/kova.mjs plan --scenario fresh-install
node bin/kova.mjs run --target npm:2026.4.27 --scenario fresh-install
node bin/kova.mjs run --target npm:2026.4.27 --scenario fresh-install --state missing-plugin-index --json
node bin/kova.mjs cleanup envs
```

Kova runtime data lives outside the repo by default:

```text
~/.kova/
  credentials/
  reports/
  artifacts/
  baselines/
```

Set `KOVA_HOME` to use a different data home.

Interactive setup asks for provider first, then auth method. Provider and auth
answers accept either the displayed number or the name, for example `2` or
`anthropic`, `3` or `api-key`.
External CLI auth is strict: Kova verifies the selected CLI binary and local
auth evidence before setup can pass. `openai + external-cli` uses Codex CLI;
`anthropic + external-cli` uses Claude CLI. `custom-openai` should use API-key
or env-only auth.

`run` is dry-run by default. It writes Markdown and JSON reports showing the
planned OpenClaw scenario.

Every Kova-created disposable OpenClaw env receives deliberate model auth unless
the scenario/state explicitly tests missing or broken auth. `--auth mock` is the
default and uses Kova's deterministic local OpenAI-compatible provider.
`--auth live` requires credentials configured through `kova setup`; live results
are marked environment-dependent and should be compared separately from mock
baselines.

`plan --json` is coverage-aware: scenarios map to declared OpenClaw surfaces,
surfaces declare process roles and required metrics, and profile coverage gaps
are visible before a run starts.

States are validated contracts too. A profile cannot pair a scenario with a
state that is incompatible with the scenario's surface.

Real execution is explicit:

```sh
node bin/kova.mjs run --target npm:2026.4.27 --scenario fresh-install --execute
node bin/kova.mjs run --target npm:2026.4.27 --scenario fresh-install --state stale-runtime-deps --execute
node bin/kova.mjs run --target npm:2026.4.27 --scenario gateway-performance --execute --node-profile
node bin/kova.mjs run --target local-build:/path/to/openclaw --scenario release-runtime-startup --execute
node bin/kova.mjs run --target npm:2026.4.27 --scenario plugin-external-install --execute
node bin/kova.mjs run --target npm:2026.4.27 --scenario agent-cold-warm-message --auth live --execute
node bin/kova.mjs matrix run --profile smoke --target npm:2026.4.27 --execute
node bin/kova.mjs matrix run --profile release --target npm:2026.4.27 --include tag:plugins --exclude state:broken-plugin-deps --parallel 2 --execute
```

Matrix filters accept `scenario:<id>`, `state:<id>`, `tag:<tag>`, or a bare
scenario/state/tag value. Matrix runs bundle their report automatically.

Release gate mode uses the existing matrix runner:

```sh
node bin/kova.mjs matrix run --profile release --target local-build:/path/to/openclaw --execute --gate --json
```

`--gate` evaluates the selected profile against its gate policy and adds a
ship/no-ship verdict to the report. The verdict is `SHIP`, `DO_NOT_SHIP`,
`PARTIAL`, or `BLOCKED`. Non-ship verdicts exit non-zero after writing the Markdown/JSON
report and artifact bundle. Non-ship gates also retain a durable copy under
`artifacts/release-gates/<runId>/`.

Filtered gate slices are reject-only. If a selected blocking scenario fails,
the verdict is `DO_NOT_SHIP`; if the selected slice passes but required gate
coverage is missing, the verdict is `PARTIAL` rather than `SHIP`.

Release gates check required surface/scenario/state/platform coverage, not only
command exit status. `report paste` and `report summarize --json` include a
concise failure brief with exact evidence, subsystem grouping, and fixer-ready
prompts.

Gateway readiness is classified. Kova polls TCP listening and `/health` until a
hard deadline, while separately enforcing the scenario readiness threshold.
Reports distinguish hard failures, unhealthy gateways, slow startup, and ready
gateways, with time-to-listening and time-to-health-ready evidence.

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

Executed scenarios refuse to mutate non-`kova-` env targets. A durable env such
as `Violet` can be used only as clone source state; Kova mutates the generated
disposable clone.

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
- readiness classification for hard failure, unhealthy, slow startup, and ready
- gateway log diagnostic counts
- gateway PID/RSS/CPU metrics on executed scenarios
- continuous resource sampling during commands
- optional Node CPU, heap, and trace profile artifacts with `--node-profile`
- `--deep-profile` for CPU/heap/trace profiling, diagnostic reports, heap
  snapshots, OpenClaw timeline envs, and denser resource sampling
- optional OpenClaw diagnostics timeline ingestion
- diagnostic correlation summaries that connect resource peaks, top profiler
  functions, OpenClaw spans, event-loop delay, runtime deps, and provider/model
  timing when available
- threshold evaluation for command latency, peak RSS, missing dependency errors,
  and final gateway state
- Markdown and JSON reports
- release gate verdicts and failure cards through `matrix run --gate`
- explicit execution mode
- default cleanup of temporary envs

Next OpenClaw-side work should expand diagnostics timeline emission so Kova can
attribute every slow startup phase to concrete OpenClaw spans rather than only
external process/profile evidence.
