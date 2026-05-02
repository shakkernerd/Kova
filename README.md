# Kova

**Kova is the OpenClaw validation lab.**

It runs real OpenClaw installs, upgrades, gateways, plugins, dashboards, TUIs,
agent turns, provider failures, and release-shaped builds, then tells you what
broke, how slow it was, how much memory it used, which process owned the cost,
and what evidence to hand to the fixer.

Unit tests can say code passed. Kova answers the release question:

> Can real users install, update, start, message, use plugins, and keep running
> without OpenClaw getting slow, unhealthy, leaky, or broken?

## What You Get

- **Release confidence**: fresh installs, existing-user upgrades, local
  release-shaped builds, channel/runtime targets, and ship/no-ship gates.
- **Performance evidence**: startup time, health readiness, agent latency,
  provider latency, event-loop delay, repeated-run stats, and baseline
  regression checks.
- **Memory and CPU ownership**: gateway RSS, CLI RSS, package-manager cost,
  runtime-staging cost, plugin sidecars, browser sidecars, mock provider, and
  uncategorized spikes.
- **Agent-turn attribution**: pre-provider OpenClaw time, provider time,
  post-provider time, cold/warm deltas, response correctness, and missing
  instrumentation called out honestly.
- **Plugin and runtime proof**: bundled plugin startup, runtime dependency
  staging, external plugin install/update/remove, bad manifests, missing deps,
  and plugin load failures.
- **Failure containment**: provider timeouts, malformed responses, streaming
  stalls, recovery, gateway health after failure, and leaked child processes.
- **Human and agent reports**: concise Markdown for people, structured JSON for
  agents/CI, plus artifact bundles for handoff.

Kova uses OCM to create isolated OpenClaw labs. Kova is not testing OCM. OCM is
the harness; OpenClaw is the product under test.

## A Kova Report Looks Like This

```text
Kova Run: local-build diagnostic
Verdict: FAIL

release-runtime-startup/fresh
  readiness: ready
  listening: 2.8s
  health ready: 3.0s
  gateway peak RSS: 631 MB
  package-manager peak RSS: 901 MB
  build-tooling peak RSS: 2409 MB
  missing dependency: @homebridge/ciao from bundled bonjour

dashboard-session-send-turn/mock-openai-provider
  agent turn: 9.2s
  pre-provider OpenClaw time: 8.9s
  provider time: 1ms
  diagnosis: OpenClaw delayed before provider work
  leak: browser-sidecar process remained after turn
  health: gateway had post-command health failures

Fixer brief:
  Area: plugins/runtime deps, dashboard session agent path
  Why it matters: users can start successfully but hit plugin dependency errors
  and slow first replies unrelated to provider latency.
```

That is the point: not just pass/fail, but the evidence needed to fix OpenClaw.

## Start

```sh
npm install
node bin/kova.mjs setup
node bin/kova.mjs self-check
```

`setup` includes auth. Mock auth is the default, so Kova can test agent/provider
paths without real credentials. Live auth is available when you want real
provider behavior.

For scripts:

```sh
node bin/kova.mjs setup --ci --json
```

Kova data lives in `~/.kova` by default: credentials, reports, artifacts, and
baselines.

## Run The Important Checks

### Test A Local OpenClaw Checkout Like A Release

```sh
node bin/kova.mjs matrix run \
  --profile diagnostic \
  --target local-build:/path/to/openclaw \
  --execute \
  --json
```

This is the flow for catching packaging, bundled plugin, runtime dependency,
startup, dashboard, provider, and agent regressions before a release.

### Run A Release Gate

```sh
node bin/kova.mjs matrix run \
  --profile release \
  --target local-build:/path/to/openclaw \
  --execute \
  --gate \
  --json
```

Gate mode reports `SHIP`, `DO_NOT_SHIP`, `PARTIAL`, or `BLOCKED`, and keeps a
durable artifact bundle for failed gates.

### Investigate Slow Replies

```sh
node bin/kova.mjs run \
  --target local-build:/path/to/openclaw \
  --scenario dashboard-session-send-turn \
  --execute \
  --json
```

Kova separates OpenClaw pre-provider work from provider latency. If a message
takes 62s but the provider only took 800ms, Kova makes that visible.

### Compare Performance Over Time

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

Future runs can compare startup, memory, CPU, event-loop delay, and agent
latency against the reviewed-good baseline.

### Test Existing Users Safely

```sh
node bin/kova.mjs run \
  --scenario upgrade-existing-user \
  --source-env Violet \
  --from npm:2026.4.20 \
  --target npm:2026.4.27 \
  --execute \
  --json
```

Kova clones durable envs before mutating anything. Real user envs are sources,
not test targets.

## Targets

```text
npm:<version>              published OpenClaw release
channel:<name>             published channel such as stable or beta
runtime:<name>             existing OCM runtime
local-build:<repo-path>    local OpenClaw checkout built as release-shaped runtime
```

## Profiles

```text
smoke        fast confidence over core product paths
diagnostic   local-build diagnostics with timeline/span expectations
release      ship/no-ship gate coverage
soak         long-running pressure and stability
exhaustive   broad validation when you want the full sweep
```

Filter any matrix:

```sh
node bin/kova.mjs matrix run \
  --profile release \
  --target runtime:stable \
  --include tag:provider-failure \
  --execute \
  --json
```

## Reports

```sh
node bin/kova.mjs report summarize reports/<run>.json
node bin/kova.mjs report paste reports/<run>.json
node bin/kova.mjs report compare reports/<baseline>.json reports/<current>.json
node bin/kova.mjs report bundle reports/<run>.json
```

- Markdown is for humans.
- JSON is for agents and CI.
- Bundles are for handoff.
- Paste summaries are for fixer prompts.

## Safety

- Dry-run by default.
- Real execution requires `--execute`.
- Disposable envs are destroyed by default.
- Temporary local-build runtimes are removed by default.
- Durable envs can be clone sources, not mutation targets.
- Exhaustive execution requires `--allow-exhaustive`.

Keep a failing lab only when you need to inspect it:

```sh
node bin/kova.mjs run \
  --target runtime:stable \
  --scenario fresh-install \
  --execute \
  --retain-on-failure
```

## For Agents

Agents should use JSON plans and reports:

```sh
node bin/kova.mjs plan --json
node bin/kova.mjs matrix plan --profile smoke --target runtime:stable --json
node bin/kova.mjs matrix run --profile smoke --target runtime:stable --execute --json
```

Kova ships repo-local agent skills:

- `.agents/skills/kova-operator`
- `.agents/skills/ocm-operator`

When using Codex or another agent from this repo, tell it to use those skills.
`kova-operator` teaches benchmark workflows, evidence rules, safety model, and
report handoff format. `ocm-operator` teaches safe env cloning, local runtime
builds, upgrades, service inspection, logs, and cleanup.
