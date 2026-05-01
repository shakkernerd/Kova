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
  "outputPaths": {
    "markdown": "/path/to/report.md",
    "json": "/path/to/report.json"
  },
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
  "auth": {
    "schemaVersion": "kova.auth.report.v1",
    "requestedMode": "mock",
    "credentialStore": {
      "schemaVersion": "kova.credentials.summary.v1",
      "home": "/Users/example/.kova/credentials"
    },
    "live": {
      "available": false,
      "providerId": "openai",
      "method": "mock",
      "envVars": ["OPENAI_API_KEY"],
      "reason": "no live provider configured",
      "environmentDependent": false
    }
  },
  "performance": {
    "schemaVersion": "kova.performance.v1",
    "repeat": 3,
    "groupCount": 1,
    "unstableGroupCount": 0,
    "groups": []
  },
  "baseline": null,
  "gate": null,
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

`outputPaths` records the Markdown and JSON paths for the report itself. The
matrix receipt also includes bundle and checksum paths after bundling.

`gate` is normally `null`. When `kova matrix run --gate` is used, it contains
the release gate verdict, blocking/warning counts, required scenario policy, and
failure cards.

`performance` is present on run and matrix reports. It keeps individual scenario
records untouched and adds aggregate stats grouped by scenario, surface, and
state.

`baseline` is normally `null`. When `--baseline` is used, it contains the
baseline store path and comparison results. When `--save-baseline` is used, it
also contains the saved baseline receipt.

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
- `auth`: selected run-level auth policy for this scenario; secret values are
  always redacted
- `thresholds`: scenario threshold contract
- `collectorArtifactDirs`: stable per-record artifact directories used by
  collectors
- `measurements`: evaluated measurements
- `violations`: threshold or behavior violations
- `phases`: commands, results, and metrics by phase
- `finalMetrics`: service/process snapshot before cleanup
- `cleanup`: cleanup result
- `retainedReason`: why a retained env was kept, such as `keep-env` or
  `failure`
- `cleanupResult`: cleanup command evidence

`cleanupResult.attempts` is present when cleanup retry evidence is available.
Markdown stays concise and shows the attempt count only when more than one
attempt was needed.

## Phase Result

Executed phases include:

- `commands`: commands Kova ran
- `results`: status, duration, stdout/stderr snippets, timeout state
- `metrics`: service and process snapshot after the phase

Successful command stdout/stderr may be present in JSON but should not be pasted
by agents unless it explains a failure.

## Metrics

Metrics use explicit collector result contracts. The top-level metrics object
uses `kova.envMetrics.v1` and includes `collectors`, an ordered list of
collector receipts:

```json
{
  "schemaVersion": "kova.collectorReceipt.v1",
  "id": "readiness",
  "status": "PASS",
  "durationMs": 1200,
  "commandStatus": 0,
  "timedOut": false,
  "artifactCount": 0,
  "artifacts": [],
  "error": null
}
```

Records expose `collectorArtifactDirs` with schema
`kova.collectorArtifactDirs.v1`. This makes artifact ownership explicit for
agents and prevents collectors from hiding files in ad hoc paths:

- `collectors`: log tails and lightweight collector output
- `openclaw`: OpenClaw-emitted timeline artifacts
- `resourceSamples`: JSONL resource samples
- `nodeProfiles`: CPU/heap/trace/report artifacts emitted through Node
- `diagnostics`: copied OpenClaw diagnostic artifacts
- `heap`: captured heap snapshots
- `diagnosticReports`: captured diagnostic reports

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
- optional Node CPU profile, heap profile, trace event artifact counts, top CPU
  self-time functions parsed from `.cpuprofile` artifacts, and top heap
  allocation functions parsed from `.heapprofile` artifacts
- resource attribution by process role from `process-roles/*.json`, including
  role peak RSS, role max CPU, peak timestamps, peak process counts, and top
  role lists for RSS and CPU
- diagnostic report and heap snapshot bytes when `--deep-profile` or explicit
  heap/report capture is enabled
- diagnostic correlation findings for CPU/RSS peak windows, top profiler
  functions, slowest OpenClaw span, event-loop delay, runtime dependency
  staging, and provider/model timing
- OpenClaw diagnostics timeline availability, event count, parse errors,
  slowest spans, repeated spans, open spans, key span summaries, event-loop max,
  provider request max, and child process failures
- runtime dependency staging grouped by bundled plugin when OpenClaw emits
  `runtimeDeps.stage` spans with `pluginId` attributes

Role-specific thresholds can fail a scenario separately from total process-tree
thresholds. For example, a report can show that `gateway` exceeded memory while
`package-manager` stayed normal, or that `package-manager` spiked during local
runtime build without blaming the gateway.

When OpenClaw emits `OPENCLAW_DIAGNOSTICS_TIMELINE_PATH`, Kova stores the raw
JSONL timeline under the run artifacts and summarizes it in `metrics.timeline`.
If OpenClaw does not emit it, the collector reports `INFO` and the scenario can
still complete.

Diagnostic source-build runs can make the timeline mandatory through the active
profile. In that mode, missing timeline evidence fails the scenario because Kova
cannot inspect OpenClaw internals. NPM/release runs keep missing timelines as
informational unless the active profile explicitly requires them.

Timeline-derived measurements include:

- `openclawOpenSpanCount`: number of `span.start` events without a matching
  `span.end` or `span.error`
- `openclawOpenRequiredSpanCount`: open spans that match required diagnostics
  for the surface/profile
- `openclawOpenSpans`: compact open-span evidence with name, age, phase,
  span id, parent span id, plugin id, provider, and operation when available
- `openclawKeySpans`: compact summaries for OpenClaw's required operational
  spans: `gateway.startup`, `gateway.ready`, `config.normalize`,
  `plugins.metadata.scan`, `runtimeDeps.stage`, `providers.load`,
  `models.catalog`, `agent.turn`, and `agent.cleanup`

Open required spans are failures for diagnostic source-build runs because they
usually mean OpenClaw started a critical operation and never reported completion.

## Performance

Repeat execution is controlled with `--repeat <n>`. Kova keeps every individual
record in `records` and computes aggregate stats in `performance.groups`.

Aggregate metric fields include:

- `count`
- `min`
- `median`
- `p95`
- `max`
- `mean`
- `variance`
- `stddev`
- `relativeStddevPercent`
- `absoluteSpreadPercent`
- `classification`: `stable` or `unstable`
- `samples`

Current aggregate metrics include startup readiness, TCP listening, RSS, CPU,
event-loop delay, agent turn latency, health p95, and runtime dependency
staging.

Baseline stores use schema `kova.baselines.v1`. Baseline read/write requires
`--execute` so stored evidence comes from real OpenClaw runs, not dry-run plans.
Entries are keyed by platform, target kind, surface, state, and scenario, so
Kova can compare the same OpenClaw execution surface under the same user state
instead of comparing unrelated commands.

Baseline comparison uses schema `kova.baselineComparison.v1`. Regressions are
reported by metric with baseline median, current median, p95 values, threshold
percent, and increase percent. Release gates treat baseline regressions as
blocking performance regressions, so a functional pass can still become
`DO_NOT_SHIP` when OpenClaw gets materially slower or heavier.

## Run Receipt

`kova run --json` prints a receipt instead of text paths:

```json
{
  "schemaVersion": "kova.run.receipt.v1",
  "mode": "dry-run",
  "runId": "kova-2026-04-29T000000Z",
  "reportPath": "/path/to/report.md",
  "jsonPath": "/path/to/report.json",
  "performance": {
    "repeat": 3,
    "groupCount": 1,
    "unstableGroupCount": 0,
    "baselineRegressionCount": 0,
    "missingBaselineCount": 0,
    "savedBaselinePath": "/path/to/baselines.json"
  },
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
definitions, state fixture definitions, surface definitions, process-role
definitions, profile summaries, platform metadata, and supports filtering with
`--scenario`, `--state`, and `--profile`.

Every scenario must declare a `surface`. Registry validation fails before plan,
run, or matrix output if a scenario references an unknown surface, a surface
references an unknown process role, or a profile references an unknown
scenario/state/surface.

Every state must declare traits, compatible surfaces, incompatible surfaces,
risk area, owner area, setup evidence, and cleanup guarantees. Registry
validation rejects unknown state traits, unknown surface references, and profile
entries that pair a scenario with a state that is not allowed for the scenario's
surface.

Plan JSON includes `coverage`:

- `surfaces`: each surface with scenario count and mapped scenarios
- `scenarioSurfaceMap`: direct scenario-to-surface mappings
- `surfacesWithoutScenarios`: declared surfaces with no scenario yet
- `profiles`: per-profile selected surfaces, scenarios, states, required
  coverage, coverage gaps, state trait coverage, state/surface pairs, and
  trait/surface coverage

## Summary Output

`kova report summarize <report.json> --json` returns a compact agent-facing
view of each scenario with status, cleanup, failed command, concise failure
reason, violations, and a small measurement summary. Agents should use this
before reading the full report when they only need pass/fail and high-signal
performance evidence.

When a report contains failures, the structured summary also includes
`failureBrief` with:

- `decision`
- `primaryBlocker`
- `why`
- compact `evidence`
- `likelyOwner`
- `fixerPrompt`

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
  "retainedGateArtifacts": null,
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

## Release Gate

`kova matrix run --profile release --target <selector> --execute --gate` uses
the existing matrix runner and adds:

```json
{
  "schemaVersion": "kova.gate.v1",
  "enabled": true,
  "profileId": "release",
  "policyId": "openclaw-release",
  "verdict": "DO_NOT_SHIP",
  "ok": false,
  "complete": true,
  "partial": false,
  "missingRequiredCount": 0,
  "blockingCount": 1,
  "warningCount": 0,
  "infoCount": 0,
  "required": [],
  "warning": [],
  "coverage": {
    "platforms": {
      "blocking": ["darwin-arm64"],
      "warning": ["linux-x64", "linux-arm64", "wsl2"]
    },
    "states": {
      "blocking": ["fresh"]
    },
    "traits": {
      "blocking": ["fresh-user"]
    },
    "stateSurfaces": {
      "blocking": ["release-runtime-startup:fresh"]
    },
    "surfaces": {
      "blocking": ["release-runtime-startup"]
    },
    "scenarios": {
      "blocking": ["release-runtime-startup"]
    }
  },
  "cards": []
}
```

Verdicts:

- `SHIP`: every blocking gate entry passed; warnings may still exist.
- `DO_NOT_SHIP`: a blocking OpenClaw scenario failed.
- `PARTIAL`: selected scenarios did not fail, but required release coverage is
  incomplete, usually because this was a filtered gate slice or a platform/state
  requirement was missing.
- `BLOCKED`: Kova cannot make a ship/no-ship decision, usually because the run
  was not executed, skipped, or blocked by harness/provisioning behavior.

Filtered gate slices are partial. They can produce `DO_NOT_SHIP` when a selected
blocking scenario fails, but they cannot produce `SHIP` because required gate
coverage is missing. A passing filtered slice remains `PARTIAL`.

Release profiles may define explicit platform/surface/scenario/state/trait and
state-surface coverage. Missing blocking coverage prevents `SHIP`; missing
warning coverage creates warning cards. Platform coverage keys include
`darwin-arm64`, `linux-x64`, `linux-arm64`, and `wsl2` where detectable.

Gate cards are concise fixer records. They include severity, scenario/state,
status, summary, expected/actual, impact, likely owner, failed command when
available, violation text, and compact measurements. Gate reports also group
cards by likely OpenClaw subsystem and generate compact subsystem fixer briefs.
The matrix receipt includes only the gate verdict/count summary; the full cards
and subsystem briefs live in the JSON report.

When `--baseline` is used, the gate also includes a compact historical baseline
summary with regression count, missing baseline count, and regressed scenario
groups. Baseline regressions remain blocking gate cards.

For non-ship gate runs, Kova retains a durable copy under
`artifacts/release-gates/<runId>/`:

```text
report.md
report.json
paste-summary.txt
<runId>-bundle.tar.gz
<runId>-bundle.tar.gz.sha256
retained-artifacts.json
```

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
