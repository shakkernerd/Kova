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
node bin/kova.mjs doctor --json
```

2. Inspect scenarios:

```sh
node bin/kova.mjs plan --json
node bin/kova.mjs scenarios list --json
node bin/kova.mjs scenarios show fresh-install --json
```

3. Dry-run the intended scenario:

```sh
node bin/kova.mjs run --target runtime:stable --scenario fresh-install --json
```

4. Execute one scenario explicitly:

```sh
node bin/kova.mjs run --target runtime:stable --scenario fresh-install --execute --json
```

5. Read the generated JSON report first. Use the Markdown report for the human
summary.

6. Produce a compact handoff when needed:

```sh
node bin/kova.mjs report summarize reports/<run>.json --json
node bin/kova.mjs report paste reports/<run>.json
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

If a user wants to retain a failed env:

```sh
node bin/kova.mjs run --target runtime:stable --scenario fresh-install --execute --keep-env
```

Otherwise, Kova should clean up temporary envs automatically.

Agents should never mutate durable envs like `Shaks` or `Violet` directly for
Kova tests unless a human explicitly asks for that exact env to be changed.

## Reporting Rules

When reporting back to a human:

- lead with `PASS`, `FAIL`, `BLOCKED`, or `SKIPPED`
- include the scenario id and OpenClaw target
- include the failing command only when there is a failure
- include concise evidence from the JSON report
- include gateway PID/RSS/CPU metrics when they explain the issue
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
