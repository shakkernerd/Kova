# AGENTS.md

Kova is an OpenClaw runtime validation lab.

Kova uses OCM as the environment/runtime control plane, but Kova is not an OCM
test suite. Reports, scenario names, failures, and recommendations must stay
focused on OpenClaw behavior.

Kova is agent-first and human-usable. Agents should prefer structured JSON
outputs for planning and report consumption, while Markdown reports should stay
short enough for humans to scan.

If the agent runtime has an `ocm-operator` skill available, use it before
running real Kova scenarios. The skill teaches the agent how to use OCM safely:
env cloning, runtime selection, local release builds, service status, logs,
cleanup, and durable user-state boundaries. Kova remains OpenClaw-focused; the
skill only improves the harness operations.

The repo-local OCM skill lives at `.agents/skills/ocm-operator`.

## Core Rules

- Treat OpenClaw as the product under test.
- Treat OCM as harness infrastructure.
- Use the `ocm-operator` skill when available before executing Kova scenarios
  that create envs, clone existing state, build local runtimes, upgrade envs, or
  inspect services/logs.
- Prefer release-shaped OpenClaw runtimes over source/dev commands when judging
  release behavior.
- Do not mutate durable user envs directly. Clone existing user envs before
  testing upgrade or migration scenarios.
- Keep reports quiet: pass/fail/blocker, concise evidence, and actionable
  OpenClaw owner area.
- Prefer `node bin/kova.mjs plan --json` when an agent needs to choose
  scenarios programmatically.
- Prefer the JSON report for detailed evidence and the Markdown report for
  human summaries.
- Do not parse verbose command stdout from Markdown. Successful command stdout
  belongs in JSON only.
- Clean up temporary envs and artifacts created by executed scenarios unless the
  user explicitly asks to retain them.
- If a scenario fails because Kova or OCM could not provision the lab, mark it
  `BLOCKED`. If OpenClaw starts but is slow, broken, missing files, leaking
  memory, stalling health, or failing plugins, mark it `FAIL`.

## Command Style

Use the local CLI during development:

```sh
node bin/kova.mjs help
node bin/kova.mjs plan
node bin/kova.mjs plan --json
node bin/kova.mjs run --target npm:2026.4.27 --scenario fresh-install
```

`kova run` is safe by default and currently writes dry-run reports. Real
execution must remain explicit and cleanup-aware.
