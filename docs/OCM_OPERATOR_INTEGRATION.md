# OCM Operator Integration

Kova uses OCM as the OpenClaw environment and runtime control plane. Agents that
have access to an `ocm-operator` skill should load it before executing real Kova
scenarios.

Permanent skill source:

```text
https://github.com/shakkernerd/ocm/tree/main/skills/ocm-operator
```

Install command:

```sh
codex skills install https://github.com/shakkernerd/ocm/tree/main/skills/ocm-operator
```

## Why

Kova scenarios can create disposable envs, clone existing user state, build local
release-shaped runtimes, upgrade envs, inspect services, collect logs, and clean
up. Those operations are exactly where agents need OCM-specific safety rules.

The `ocm-operator` skill helps agents understand:

- envs are the isolation boundary for `OPENCLAW_HOME`
- durable user envs must be cloned before tests
- release behavior must use package/runtime builds, not source/dev commands
- `ocm @<env> -- ...` is the normal way to run OpenClaw inside an env
- service status and logs should be collected through OCM
- cleanup should use `ocm env destroy <env> --yes`
- local OpenClaw source should be tested through release-shaped runtime builds

## Boundary

The skill is an agent operating guide. It is not a Kova runtime dependency.

Kova should remain usable by humans and CI with only:

- Node.js
- OCM on `PATH`
- OpenClaw runtime/network prerequisites for the selected scenario

## Agent Rule

Before running a real scenario, an agent should:

1. Load/read `ocm-operator` if available.
2. Run `node bin/kova.mjs setup --json`.
3. Run `node bin/kova.mjs plan --json`.
4. Dry-run the intended scenario.
5. Execute exactly the intended scenario with `--execute`.
6. Read the JSON report.
7. Summarize only the important OpenClaw findings and cleanup status.
