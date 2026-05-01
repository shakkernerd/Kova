# Codex Handoff Examples

Use these when pasting Kova findings into a fixer agent. Keep the prompt tied to
the Kova report evidence. Do not paste raw logs unless the fixer asks for them.

## OpenClaw Pre-Provider Stall

```text
Investigate OpenClaw agent turn latency.

Kova evidence:
- Scenario: <scenario>
- Turn: <cold|warm|failed>
- Total turn: <ms>
- Pre-provider: <ms>
- Provider work: <ms>
- Provider request count: <count>
- Relevant spans: <agent.prepare/models.catalog/channel.plugin/runtimeDeps.stage/unknown>
- Resource role peaks: <gateway/agent-cli/plugin-cli>

The provider was fast, but OpenClaw spent most of the turn before provider
work. Find the cold path causing the delay, fix it without hiding provider
errors, and add a regression check for the hot path.
```

## Provider Timeout Or Streaming Stall

```text
Investigate OpenClaw provider failure containment.

Kova evidence:
- Scenario: <agent-provider-timeout|agent-provider-streaming-stall>
- Provider issue: <provider-timeout|streaming-stall>
- Command timed out: <true|false>
- Gateway after failure: <running/backoff/stopped>
- Status after failure: <works/fails>
- Process leaks: <count and first leaked role/pid>

OpenClaw must surface the provider failure clearly, cancel or bound the turn,
keep gateway/status/TUI/dashboard responsive, and leave no child processes
behind.
```

## Malformed Or HTTP Provider Error

```text
Investigate OpenClaw provider error handling.

Kova evidence:
- Scenario: <scenario>
- Provider issue: <malformed-response|provider-error|provider-http-error>
- Provider status/route/model: <status route model>
- Assistant response present: <true|false>
- Gateway after failure: <state>
- User-facing error text: <summary>

OpenClaw should map provider failures to actionable user-facing errors while
keeping the session and gateway usable.
```

## Provider Recovery

```text
Investigate OpenClaw provider recovery behavior.

Kova evidence:
- Scenario: agent-provider-recovery
- First provider issue: <provider-error/timeout/etc>
- Later provider success: <true|false>
- Recovery turn latency: <ms>
- Gateway health after recovery: <state/health failures>

Confirm whether retry/recovery behavior is intentional. If it is, keep it
bounded and visible. If it is not, fix the retry path and preserve gateway
responsiveness.
```

## Leaked Child Process

```text
Investigate OpenClaw child process lifecycle after an agent turn.

Kova evidence:
- Scenario: <scenario>
- Failed turn: <phase/label>
- Leaked process count: <count>
- First leak: <role pid command>
- Gateway after turn: <state>
- Cleanup duration: <ms>

Find which OpenClaw component owns the leaked process, make cleanup deterministic
on success, failure, timeout, and interrupt, and add coverage for the process
role that leaked.
```

## Startup Or Runtime Dependency Regression

```text
Investigate OpenClaw startup/runtime dependency performance.

Kova evidence:
- Scenario: <release-runtime-startup|bundled-runtime-deps|fresh-install>
- Time to listening: <ms>
- Time to health ready: <ms>
- Runtime deps staging: <ms>
- Missing dependency/plugin errors: <count>
- Resource role peaks: <gateway/package-manager/runtime-staging>
- Timeline spans: <available/missing; slowest span>

OpenClaw should not block startup on repeated dependency staging, plugin
metadata scans, or config normalization. Find the slow phase and make repeated
starts reuse cached state safely.
```
