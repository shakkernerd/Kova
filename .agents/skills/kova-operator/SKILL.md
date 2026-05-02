---
name: kova-operator
description: Use Kova to benchmark and validate OpenClaw with real release-shaped installs, OCM-backed disposable environments, startup/plugin/gateway/dashboard/TUI/agent/provider scenarios, CPU/RSS/event-loop/latency/resource attribution, baselines, release gates, and concise evidence reports. Use when asked to benchmark OpenClaw, evaluate OpenClaw performance, run Kova, produce Kova reports, investigate slow OpenClaw replies, validate OpenClaw release readiness, or compare OpenClaw builds across machines.
---

# Kova Operator

## Mission

Use Kova to test OpenClaw as users actually run it. Kova is not a unit-test
runner and not an OCM test suite. OCM is the lab control plane; OpenClaw is the
product under test.

Kova should produce evidence a maintainer can act on:

- startup time, listening time, health readiness
- gateway, CLI, package-manager, runtime-staging, plugin, browser, and provider
  CPU/RSS attribution
- plugin load and missing dependency errors
- dashboard/TUI/API responsiveness
- agent turn breakdown: pre-provider OpenClaw time, provider time,
  post-provider time, cold/warm delta
- provider failure containment: timeout, malformed response, streaming stall,
  recovery, leaked children, gateway health
- repeat-run stats, baseline comparisons, and release gate verdicts

Do not overstate causality. If OpenClaw did not emit enough diagnostic spans,
say Kova proved the outside-in timing but internal attribution is missing.

## First Steps

1. Find Kova:

```sh
command -v kova || true
test -f bin/kova.mjs && node bin/kova.mjs version
```

Use `kova` when installed. Inside a Kova checkout, use:

```sh
node bin/kova.mjs <command>
```

2. Ensure OCM is available before real execution:

```sh
command -v ocm
ocm env list
ocm runtime list
```

If the `ocm-operator` skill is available, use it before running Kova scenarios
that build runtimes, clone existing user envs, inspect services/logs, or clean
up envs.

3. Set up Kova:

```sh
kova setup
kova self-check
```

For scripts/CI:

```sh
kova setup --ci --json
kova self-check --json
```

If using the repo checkout, replace `kova` with `node bin/kova.mjs`.

## Install OCM Precisely

Kova real execution requires OCM. If OCM is missing, install it before running
benchmarks:

```sh
command -v ocm || curl -fsSL https://raw.githubusercontent.com/shakkernerd/ocm/main/install.sh | bash
export PATH="$HOME/.local/bin:$PATH"
ocm --version
ocm env list
ocm runtime list
```

If installing Kova from its installer, OCM can be installed or required there:

```sh
curl -fsSL https://raw.githubusercontent.com/shakkernerd/Kova/main/install.sh | bash -s -- --install-ocm --require-ocm
```

For Codex agents working from this repo, use the repo-local OCM operating skill
at `.agents/skills/ocm-operator` when direct OCM operations are needed.

## Safety Rules

- Prefer mock auth first. It isolates OpenClaw latency from provider latency.
- Run live auth only as a separate lane and mark it environment-dependent.
- Prefer `local-build:<repo>` for release-like validation of local OpenClaw
  source.
- Do not use source/dev commands as proof a published package will work.
- Do not mutate durable user envs directly. Use Kova clone/source flows.
- Use `--execute` only when a real run is intended.
- Keep failing envs only when inspection is needed; otherwise let Kova clean up.
- Report OpenClaw failures as OpenClaw failures, not OCM failures, unless lab
  provisioning itself blocked the run.

## OpenClaw Repo Handling

When the user asks to benchmark OpenClaw, first decide which OpenClaw source is
under test:

1. Use the explicit repo path if the user gives one.
2. If the current directory is an OpenClaw checkout, use it.
3. If a nearby checkout exists, such as `../openclaw`, use it only after
   confirming the path and commit.
4. If no checkout exists, clone a disposable copy into `/tmp`, not inside Kova:

```sh
repo="/tmp/kova-openclaw-$(date +%Y%m%d%H%M%S)"
git clone https://github.com/openclaw/openclaw.git "$repo"
git -C "$repo" checkout main
git -C "$repo" pull --ff-only
```

Before benchmarking a checkout, record:

```sh
git -C "$repo" status --short
git -C "$repo" rev-parse --abbrev-ref HEAD
git -C "$repo" rev-parse --short HEAD
git -C "$repo" log -1 --format='%h %ci %s'
```

Do not mutate a user working tree unless the user asked for that. For
benchmarking moving targets, prefer disposable clones or worktrees under
`/tmp/kova-openclaw-*`.

Use release-shaped Kova targets for local source:

```sh
kova matrix run --profile diagnostic --target local-build:"$repo" --execute --json
```

Do not use OpenClaw source/dev commands as proof that a package or release will
work. Source commands can hide missing package files, prepack failures, bundled
extension issues, or runtime dependency layout problems.

## Build Blocker Triage

A failed `local-build:<repo>` run is not automatically a finished benchmark.
The agent must determine whether the failure is:

- an OpenClaw packaging/prepack bug
- a missing dependency/install problem
- stale local artifacts
- a dirty checkout problem
- a platform/toolchain problem
- a Kova/OCM harness problem

If Kova reports a build/prepack blocker, inspect and reproduce the failing step
inside the OpenClaw repo before returning:

```sh
git -C "$repo" status --short
node --version
pnpm --version || corepack enable
pnpm -C "$repo" install --frozen-lockfile
pnpm -C "$repo" build
pnpm -C "$repo" pack --pack-destination /tmp/kova-openclaw-pack-check
```

If the Kova/OCM error names a specific script, run that script directly too:

```sh
pnpm -C "$repo" <script-name>
```

Examples:

```sh
pnpm -C "$repo" canvas:a2ui:bundle
pnpm -C "$repo" runtime:postbuild
pnpm -C "$repo" test-built-bundled-channel-entry-smoke
```

Use the direct script result to classify the issue:

- Direct script fails too: OpenClaw script/build bug. Report exact command and
  error.
- Direct script passes but `pnpm pack` or OCM `runtime build-local` fails:
  OpenClaw packaging/prepack path bug. Report that difference.
- `pnpm install` fails: dependency/toolchain problem. Report lockfile, Node,
  pnpm, and first failing package.
- Kova cannot create/remove envs or runtimes after OpenClaw packs correctly:
  likely harness/OCM problem. Report as BLOCKED with OCM evidence.

Do not stop at "build failed" when a simple build step fails. Try to isolate the
smallest failing OpenClaw command and include the exact failure line. A blocked
benchmark is acceptable only after the blocker is classified.

If stale generated artifacts are plausible, clean only disposable clones:

```sh
git -C "$repo" clean -fdX
pnpm -C "$repo" install --frozen-lockfile
```

Never run `git clean`, `git reset`, or destructive cleanup in a user's dirty
working checkout unless explicitly approved.

## How To Choose Scenarios From User Intent

When the user describes "what kind of thing to test", map the intent to Kova
scenarios or tags. Prefer the narrowest command that answers the request. Use
`local-build:<repo>` when testing a local OpenClaw checkout and `runtime:stable`,
`npm:<version>`, or `channel:<name>` when testing installed/published behavior.

Before running unfamiliar requests, inspect the registry:

```sh
kova plan --json
kova matrix plan --profile smoke --target runtime:stable --json
```

Intent map:

```text
release readiness / can we ship
  profile: release
  command: kova matrix run --profile release --target local-build:<repo> --execute --gate --json

local source as real release package
  profile: diagnostic
  command: kova matrix run --profile diagnostic --target local-build:<repo> --execute --json

quick confidence / smoke
  profile: smoke
  command: kova matrix run --profile smoke --target <target> --execute --json

startup / gateway readiness / memory / CPU
  scenarios: release-runtime-startup, gateway-performance
  command: kova run --target <target> --scenario gateway-performance --execute --json

deep CPU/heap/function profiling
  scenarios: gateway-performance, agent-cold-warm-message, dashboard-session-send-turn
  command: kova run --target <target> --scenario gateway-performance --execute --deep-profile --json

slow first reply / agent latency
  scenarios: dashboard-session-send-turn, agent-cold-warm-message, agent-gateway-rpc-turn
  command: run dashboard-session-send-turn first, then agent-cold-warm-message

dashboard messaging
  scenarios: dashboard-readiness, dashboard-session-send-turn
  command: kova run --target <target> --scenario dashboard-session-send-turn --execute --json

TUI input / terminal message path
  scenarios: tui-responsiveness, tui-message-turn
  command: kova run --target <target> --scenario tui-message-turn --execute --json

OpenAI-compatible API path
  scenario: openai-compatible-turn
  command: kova run --target <target> --scenario openai-compatible-turn --execute --json

plugins overall
  tag: plugins
  command: kova matrix run --profile release --target <target> --include tag:plugins --execute --json

bundled plugin startup / missing runtime deps
  scenarios: bundled-plugin-startup, bundled-runtime-deps, plugin-missing-runtime-deps
  command: kova run --target <target> --scenario bundled-runtime-deps --execute --json

external plugin lifecycle
  scenarios: plugin-external-install, plugin-lifecycle, plugin-update, plugin-remove
  command: kova matrix run --profile release --target <target> --include scenario:plugin-lifecycle --execute --json

bad plugin manifest
  scenario: plugin-bad-manifest
  command: kova run --target <target> --scenario plugin-bad-manifest --execute --json

provider timeout / malformed / streaming stall / recovery
  tag: provider-failure
  command: kova matrix run --profile release --target <target> --include tag:provider-failure --execute --json

model/provider listing or auth states
  scenarios: provider-models, agent-auth-missing
  command: kova run --target <target> --scenario provider-models --execute --json

existing user upgrade
  scenarios: upgrade-existing-user, upgrade-from-2026-4-20, upgrade-from-2026-4-24
  command: kova run --scenario upgrade-existing-user --source-env <env> --from npm:<old> --target npm:<new> --execute --json

upgrade stable channel to beta/local build
  scenarios: upgrade-stable-channel-to-beta, upgrade-stable-channel-to-local-build
  command: kova matrix run --profile channel-upgrade --from channel:stable --target channel:beta --execute --json

workspace/filesystem pressure
  scenarios: workspace-scan-pressure, gateway-performance with slow-filesystem state
  command: kova run --target <target> --scenario workspace-scan-pressure --execute --json

long-running memory/session pressure
  profile: soak
  scenarios: soak, agent-long-session
  command: kova matrix run --profile soak --target <target> --execute --json

browser automation
  scenario: browser-automation-smoke
  command: kova run --target <target> --scenario browser-automation-smoke --execute --json

MCP runtime
  scenario: mcp-runtime-start-stop
  command: kova run --target <target> --scenario mcp-runtime-start-stop --execute --json

media understanding timeout
  scenario: media-understanding-timeout
  command: kova run --target <target> --scenario media-understanding-timeout --execute --json

network offline containment
  scenario: agent-network-offline
  command: kova run --target <target> --scenario agent-network-offline --execute --json
```

If the user gives several intents, prefer a matrix with `--include` filters when
possible. If no existing scenario matches, say the current Kova registry does
not cover that intent and propose the closest scenario or a new scenario name.

## Core Workflows

### Benchmark a local OpenClaw checkout like a release

Use this first when validating a branch or commit:

```sh
kova matrix run \
  --profile diagnostic \
  --target local-build:/path/to/openclaw \
  --execute \
  --json
```

This covers release-shaped packaging, startup, runtime deps, bundled plugins,
gateway readiness, dashboard/API/agent surfaces, timelines when available, and
resource attribution.

### Fast smoke against an existing runtime

```sh
kova matrix run \
  --profile smoke \
  --target runtime:stable \
  --execute \
  --json
```

Use this for quick confidence when an OCM runtime already exists.

### Release gate

```sh
kova matrix run \
  --profile release \
  --target local-build:/path/to/openclaw \
  --execute \
  --gate \
  --json
```

Gate verdicts are `SHIP`, `DO_NOT_SHIP`, `PARTIAL`, or `BLOCKED`. A partial
filtered run can reject a release but cannot approve the whole release.

### Investigate slow OpenClaw replies

Run both dashboard and CLI agent paths:

```sh
kova run \
  --target local-build:/path/to/openclaw \
  --scenario dashboard-session-send-turn \
  --execute \
  --json

kova run \
  --target local-build:/path/to/openclaw \
  --scenario agent-cold-warm-message \
  --execute \
  --json
```

Look for:

- total agent turn time
- pre-provider OpenClaw time
- provider duration / first byte / final response
- post-provider cleanup
- cold vs warm delta
- gateway health during and after the turn
- leaked child processes
- OpenClaw timeline spans if available

If provider time is tiny and pre-provider time dominates, report that OpenClaw
delayed before provider work.

### Provider failure containment

```sh
kova matrix run \
  --profile release \
  --target runtime:stable \
  --include tag:provider-failure \
  --execute \
  --json
```

This exercises slow provider, timeout, malformed response, streaming stall,
concurrent pressure, and recovery scenarios. Verify the gateway remains healthy
and child processes do not leak.

### Existing-user upgrade

```sh
kova run \
  --scenario upgrade-existing-user \
  --source-env <existing-env-name> \
  --from npm:<old-version> \
  --target npm:<new-version> \
  --execute \
  --json
```

Use durable envs only as clone sources. Never mutate the source env directly.

### Repeat benchmarks and baselines

```sh
kova matrix run \
  --profile smoke \
  --target local-build:/path/to/openclaw \
  --repeat 3 \
  --execute \
  --json
```

Only save a baseline after a human reviews a passing, stable run:

```sh
kova matrix run \
  --profile smoke \
  --target local-build:/path/to/openclaw \
  --repeat 3 \
  --execute \
  --save-baseline \
  --reviewed-good \
  --json
```

Use baseline comparisons to catch startup, RSS, CPU, event-loop, runtime-deps,
and agent-latency regressions.

### Benchmark a time window or commit range

When the user asks to benchmark "between", "since", "before/after", "last N
commits", "from date A to date B", or "over a period", produce a comparison.
Do not only report separate runs.

Required flow:

1. Identify the baseline commit and latest/end commit.
2. Run the same Kova scenario/profile on both commits.
3. Use the same machine, auth mode, profile, scenario/state, target style, and
   `--repeat` count.
4. Compare the generated JSON reports.
5. Report deltas and verdict.

Use disposable OpenClaw worktrees or clones:

```sh
base_repo="/tmp/kova-openclaw-base-<shortsha>"
head_repo="/tmp/kova-openclaw-head-<shortsha>"
git clone <openclaw-remote-or-source> "$base_repo"
git clone <openclaw-remote-or-source> "$head_repo"
git -C "$base_repo" checkout <baseline-sha>
git -C "$head_repo" checkout <head-sha>
```

Run comparable Kova commands:

```sh
kova run \
  --target local-build:"$base_repo" \
  --scenario gateway-performance \
  --state many-bundled-plugins \
  --repeat 3 \
  --execute \
  --json

kova run \
  --target local-build:"$head_repo" \
  --scenario gateway-performance \
  --state many-bundled-plugins \
  --repeat 3 \
  --execute \
  --json

kova report compare reports/<baseline>.json reports/<latest>.json --json
```

The final answer must include comparison lines such as:

```text
Metric                    Baseline     Latest       Delta
health ready median       2625ms       3010ms       +14.7%
listening median          2534ms       2810ms       +10.9%
gateway RSS median        594.9MB      650.2MB      +9.3%
total peak RSS median     1088.1MB     1420.5MB     +30.5%
CPU max median            131.8%       180.0%       +36.6%
event-loop max median     111.1ms      205.0ms      +84.5%
```

If one side cannot build or run, say the comparison is blocked and why:

```text
Comparison: BLOCKED
Baseline ran, latest did not reach gateway startup.
Latest blocker: OpenClaw release-shaped prepack failed in canvas:a2ui:bundle.
Meaning: latest is not benchmarkable through the release-shaped path, which is
a release blocker before performance can be compared.
```

Do not present baseline numbers as a comparison when the latest side did not
run. Classify that as "benchmarkability regression" or "comparison blocked",
then include the blocker evidence and report paths.

### Deep diagnostics

Use only when investigating a real performance or resource issue:

```sh
kova run \
  --target local-build:/path/to/openclaw \
  --scenario gateway-performance \
  --execute \
  --deep-profile \
  --json
```

Deep profiling can collect Node CPU/heap/trace artifacts, heap snapshots,
OpenClaw timeline envs, diagnostic reports, and denser resource samples.

## Targets

```text
npm:<version>              published OpenClaw release
channel:<name>             channel such as stable or beta
runtime:<name>             existing OCM runtime
local-build:<repo-path>    local OpenClaw checkout built as release-shaped runtime
```

Prefer `local-build:<repo>` for branch/release validation. Prefer `npm:<version>`
or `channel:<name>` for published-release behavior.

## Profiles

```text
smoke        fast confidence over core product paths
diagnostic   local-build diagnostics and OpenClaw timeline expectations
release      ship/no-ship gate coverage
soak         long-running pressure and stability
exhaustive   broad validation; use --allow-exhaustive for execution
```

Use filters for focused slices:

```sh
kova matrix run \
  --profile release \
  --target local-build:/path/to/openclaw \
  --include tag:plugins \
  --exclude state:broken-plugin-deps \
  --execute \
  --json
```

Filters accept `scenario:<id>`, `state:<id>`, `tag:<tag>`, or a bare
scenario/state/tag value.

## Report Handling

After every run, capture:

- Markdown report path
- JSON report path
- bundle path
- Kova version
- OpenClaw target and SHA/version
- OS, arch, CPU/RAM if available, Node version
- auth mode: mock or live
- whether envs/runtimes were cleaned up or retained

Use report helpers:

```sh
kova report summarize reports/<run>.json
kova report paste reports/<run>.json
kova report bundle reports/<run>.json
kova report compare reports/<baseline>.json reports/<current>.json
```

For user-facing replies, lead with concise findings:

```text
Verdict: FAIL
OpenClaw target: local-build:<repo> @ <sha>
Key evidence:
- startup ready in 3.0s, gateway RSS 631 MB
- agent turn 9.2s; pre-provider 8.9s; provider 1ms
- missing dependency: @homebridge/ciao from bundled bonjour
- leaked browser-sidecar after dashboard turn
Artifacts:
- Markdown: ...
- JSON: ...
- Bundle: ...
```

Do not paste noisy stdout unless the user asks. Use exact error lines and
metrics, not vague summaries.

## Cleanup Etiquette

Benchmark work should leave the machine clean unless the user asks to retain
artifacts.

After every executed run:

```sh
ocm env list | rg 'kova-|bench-' || true
ocm runtime list | rg 'kova-local|bench-' || true
```

Remove Kova-owned leftovers:

```sh
kova cleanup envs --execute
ocm env destroy <kova-env> --yes
ocm runtime remove <kova-runtime>
```

Remove disposable OpenClaw clones/worktrees created for the benchmark:

```sh
rm -rf /tmp/kova-openclaw-*
```

Keep report artifacts by default. They are evidence. In the final response,
state whether cleanup removed temporary envs/runtimes/clones or whether anything
was intentionally retained.

## Repo-Local Skills

This repo carries the skills under `.agents/skills/`:

- `.agents/skills/kova-operator`
- `.agents/skills/ocm-operator`

Use `kova-operator` for Kova benchmark selection, execution, and reporting. Use
`ocm-operator` when direct OCM env/runtime/service/log operations are needed.
