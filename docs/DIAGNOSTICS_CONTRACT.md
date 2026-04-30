# Kova OpenClaw Diagnostics Contract

Kova needs OpenClaw to expose low-noise runtime diagnostics while real user
flows run. The raw data belongs in artifacts; reports should only summarize the
signals that explain startup, plugin, provider, resource, and agent latency.

This contract is optional at runtime. If OpenClaw does not emit the file, Kova
must keep running and report diagnostics as unavailable.

## Environment

Kova sets these variables for OpenClaw commands it launches:

```sh
OPENCLAW_DIAGNOSTICS=timeline
OPENCLAW_DIAGNOSTICS_RUN_ID=<kova-run-id>
OPENCLAW_DIAGNOSTICS_ENV=<kova-env-name>
OPENCLAW_DIAGNOSTICS_TIMELINE_PATH=<artifact-dir>/openclaw/timeline.jsonl
OPENCLAW_DIAGNOSTICS_EVENT_LOOP=1
```

When `--deep-profile` is enabled, Kova also launches OpenClaw commands with
Node/V8 diagnostic flags through `NODE_OPTIONS`:

```sh
--cpu-prof
--heap-prof
--trace-events-enabled
--heapsnapshot-signal=SIGUSR2
--report-on-signal
--report-signal=SIGUSR1
```

Kova stores the resulting raw profiles, trace events, diagnostic reports, and
heap snapshots under the run artifact directory. Reports should summarize top
functions, peak windows, and artifact counts rather than paste raw profiler
content.

OpenClaw should create the parent directory when needed and append JSON Lines to
`OPENCLAW_DIAGNOSTICS_TIMELINE_PATH`. Writes should be best-effort and must not
block the gateway hot path for long periods.

## Event Envelope

Each line is one JSON object:

```json
{
  "schemaVersion": "openclaw.diagnostics.v1",
  "type": "span.end",
  "timestamp": "2026-04-29T15:30:00.000Z",
  "runId": "kova-2026-04-29T153000Z",
  "envName": "kova-fresh-install-fresh-...",
  "pid": 12345,
  "phase": "startup",
  "name": "runtimeDeps.stage",
  "spanId": "span-1",
  "parentSpanId": "span-0",
  "durationMs": 1842,
  "attributes": {
    "pluginId": "browser",
    "dependencyCount": 12
  }
}
```

Required fields: `schemaVersion`, `type`, `timestamp`, `name`.

Recommended fields: `runId`, `envName`, `pid`, `phase`, `spanId`,
`parentSpanId`, `durationMs`, `attributes`.

## Event Types

- `span.start`: a timed operation began.
- `span.end`: a timed operation completed successfully.
- `span.error`: a timed operation failed; include `errorName` and `errorMessage`.
- `mark`: an instantaneous lifecycle point.
- `eventLoop.sample`: event loop delay histogram sample.
- `provider.request`: provider/model request or catalog operation timing.
- `childProcess.exit`: child process lifetime and exit state.

## Span Names

Use stable names so Kova can compare runs:

- `gateway.startup`
- `gateway.ready`
- `config.load`
- `config.normalize`
- `plugins.metadata.scan`
- `plugins.load`
- `runtimeDeps.stage`
- `providers.load`
- `models.catalog`
- `agent.turn`
- `agent.cleanup`
- `mcp.runtime.start`
- `mcp.runtime.stop`

## Event Loop Samples

```json
{
  "schemaVersion": "openclaw.diagnostics.v1",
  "type": "eventLoop.sample",
  "timestamp": "2026-04-29T15:30:01.000Z",
  "name": "eventLoop",
  "p50Ms": 8,
  "p95Ms": 42,
  "p99Ms": 91,
  "maxMs": 214,
  "activeSpanName": "plugins.metadata.scan"
}
```

## Provider Requests

```json
{
  "schemaVersion": "openclaw.diagnostics.v1",
  "type": "provider.request",
  "timestamp": "2026-04-29T15:30:02.000Z",
  "name": "provider.request",
  "provider": "openai-codex",
  "operation": "models.list",
  "durationMs": 1220,
  "ok": true
}
```

## Child Processes

```json
{
  "schemaVersion": "openclaw.diagnostics.v1",
  "type": "childProcess.exit",
  "timestamp": "2026-04-29T15:30:03.000Z",
  "name": "childProcess.exit",
  "command": "mcp-server",
  "durationMs": 340,
  "exitCode": 0,
  "signal": null
}
```

## Report Policy

Kova stores the complete timeline as an artifact. Human reports should show:

- whether the timeline was present
- event count and parse error count
- slowest spans
- repeated span names
- max event-loop delay
- slowest provider request
- slowest child process and failed child process count
- runtime dependency staging grouped by plugin id when available

Raw event dumps belong in JSON artifacts, not Markdown summaries.
