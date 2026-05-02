# Kova

Kova is the OpenClaw validation lab.

It runs OpenClaw the way real users run it: packaged releases, local
release-shaped builds, fresh installs, existing-user upgrades, gateway startup,
plugin loading, dashboard sends, TUI paths, agent turns, provider failures, and
long-running pressure.

Kova is built to answer the questions that decide whether OpenClaw is ready to
ship:

- Did the gateway actually start, bind, and become healthy?
- Did bundled plugins load, or did runtime dependencies break?
- Did a user message reach the provider quickly, or did OpenClaw stall first?
- Did memory, CPU, event loop delay, or child processes regress?
- Did an upgrade preserve real user state?
- Did the dashboard, TUI, plugins, and model/provider paths keep working?

Kova uses OCM to create isolated OpenClaw labs, but Kova reports on OpenClaw.
OCM is the harness. OpenClaw is the product under test.

## Why Kova

Unit tests do not prove release behavior.

Kova runs the full product path:

- installs or builds an OpenClaw runtime
- creates disposable OpenClaw environments
- injects deliberate auth, mock or live
- starts the gateway
- runs real commands and user-facing flows
- samples CPU, memory, processes, health, logs, timelines, and provider calls
- writes concise Markdown for humans and structured JSON for agents/CI
- cleans up temporary envs and runtimes by default

That makes Kova useful for release gates, regression hunting, performance
investigation, and fixer handoffs.

## What Kova Catches

Kova is designed to catch failures that usually escape simple tests:

- missing files in packed releases
- broken bundled plugin dependency staging
- slow gateway startup
- high gateway RSS or CPU spikes
- expensive package/build/runtime staging work
- dashboard or TUI hangs
- slow first agent reply
- provider timeout, malformed response, streaming stall, and recovery behavior
- child process leaks after failed turns
- old user state that breaks after upgrade
- plugin install, update, remove, manifest, and runtime-dependency problems

When OpenClaw emits diagnostic spans, Kova correlates them with external
evidence so reports can point at concrete startup, plugin, model, provider, or
agent phases. When spans are missing, Kova still reports the outside-in proof
instead of pretending it knows more than it measured.

## Quick Start

Install dependencies, set up Kova, and verify the lab:

```sh
npm install
node bin/kova.mjs setup
node bin/kova.mjs self-check
```

`setup` also configures auth. Mock auth is the default, so Kova can run
deterministic OpenClaw agent scenarios without live provider credentials. Live
auth is supported when you want real provider behavior.

For scripts and CI:

```sh
node bin/kova.mjs setup --ci --json
```

Kova stores runtime data outside the repo:

```text
~/.kova/
  credentials/
  reports/
  artifacts/
  baselines/
```

Set `KOVA_HOME` to use a different data home.

## First Real Run

Run a smoke matrix against an existing OCM runtime:

```sh
node bin/kova.mjs matrix run \
  --profile smoke \
  --target runtime:stable \
  --execute \
  --json
```

Run against a published OpenClaw version:

```sh
node bin/kova.mjs matrix run \
  --profile smoke \
  --target npm:2026.4.27 \
  --execute \
  --json
```

Run against a local OpenClaw checkout as a release-shaped runtime:

```sh
node bin/kova.mjs matrix run \
  --profile diagnostic \
  --target local-build:/path/to/openclaw \
  --execute \
  --json
```

Use `local-build:<repo>` when you need to test what a release-like package will
do, not what source-mode dev commands happen to tolerate.

## High-Value Workflows

### Prove a Local OpenClaw Build Is Shippable

```sh
node bin/kova.mjs matrix run \
  --profile release \
  --target local-build:/path/to/openclaw \
  --execute \
  --gate \
  --json
```

Gate mode writes a ship/no-ship verdict and keeps a durable artifact bundle for
failed gates.

### Find Why an Agent Reply Is Slow

```sh
node bin/kova.mjs run \
  --target local-build:/path/to/openclaw \
  --scenario agent-cold-warm-message \
  --execute \
  --json
```

Kova separates:

- command time
- gateway attach time
- OpenClaw pre-provider time
- provider request/response time
- post-provider cleanup time
- process and resource changes

That lets you tell whether a slow reply came from OpenClaw preparation,
provider latency, cleanup, or missing instrumentation.

### Test Dashboard Message Sends

```sh
node bin/kova.mjs run \
  --target local-build:/path/to/openclaw \
  --scenario dashboard-session-send-turn \
  --execute \
  --json
```

This exercises the browser/dashboard session path instead of only CLI command
paths.

### Test Provider Failure Containment

```sh
node bin/kova.mjs matrix run \
  --profile release \
  --target runtime:stable \
  --include tag:provider-failure \
  --execute \
  --json
```

Kova can simulate slow providers, timeouts, malformed responses, streaming
stalls, and recovery. Reports show whether OpenClaw failed clearly, recovered,
kept the gateway healthy, and avoided process leaks.

### Test an Existing User Upgrade Safely

```sh
node bin/kova.mjs run \
  --scenario upgrade-existing-user \
  --source-env Violet \
  --from npm:2026.4.20 \
  --target npm:2026.4.27 \
  --execute \
  --json
```

Kova clones durable user envs before mutation. It should not run upgrade tests
directly against real daily-driver envs.

## Targets

```text
npm:<version>              published OpenClaw release
channel:<name>             published channel such as stable or beta
runtime:<name>             existing OCM runtime name
local-build:<repo-path>    OpenClaw checkout built as a release-shaped runtime
```

## Profiles

```text
smoke        fast confidence over the most important product paths
diagnostic   source-build diagnostics with timeline/span expectations
release      release-gate coverage and ship/no-ship verdicts
soak         longer pressure and stability runs
exhaustive   broad coverage for deeper validation
```

Use filters when you want a focused slice:

```sh
node bin/kova.mjs matrix run \
  --profile release \
  --target local-build:/path/to/openclaw \
  --include tag:plugins \
  --exclude state:broken-plugin-deps \
  --execute \
  --json
```

Filters accept `scenario:<id>`, `state:<id>`, `tag:<tag>`, or a bare
scenario/state/tag value.

## Reports

Every run writes:

- Markdown report for humans
- JSON report for agents and CI
- artifact bundle for handoff
- optional baselines and comparison output

Reports focus on evidence:

- tested runtime and scenario
- pass/fail/blocker status
- gateway readiness and health
- plugin and dependency errors
- agent/provider timing
- CPU/RSS by process role
- leaks and cleanup state
- likely OpenClaw owner area
- concise fixer summary

Useful report commands:

```sh
node bin/kova.mjs report summarize reports/<run>.json
node bin/kova.mjs report paste reports/<run>.json
node bin/kova.mjs report compare reports/<baseline>.json reports/<current>.json
node bin/kova.mjs report bundle reports/<run>.json
```

## Performance And Baselines

Repeat runs expose noisy or unstable performance:

```sh
node bin/kova.mjs matrix run \
  --profile smoke \
  --target runtime:stable \
  --repeat 3 \
  --execute \
  --json
```

Save a reviewed-good baseline:

```sh
node bin/kova.mjs matrix run \
  --profile smoke \
  --target runtime:stable \
  --repeat 3 \
  --execute \
  --save-baseline \
  --reviewed-good \
  --json
```

Compare future runs against that baseline to catch startup, RSS, CPU, event-loop,
and agent-latency regressions.

## Auth

Kova-created envs get deliberate auth by default.

```text
mock   deterministic local OpenAI-compatible provider
live   configured provider credentials or external CLI auth
skip   only for scenarios that intentionally test missing auth
```

Interactive setup accepts numbers or names:

```sh
node bin/kova.mjs setup
```

Non-interactive examples:

```sh
node bin/kova.mjs setup --non-interactive --auth env-only --provider openai --env-var OPENAI_API_KEY
node bin/kova.mjs setup --non-interactive --auth external-cli --provider openai
node bin/kova.mjs setup --non-interactive --auth external-cli --provider anthropic
```

External CLI auth is strict. Kova checks the selected CLI and local auth
evidence before accepting it.

## Safety Model

Kova is meant to be aggressive without being reckless.

- `run` is dry-run by default.
- Real execution requires `--execute`.
- Disposable envs are destroyed by default.
- Temporary local-build runtimes are removed by default.
- Durable envs can be clone sources, not mutation targets.
- Exhaustive executed matrices require `--allow-exhaustive`.

Keep a failing env only when you need to inspect it:

```sh
node bin/kova.mjs run \
  --target runtime:stable \
  --scenario fresh-install \
  --execute \
  --retain-on-failure
```

Clean up Kova-owned resources:

```sh
node bin/kova.mjs cleanup envs --execute
node bin/kova.mjs cleanup artifacts --older-than-days 7 --execute
```

## Agent Usage

Kova is agent-first and human-usable.

Agents should use JSON:

```sh
node bin/kova.mjs plan --json
node bin/kova.mjs matrix plan --profile smoke --target runtime:stable --json
node bin/kova.mjs matrix run --profile smoke --target runtime:stable --execute --json
```

For Codex or other agents using OCM-backed Kova scenarios, install the OCM
operator skill:

```sh
codex skills install https://github.com/shakkernerd/ocm/tree/main/skills/ocm-operator
```

That skill teaches safe OCM env cloning, local runtime builds, upgrades, service
inspection, logs, and cleanup. Kova remains focused on OpenClaw behavior.

## Development Checks

```sh
node bin/kova.mjs self-check
node bin/kova.mjs plan --json
node bin/kova.mjs matrix plan --profile smoke --target runtime:stable --json
```

Self-check validates the registry, scenarios, state compatibility, collectors,
auth setup, report generation, parser fixtures, and safety contracts.
