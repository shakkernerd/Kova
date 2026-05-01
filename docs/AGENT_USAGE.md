# Agent Usage

Kova is built so Codex and other agents can run serious OpenClaw runtime
validation without needing custom instructions each time.

## Operating Model

- Kova tests OpenClaw.
- OCM provisions the lab.
- Use the `ocm-operator` skill when available before executing real scenarios.
- Durable user envs must be cloned before upgrade or migration testing.
- JSON is the agent contract.
- Markdown is the human report.

The `ocm-operator` skill is not part of Kova's product surface. It is an agent
instruction layer that helps Codex use OCM correctly while Kova remains focused
on OpenClaw runtime validation.

Permanent skill source:

```text
https://github.com/shakkernerd/ocm/tree/main/skills/ocm-operator
```

Install it if missing:

```sh
codex skills install https://github.com/shakkernerd/ocm/tree/main/skills/ocm-operator
```

## Standard Agent Flow

1. Verify prerequisites:

If available, first load/read the `ocm-operator` skill so OCM operations are
performed with the right safety model.

```sh
node bin/kova.mjs setup --ci --json
node bin/kova.mjs setup --non-interactive --auth env-only --provider openai --env-var OPENAI_API_KEY --json
node bin/kova.mjs self-check --json
```

2. Inspect scenarios:

```sh
node bin/kova.mjs plan --json
node bin/kova.mjs plan --scenario fresh-install --state missing-plugin-index --json
node bin/kova.mjs matrix plan --profile smoke --target runtime:stable --json
node bin/kova.mjs matrix plan --profile release --target runtime:stable --include tag:plugins --exclude state:broken-plugin-deps --json
```

3. Dry-run the intended scenario:

```sh
node bin/kova.mjs run --target runtime:stable --scenario fresh-install --state fresh --json
```

Kova defaults to `--auth mock`, so dry-runs and executions model an OpenClaw
assistant env with deliberate model auth unless the scenario/state explicitly
tests missing or broken auth. Use `--auth live` only after credentials are
configured with `kova setup`. Live runs are environment-dependent evidence, not
deterministic baseline evidence.

Interactive `kova setup` asks provider first and then auth method. Both prompts
accept either the displayed number or the name.
For `external-cli`, Kova must verify the selected CLI and auth evidence before
setup passes. `openai + external-cli` uses Codex CLI; `anthropic + external-cli`
uses Claude CLI. External CLI fallback is only valid when setup explicitly
selected `--fallback-policy external-cli`. Use API-key or env-only auth for
`custom-openai`.
For supported API-key/env-only providers, live auth setup runs OpenClaw's own
non-interactive `onboard` path with env-backed SecretRefs. Live auth paths that
do not expose a stable OpenClaw command path are labeled fixture setup; do not
cite those runs as proof that OpenClaw onboarding/auth UX passed.

4. Execute one scenario explicitly:

```sh
node bin/kova.mjs run --target runtime:stable --scenario fresh-install --state missing-plugin-index --execute --json
```

For broader coverage, run a named matrix:

```sh
node bin/kova.mjs matrix run --profile smoke --target runtime:stable --execute --json
```

Use matrix filters to keep runs deliberate:

```sh
node bin/kova.mjs matrix run --profile release --target runtime:stable --include scenario:fresh-install --execute --json
node bin/kova.mjs matrix run --profile release --target runtime:stable --include tag:plugins --exclude state:broken-plugin-deps --parallel 2 --execute --json
node bin/kova.mjs matrix run --profile release --target local-build:/path/to/openclaw --include scenario:release-runtime-startup --execute --gate --json
```

Matrix runs automatically produce a bundle path in the JSON receipt.
Filtered gate slices are reject-only: a selected blocking scenario failure means
`DO_NOT_SHIP`, while a passing partial slice remains `PARTIAL` because it cannot
approve the full release gate.
Non-ship gates retain a durable artifact directory under
`artifacts/release-gates/<runId>/`.

Only update performance baselines from a reviewed-good run:

```sh
node bin/kova.mjs matrix run --profile smoke --target runtime:stable --repeat 3 --execute --save-baseline --reviewed-good --json
```

Do not pass `--reviewed-good` until the JSON/Markdown evidence is clean:
records pass, violations are empty, performance groups are stable, and any gate
or baseline comparison is not blocking. Do not save baselines from
`--node-profile`, `--heap-snapshot`, `--deep-profile`, or
`--profile-on-failure` runs; those are instrumented diagnostic runs and their
resource numbers can include profiler overhead.

5. Read the generated JSON report first. Use the Markdown report for the human
summary. For failures, start with `failureBrief` in `report summarize --json`
or the `Failure Brief` section from `report paste`.

6. Produce a compact handoff when needed:

```sh
node bin/kova.mjs report summarize reports/<run>.json --json
node bin/kova.mjs report paste reports/<run>.json
node bin/kova.mjs report compare reports/<baseline>.json reports/<current>.json --json
node bin/kova.mjs report bundle reports/<run>.json --json
```

## Target Selection

Use release-shaped targets when validating OpenClaw release behavior:

```sh
node bin/kova.mjs run --target npm:2026.4.26 --scenario fresh-install --execute
node bin/kova.mjs run --target channel:beta --scenario gateway-performance --execute
node bin/kova.mjs run --target runtime:test-build-1 --scenario plugin-lifecycle --execute
node bin/kova.mjs run --target local-build:/path/to/openclaw --scenario fresh-install --execute
```

Do not use OpenClaw source/dev commands as proof that a published package will
work.

If the target is a local OpenClaw checkout, prefer Kova's `local-build:<path>`
selector. That routes through OCM's release-shaped local runtime build instead
of a source/dev command.

## Existing User Testing

Existing-user testing must clone source state:

```sh
node bin/kova.mjs run \
  --scenario upgrade-existing-user \
  --source-env Violet \
  --from npm:2026.4.20 \
  --target npm:2026.4.27 \
  --execute
```

Focused upgrade lanes are target-specific and Kova validates the selector:

```sh
node bin/kova.mjs matrix run --profile channel-upgrade --target channel:beta --execute --json
node bin/kova.mjs matrix run --profile local-build-upgrade --target local-build:/path/to/openclaw --source-env Violet --execute --json
```

`channel-upgrade` is specifically stable-to-beta. Running it with
`channel:stable` is rejected instead of producing misleading evidence.
`local-build-upgrade` exercises stable-channel and cloned existing-user upgrades
against the release-shaped local build.

If a user wants to retain a failed env:

```sh
node bin/kova.mjs run --target runtime:stable --scenario fresh-install --execute --retain-on-failure
```

Otherwise, Kova should clean up temporary envs automatically.
Cleanup retries transient shutdown races before reporting failure. If cleanup is
still interrupted, inspect stale Kova envs with:

```sh
node bin/kova.mjs cleanup envs --json
```

Destroy only Kova-owned envs with:

```sh
node bin/kova.mjs cleanup envs --execute
```

Agents should never mutate durable envs like `Shaks` or `Violet` directly for
Kova tests unless a human explicitly asks for that exact env to be changed.

## Reporting Rules

When reporting back to a human:

- lead with `PASS`, `FAIL`, `BLOCKED`, or `SKIPPED`
- include the scenario id and OpenClaw target
- include the failing command only when there is a failure
- include concise evidence from the JSON report
- include gateway PID/RSS/CPU metrics when they explain the issue
- include health failure and health p95 metrics when startup or responsiveness
  is the concern
- include threshold violations from the report before raw logs
- classify OpenClaw failures separately from harness/provisioning blockers
- mention cleanup status
- use `kova report paste <report.json>` as the starting point for fixer
  handoffs

Do not paste large successful command outputs. They are stored in the JSON
report when needed.

## Failure Meaning

- `PASS`: OpenClaw behavior met the scenario contract.
- `FAIL`: OpenClaw ran but violated the scenario contract.
- `BLOCKED`: Kova, OCM, platform, or prerequisites prevented meaningful
  OpenClaw testing.
- `SKIPPED`: scenario was intentionally not run.

## Production Direction

Kova should stay:

- deterministic in command shape and report schema
- quiet by default
- explicit before destructive work
- fast enough for iterative agent use
- complete enough for release confidence
- strict about cleanup
- structured enough for CI and historical comparisons
