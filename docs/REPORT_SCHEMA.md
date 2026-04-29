# Report Schema

Kova's JSON reports are the source of truth for agents, CI, regression
comparison, and human summaries.

Current report schema:

```text
kova.report.v1
```

## Top-Level Report

```json
{
  "schemaVersion": "kova.report.v1",
  "generatedAt": "2026-04-29T00:00:00.000Z",
  "runId": "kova-2026-04-29T000000Z",
  "mode": "dry-run",
  "profile": null,
  "target": "runtime:stable",
  "from": null,
  "state": {
    "id": "fresh",
    "title": "Fresh OpenClaw User",
    "objective": "A new isolated OpenClaw home..."
  },
  "platform": {
    "os": "darwin",
    "arch": "arm64",
    "release": "25.3.0",
    "node": "v24.13.0"
  },
  "targetCleanup": null,
  "summary": {
    "total": 1,
    "statuses": {
      "PASS": 1
    }
  },
  "records": []
}
```

`targetCleanup` is normally `null`. For `local-build:<repo>` targets, it records
whether Kova removed the generated temporary OCM runtime after execution, or why
it retained that runtime.

## Record

Each record represents one OpenClaw scenario.

Important fields:

- `scenario`: stable scenario id
- `title`: human title
- `status`: `PASS`, `FAIL`, `BLOCKED`, `SKIPPED`, or `DRY-RUN`
- `target`: OpenClaw target selector
- `from`: optional source selector
- `state`: OpenClaw user-state fixture
- `envName`: disposable Kova/OCM env name
- `thresholds`: scenario threshold contract
- `measurements`: evaluated measurements
- `violations`: threshold or behavior violations
- `phases`: commands, results, and metrics by phase
- `finalMetrics`: service/process snapshot before cleanup
- `cleanup`: cleanup result
- `retainedReason`: why a retained env was kept, such as `keep-env` or
  `failure`
- `cleanupResult`: cleanup command evidence

## Phase Result

Executed phases include:

- `commands`: commands Kova ran
- `results`: status, duration, stdout/stderr snippets, timeout state
- `metrics`: service and process snapshot after the phase

Successful command stdout/stderr may be present in JSON but should not be pasted
by agents unless it explains a failure.

## Metrics

Current metrics include:

- OCM service command status
- gateway state
- desired/running flags
- gateway port
- TCP listening probe latency
- readiness polling attempts, time to TCP listening, and time to health ready
- runtime release version/channel
- child PID
- RSS in KB/MB
- CPU percent
- health URL/status/duration
- health sample counts and p50/p95/max latency
- cold start, warm restart, upgrade, status, plugin, and model command timing
- gateway restart counts
- gateway log diagnostic counts for missing dependency errors, plugin load
  failures, runtime dependency mentions, metadata scan mentions, and config
  normalization mentions
- provider/model load and timeout signals
- event-loop delay signals
- V8 diagnostic report and heap snapshot file counts
- optional Node CPU profile, heap profile, trace event artifact counts, and
  top CPU self-time functions parsed from `.cpuprofile` artifacts
- OpenClaw diagnostics timeline availability, event count, parse errors,
  slowest spans, repeated spans, event-loop max, provider request max, and child
  process failures
- runtime dependency staging grouped by bundled plugin when OpenClaw emits
  `runtimeDeps.stage` spans with `pluginId` attributes

When OpenClaw emits `OPENCLAW_DIAGNOSTICS_TIMELINE_PATH`, Kova stores the raw
JSONL timeline under the run artifacts and summarizes it in `metrics.timeline`.
If OpenClaw does not emit it, the collector reports `INFO` and the scenario can
still complete.

## Run Receipt

`kova run --json` prints a receipt instead of text paths:

```json
{
  "schemaVersion": "kova.run.receipt.v1",
  "mode": "dry-run",
  "runId": "kova-2026-04-29T000000Z",
  "reportPath": "/path/to/report.md",
  "jsonPath": "/path/to/report.json",
  "summary": {
    "total": 1,
    "statuses": {
      "DRY-RUN": 1
    }
  }
}
```

Agents should use `jsonPath` to read detailed evidence.

## Plan Output

`kova plan --json` is the discovery contract for agents. It includes scenario
definitions, state fixture definitions, profile summaries, platform metadata,
and supports filtering with `--scenario`, `--state`, and `--profile`.

## Summary Output

`kova report summarize <report.json> --json` returns a compact agent-facing
view of each scenario with status, cleanup, failed command, concise failure
reason, violations, and a small measurement summary. Agents should use this
before reading the full report when they only need pass/fail and high-signal
performance evidence.

## Matrix Receipt

`kova matrix run --json` prints a receipt for one combined profile report:

```json
{
  "schemaVersion": "kova.matrix.run.receipt.v1",
  "mode": "dry-run",
  "runId": "kova-2026-04-29T000000Z",
  "profile": {
    "id": "smoke",
    "title": "Smoke Matrix",
    "entryCount": 4
  },
  "reportPath": "/path/to/report.md",
  "jsonPath": "/path/to/report.json",
  "bundlePath": "/path/to/bundle.tar.gz",
  "checksumPath": "/path/to/bundle.tar.gz.sha256",
  "summary": {
    "total": 4,
    "statuses": {
      "DRY-RUN": 4
    }
  }
}
```

Matrix reports use the same `kova.report.v1` record structure. Each record
represents one scenario/state entry from the selected profile.

Matrix reports include a `controls` object with include/exclude filters,
fail-fast state, requested and actual parallelism, and whether parallelism was
adjusted for safety.

When `--report-dir` is provided, the automatic matrix bundle is written under
that same directory with the Markdown and JSON reports.

Matrix filters accept `scenario:<id>`, `state:<id>`, `tag:<tag>`, or a bare
scenario/state/tag value. Entries can be skipped by platform eligibility and
will appear as `SKIPPED` records with `skipReason`.

## Compare Report

`kova report compare <baseline.json> <current.json> --json` prints:

```json
{
  "schemaVersion": "kova.compare.v1",
  "ok": false,
  "regressionCount": 1,
  "scenarios": [
    {
      "key": "fresh-install:fresh",
      "status": "REGRESSED",
      "regressions": [
        {
          "metric": "peakRssMb",
          "message": "peakRssMb increased by 120..."
        }
      ]
    }
  ]
}
```

Comparison currently detects status regressions, missing scenario/state entries,
and increases in peak RSS, health failures, health p95, missing dependency
errors, plugin load failures, metadata scan mentions, and config normalization
mentions.

## Artifact Bundle

`kova report bundle <report.json> --json` prints a bundle receipt:

```json
{
  "schemaVersion": "kova.artifact.bundle.v1",
  "runId": "kova-2026-04-29T000000Z",
  "outputPath": "/path/to/bundle.tar.gz",
  "checksumPath": "/path/to/bundle.tar.gz.sha256",
  "sha256": "...",
  "included": {
    "reportJson": true,
    "reportMarkdown": true,
    "pasteSummary": true,
    "runArtifacts": false
  }
}
```
