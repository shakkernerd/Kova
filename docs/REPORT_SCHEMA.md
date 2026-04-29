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
  "summary": {
    "total": 1,
    "statuses": {
      "PASS": 1
    }
  },
  "records": []
}
```

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
- runtime release version/channel
- child PID
- RSS in KB/MB
- CPU percent
- health URL/status/duration
- health sample counts and p50/p95/max latency
- gateway log diagnostic counts for missing dependency errors, plugin load
  failures, runtime dependency mentions, metadata scan mentions, and config
  normalization mentions

Future metrics will add event-loop delay, heap reports, runtime dependency
staging timings, structured plugin metadata scan counts, and structured config
normalization counts.

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

## Compare Report

`kova compare <baseline.json> <current.json> --json` prints:

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
