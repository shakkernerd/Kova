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
    "json": "/path/to/report.json",
    "summary": "/path/to/report.summary.json"
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
    "modelId": null,
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
    "resourceMeasurementScope": "product",
    "resourceHeadlineContract": "primary-role-product-scope-v3",
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

`targetIdentity` is optional exact-candidate evidence for `npm:<semver>` targets:

```json
{
  "schemaVersion": "kova.target.identity.v1",
  "requestedSelector": "npm:2026.7.1-2",
  "resolvedVersion": "2026.7.1-2",
  "npmIntegrity": "sha512-<canonical base64 encoding of 64 digest bytes>",
  "gitSha": null,
  "buildDigest": null
}
```

Kova captures this identity immediately after a successful target `ocm start`
or `ocm upgrade`, using the runtime name in that operation's JSON receipt and
`ocm runtime show <bound-name> --json`. The installed runtime must report the
requested version and a canonical SHA-512 npm integrity. Global inventory,
selector matches, and post-cleanup version probes never establish identity.
The captured value survives later scenario failures, rollback, and cleanup.

Dry runs, moving selectors, failed provisioning, missing metadata, and invalid
digests omit `targetIdentity`; the requested `target` remains diagnostic only.
Command results retain the captured identity (or `null` for an unattested target
binding attempt), and scenario records emit it only when their target binding
attempts agree. A report emits one identity only when every executed record has
the same identity; skipped records do not contribute. Mixed or missing bindings
omit the report-level field while preserving each record's evidence.

Run and matrix JSON receipts and bundle `manifest.json` copy the report's
optional identity verbatim. An identity proves which npm candidate was bound,
not that the scenario passed or that OpenClaw reached readiness.

With OCM installed, `node tests/report-identity-ocm.mjs artifacts/identity-proof`
reproduces the failed-provisioning fixture and a successful binding through both
run and matrix receipts. It uses an isolated OCM store, a loopback registry, and
a tiny fixture package; this is report-path proof, not OpenClaw readiness proof.

Report bundles include `artifact-index.json` at the archive root. The index
lists every file staged into the bundle with its original relative `path`,
portable `archivePath`, byte size, and SHA-256 digest. Kova maps names that
USTAR cannot represent to deterministic archive paths while preserving the
original evidence name in the index. `publicationOmissions` records omitted
path, bytes, SHA-256, and reason when the complete raw
`artifacts/node-profiles/node-trace-*.json` and `.log` class must be excluded
to satisfy publication limits. CPU profiles, heap profiles, and similarly
named files outside that exact class remain included.

`outputPaths` records the Markdown, full JSON, and compact summary JSON paths
for the report itself. The matrix receipt also includes bundle and checksum
paths after bundling.

`gate` is normally `null`. When `kova matrix run --gate` is used, it contains
the release gate verdict, blocking/warning counts, required scenario policy, and
failure cards.

`performance` is present on run and matrix reports. It keeps individual scenario
records untouched and adds aggregate stats grouped by scenario, surface, and
state. Resource groups use `resourceMeasurementScope: "product"` and
`resourceHeadlineContract: "primary-role-product-scope-v3"`; harness and cleanup
work remains visible as evidence but does not contribute to resource headlines
or gates. Version 3 assigns command roles only where no process-specific role
owns the process, tracks the validated mock-provider PID explicitly, and emits
one primary-role threshold finding per metric.

`baseline` is normally `null`. When `--baseline` is used, it contains the
baseline store path and comparison results. When `--save-baseline` is used, it
also contains the saved baseline receipt.

## Record

Each record represents one OpenClaw scenario.

Important fields:

- `scenario`: stable scenario id
- `title`: human title
- `status`: `PASS`, `FAIL`, `INCOMPLETE`, `BLOCKED`, `SKIPPED`, or `DRY-RUN`
- `target`: OpenClaw target selector
- `from`: optional source selector
- `state`: OpenClaw user-state fixture
- `envName`: disposable Kova/OCM env name
- `auth`: selected run-level auth policy for this scenario; secret values are
  always redacted
- `thresholds`: scenario threshold contract
- `collectorArtifactDirs`: stable per-record artifact directories used by
  collectors
- `evidenceLedger`: compact machine-readable proof metadata for planned or
  executed commands and later scenario proof obligations
- `measurements`: evaluated measurements
- `measurements.resourceMeasurementScope`: scope used for resource gates
- `measurements.resourceHeadlineContract`: versioned resource accounting
  identity used to decide whether historical resource values are comparable
- `measurements.measurementScopeSummary`: phase and command-result counts by
  `product`, `harness`, and `cleanup` scope
- `providerEvidence`: provider request timing, route/model/status summaries,
  optional token-like usage totals, and whether evidence came from mock-provider
  logs or OpenClaw timeline events
- `violations`: threshold or behavior violations
- `phases`: commands, results, and metrics by phase

`evidenceLedger.completeness` is `not-evaluated` for dry-run records,
`complete` when required ledger entries are present, and `incomplete` when one
or more required ledger entries are missing. A passing execution record with
missing required ledger evidence is downgraded to `INCOMPLETE`.

OpenClaw state snapshots use `kova.openclawStateSnapshot.v1`. They summarize
known config, auth/model shape, plugin indexes, and plugin manifests with
bounded reads, redacted secret-looking keys, byte counts, hashes, and truncation
markers. They must not copy OpenClaw homes, workspaces, runtimes,
`node_modules`, or package stores into Kova artifacts.
Snapshots also expose compact semantic sections for runtime target context,
service state, config keys/schema versions, auth provider and auth-method
shape, model ids, workspace root fingerprints, and cleanup expectation.
Scenarios can declare required snapshot obligations in
`evidenceContract.snapshots`; executed snapshot phases appear as `snapshot`
ledger entries and missing or unreadable required snapshots make the run
`INCOMPLETE`.
Invariant checks appear as `invariant` ledger entries. A failed required
invariant means Kova collected the proof and it showed bad OpenClaw behavior, so
an otherwise passing record becomes `FAIL`.
Cleanup evidence appears as `cleanup` ledger entries. Missing required cleanup
proof makes an otherwise passing record `INCOMPLETE`; explicit `keep-env`
retention is recorded as optional skipped cleanup evidence.
Command results include `outputBudget` metadata with retained, omitted, limit,
and truncation counts for stdout/stderr. Log collectors include
`snippetBudget` metadata with retained/omitted byte counts and truncation
markers for stdout/stderr snippets. Executed records include
`evidenceArtifactBudget`; an over-budget retained evidence set appears as a
required `artifact` ledger failure and makes the run `INCOMPLETE`.
Summary JSON includes `proof`: record completeness counts, required obligation
totals, category counts, and compact lists of missing or failed required
obligations. Markdown reports render this as the Proof Completeness section
before performance details.
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

- `measurementScope`: `product`, `harness`, or `cleanup`; command resource
  samples and post-phase process metrics inherit this phase-owned scope
- `commands`: commands Kova ran
- `results`: status, duration, stdout/stderr snippets, timeout state
- `metrics`: service and process snapshot after the phase

Successful command stdout/stderr may be present in JSON but should not be pasted
by agents unless it explains a failure.

## Auth Evidence

Record `auth.setupKind` states how Kova configured model auth for the disposable
OpenClaw env:

- `openclaw-onboard`: Kova used OpenClaw's own non-interactive `onboard`
  command, normally with env-backed SecretRefs for API-key/env-only providers.
- `fixture-config-patch`: Kova patched disposable env config directly for a
  live path that has no stable non-interactive OpenClaw command path. Treat this
  as runtime validation only, not proof that OpenClaw onboarding/auth UX passed.

For live runs, `auth.modelId` records the explicit `--model` override. Kova
applies it through `openclaw models set` after onboarding and before the first
real service start.

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

Metrics also include `collectionPolicy` with schema
`kova.collectionPolicy.v1`. It records the scenario/phase context and which
collectors were intended to run for that metrics capture. Scenario phases,
auth phases, and state lifecycle steps can declare `collectionIntent`; missing
or invalid intent falls back to `full`, and failed phases always use `full`.
A `full` policy means all env collectors remain enabled. A `skip-env` policy
means a successful command receipt is the proof and no env collectors are
needed; each disabled collector must appear in `collectionPolicy.skipped` and
as a `SKIPPED` collector receipt.
`service-only` means Kova keeps the OCM service summary, and process metrics
when a child process exists, but skips readiness, health, logs, timeline,
diagnostics, node-profile scans, heap snapshots, and diagnostic reports for a
phase whose command result is the proof.
`post-ready-health` means the phase keeps service, process, health samples,
logs, timeline, diagnostics, and node-profile scans, but intentionally skips the
startup readiness wait. Those phases still contribute to
`measurements.health.postReadySamples`.

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
- runtime release version/track
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
- legacy runtime dependency staging grouped by bundled plugin when historical
  OpenClaw artifacts contain `runtimeDeps.stage` spans with `pluginId` attributes

## Agent Turn Evidence

Agent turns are reported under `records[*].measurements.agentTurns`. Gateway
session turns use the active `sessions.send` window for `totalTurnMs`,
`preProviderMs`, `providerFinalMs`, `postProviderMs`, cold/warm metrics, and
threshold checks. The raw support-command duration is still preserved as
`rawCommandDurationMs` so readers can separate runner/session setup overhead
from the OpenClaw turn path.

Gateway/session turn entries include:

```json
{
  "schemaVersion": "kova.agentTurnEvidence.v1",
  "label": "cold",
  "totalTurnMs": 1260,
  "rawCommandDurationMs": 2100,
  "gatewaySession": {
    "schemaVersion": "kova.gatewaySessionTurn.v1",
    "method": "sessions.send",
    "createSession": true,
    "sessionKey": "kova-gateway-session-send",
    "activeStartedAtEpochMs": 1777536000000,
    "activeFinishedAtEpochMs": 1777536001260,
    "activeTurnMs": 1260,
    "sessionCreateDurationMs": 120,
    "sendDurationMs": 80,
    "timeToFirstAssistantMs": 900,
    "timeToMatchedAssistantMs": 1260,
    "historyPollCount": 3,
    "historyErrorCount": 0
  },
  "turnDiagnostics": {
    "schemaVersion": "kova.activeTurnDiagnostics.v1",
    "metadataScan": {
      "count": 1,
      "totalDurationMs": 45,
      "maxDurationMs": 45
    },
    "eventLoop": {
      "sampleCount": 1,
      "maxMs": 12
    },
    "sessionPolling": {
      "pollCount": 3,
      "errorCount": 0
    }
  }
}
```

Gateway session turns also include pre-provider attribution when an OpenClaw
diagnostics timeline is available. Kova clips `gateway.chat_send*`,
`auto_reply*`, and `reply.*` spans to the active `sessions.send` pre-provider
window and reports the unioned known time so overlapping spans are not counted
twice. Provider work remains separate.

```json
{
  "gatewaySessionPreProviderAttribution": {
    "schemaVersion": "kova.gatewaySessionPreProviderAttribution.v1",
    "available": true,
    "label": "cold",
    "timelineArtifacts": ["/tmp/kova/openclaw/timeline.jsonl"],
    "window": {
      "startEpochMs": 1777536000000,
      "endEpochMs": 1777536000200,
      "durationMs": 200
    },
    "provider": {
      "totalDurationMs": 600,
      "firstByteLatencyMs": 25,
      "firstChunkLatencyMs": 30
    },
    "knownAttributedMs": 170,
    "unattributedMs": 30,
    "coverageRatio": 0.85,
    "spanSummaries": [
      {
        "name": "auto_reply.finalize_context",
        "count": 1,
        "errorCount": 0,
        "totalClippedDurationMs": 100,
        "maxClippedDurationMs": 100
      }
    ]
  }
}
```

Repeat summaries expose machine-readable medians at
`records[*].measurements.gatewaySessionPreProviderAttribution` plus flat comparison
metrics such as `coldPreProviderAttributedMs`,
`coldPreProviderUnattributedMs`, `warmPreProviderAttributedMs`, and
`warmPreProviderUnattributedMs`.

Local agent CLI turns expose the same fields under
`records[*].measurements.agentCliPreProviderAttribution`. Kova attributes
OpenClaw spans in the `cli.startup`, `cli.command-startup`, and `agent.startup`
phases, together with agent preparation, model discovery, plugin metadata, and
channel capability spans. Overlapping startup spans are unioned before Kova
calculates known and unattributed time. Span summaries retain stage breakdowns
such as `config-ready`, `plugin-registry`, and `command-prepare` so the JSON
evidence identifies the owning startup work.

Aggregate fields are also exposed on `measurements` for comparison and
performance summaries:

- `agentMetadataScanCount`
- `agentMetadataScanTotalMs`
- `agentMetadataScanMaxMs`
- `agentEventLoopMaxMs`
- `agentEventLoopSampleCount`
- `agentSessionPollCount`
- `agentSessionPollErrorCount`

## Health And Readiness

Health/readiness data lives under `records[*].measurements.health`:

```json
{
  "schemaVersion": "kova.health.v1",
  "readiness": {
    "phaseId": "cold-start",
    "listeningReadyAtMs": 2536,
    "healthReadyAtMs": 3005,
    "classification": "ready",
    "severity": "pass",
    "reason": "gateway became healthy within the readiness threshold",
    "thresholdMs": 30000,
    "deadlineMs": 120000,
    "attempts": 4
  },
  "startupSamples": {
    "scope": "startup-sample",
    "count": 4,
    "okCount": 1,
    "failureCount": 3,
    "p95Ms": 120,
    "maxMs": 120,
    "slowestPhaseId": "cold-start"
  },
  "postReadySamples": {
    "scope": "post-ready",
    "count": 9,
    "okCount": 9,
    "failureCount": 0,
    "p95Ms": 469,
    "maxMs": 652,
    "slowestPhaseId": "api-latency"
  },
  "unknownSamples": {
    "scope": "unknown",
    "count": 0,
    "okCount": 0,
    "failureCount": 0,
    "p95Ms": null,
    "maxMs": null,
    "slowestPhaseId": null
  },
  "final": {
    "scope": "final",
    "gatewayState": "running",
    "ok": true,
    "healthOk": true,
    "failureCount": 0,
    "p95Ms": 90,
    "maxMs": 90,
    "slowestPhaseId": "final"
  },
  "slowestSample": {
    "scope": "post-ready",
    "phaseId": "api-latency",
    "durationMs": 652
  }
}
```

Scenario phases declare `healthScope` so the evaluator does not infer meaning
from phase ids. Allowed values are `readiness`, `startup-sample`, `post-ready`,
`final`, and `none`. Reports do not emit old top-level readiness or health p95
fields; readers should use the scoped health object directly.

When a threshold policy includes `postReadyHealthP95Ms`, Kova derives zero
budgets for `postReadyHealthFailures` and `finalHealthFailures` unless the
scenario or surface overrides them. The derived thresholds appear in
`thresholdPolicy.sources` with `kind: "derived"` so reports can explain why
failed health samples became violations.

Scenario phases can also declare `collectionIntent` with one of `full`,
`post-ready-health`, `service-only`, or `skip-env`. The default is `full`.
Intent controls collector policy only after phase commands succeed; failure
diagnostics stay full collection.

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
  `plugins.metadata.scan`, `plugins.load`, `providers.load`,
  `models.catalog`, `agent.turn`, and `agent.cleanup`

Historical `runtimeDeps.stage` spans remain available in `openclawKeySpans` for
old report parsing, but current surfaces do not require them.

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
event-loop delay, agent turn latency, agent metadata scan count/time, active
turn event-loop max, session poll count, startup health p95, post-ready health
p95, and runtime dependency staging.

When `profiling.affectsPerformanceMeasurements` is true, Kova still reports
the observed CPU, RSS, latency, role, growth, and profiler values. Affected
numeric performance thresholds are recorded under
`performanceThresholdAssessment` with `status: "SKIPPED"` and
`affectsRecordStatus: false`; they are not emitted as fatal violations.
Every such record carries this assessment. When no configured threshold is
affected, it records `complete: true`, `skippedCount: 0`, and empty skipped
evidence so consumers can distinguish a completed assessment from missing
producer output.
Affected evidence is limited to direct command durations from diagnostic
product command trees, local-agent timings owned by those command trees, and
resource values whose winning process belongs to those trees. Persistent
gateway startup/readiness/health, count metrics, minimum-duration requirements,
cleanup, containment, recovery, and safety contracts remain active.
Command failures, timeouts, behavioral failures, safety checks, missing or
malformed evidence, leaks, cleanup failures, and non-performance checks remain
active. A required release-gate scenario with skipped instrumented thresholds
produces `PARTIAL`, `ok: false`, and `complete: false`, so a diagnostic run can
reject real failures but cannot approve a release.

`--profile-on-failure` does not set
`profiling.affectsPerformanceMeasurements`: passing runs collect normal
user-path measurements and diagnostics are captured only after an initial
failure. Those runs remain baseline-ineligible by policy.

Baseline stores use schema `kova.baselines.v1`. Baseline read/write requires
`--execute` so stored evidence comes from real OpenClaw runs, not dry-run plans.
Baseline writes also require `--reviewed-good`; Kova rejects updates from
failing records, record violations, unstable performance groups, failed gates,
profiled/instrumented runs, or reports that already regressed against an
existing baseline. Entries are keyed by platform, target kind, surface, state,
and scenario, so Kova can compare the same OpenClaw execution surface under the
same user state instead of comparing unrelated commands.

Baseline update review uses schema `kova.baselineReview.v1` and is stored under
`baseline.review` when `--save-baseline` is used. It records whether the
operator marked the evidence reviewed, the blockers Kova checked, and whether
the baseline write was accepted. A rejected review blocks the write.

Baseline comparison uses schema `kova.baselineComparison.v1`. Regressions are
reported by metric with baseline median, current median, p95 values, threshold
percent, and increase percent. Release gates treat baseline regressions as
blocking performance regressions, so a functional pass can still become
`DO_NOT_SHIP` when OpenClaw gets materially slower or heavier.

Instrumented performance groups retain raw current and baseline values but use
`comparable: false`, `delta: null`, and reason
`instrumented-performance-measurement`. They cannot create baseline
regressions; the release gate remains `PARTIAL` until normal user-path evidence
is available. Reports expose these groups separately from resource-contract
mismatches so Markdown and gate summaries cannot hide the skipped evidence.

Resource baselines are comparable only when both `resourceMeasurementScope` and
`resourceHeadlineContract` match. Kova skips RSS/CPU deltas from older or
different accounting contracts, reports the mismatch and skipped metrics, and
continues comparing status and other non-resource metrics.

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
    "profiledRunCount": 0,
    "resourceMeasurementScope": "product",
    "resourceHeadlineContract": "primary-role-product-scope-v3",
    "baselineRegressionCount": 0,
    "missingBaselineCount": 0,
    "skippedMetricCount": 0,
    "resourceContractMismatchCount": 0,
    "baselineReviewOk": true,
    "baselineReviewBlockerCount": 0,
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

Every scenario must declare a `surface` and the requirement ids it proves.
Registry validation fails before plan, run, or matrix output if a scenario
references an unknown surface or requirement, a surface references an unknown
process role, or a profile references an unknown scenario/state/requirement.

Every state must declare traits, risk area, owner area, setup evidence, and
cleanup guarantees. Positive surface compatibility is owned by surface
requirements. Registry validation rejects unknown state traits, unknown hard
incompatibility references, and profile entries that pair a scenario with a
state that does not satisfy the scenario's proved requirements.

Plan JSON includes `coverage`:

- `surfaces`: each surface with scenario count and mapped scenarios
- `scenarioSurfaceMap`: direct scenario-to-surface mappings
- `surfacesWithoutScenarios`: declared surfaces with no scenario yet
- `profiles`: per-profile selected surfaces, scenarios, states, requirement
  coverage, derived required coverage, coverage gaps, state trait coverage,
  state/surface pairs, and trait/surface coverage

`kova matrix plan --json` also includes `resolvedCoverage`. This is the pre-run
contract resolver for the selected profile, target, filters, scenarios, and
states. It does not change execution reports. It lists planned obligations as
surface requirement, scenario, state, target kind, status, required states,
required state traits, required target kinds, and required metrics. Invalid
obligations, such as a scenario proving an unknown requirement or a selected
state that cannot satisfy the requirement, fail planning before execution.

`kova inventory plan --json` is planner-only and does not write a run report. It
uses schema `kova.inventory.plan.v1` and includes:

- `sources`: whether OpenClaw help, package scripts, manifests, and optional
  channel capability catalog source comparison were scanned
- `modeledSurfaces`: current Kova surfaces
- `capabilities`: discovered CLI commands, product-relevant package scripts,
  plugin manifests, and extension manifests with matched Kova surface ids when
  known
- `channelCapabilityCatalog`: source/catalog comparison for the OpenClaw
  message-channel capability catalog when `--openclaw-repo` is provided
- `coverage.warnings`: unmodeled discovered capabilities
- `coverage.ambiguous`: discovered capabilities that match multiple Kova
  surfaces
- `coverage.blockers`: selected missing or unmodeled capabilities when
  `--require-modeled <capability>` is used

Inventory warnings are discovery signal first. They do not block release gates
until a later policy deliberately promotes them.

Package-script discovery defaults to `--script-scope product`. Use
`--script-scope all` to include every package script or `--script-scope none` to
scan only CLI help and manifests.

`kova inventory repeated-work --json` is planner-only and uses schema
`kova.repeatedWorkAudit.v1`. It includes:

- `profiles`: profile entry counts, scenario phase counts, and minimum
  `collectEnvMetrics` calls implied by the profile shape
- `duplicateCommands`: repeated scenario commands with the scenario/phase uses
- `duplicatePhaseIds`: shared phase ids across scenarios
- `explicitEvidenceCommands`: scenario commands that already collect service
  status or logs as required evidence
- `commandReceiptLocks`: invariants that currently depend on exact command
  receipt evidence

## Summary Output

Each run also writes `<run>.summary.json`. `kova report summarize
<report.json> --json` prints the same compact agent-facing contract:

```json
{
  "schemaVersion": "kova.report.summary.v1",
  "decision": {
    "verdict": "FAIL",
    "reason": "gateway peak RSS 701.8 MB exceeded threshold 700 MB",
    "blockingFindingCount": 1,
    "warningFindingCount": 0
  },
  "run": {
    "repeat": 3,
    "parallel": 1,
    "auth": {}
  },
  "coverage": {
    "recordCount": 3,
    "scenarioCount": 1,
    "stateCount": 1
  },
  "findings": [],
  "groups": [],
  "samples": [],
  "artifacts": []
}
```

Agents should use the summary before reading the full report when they only
need pass/fail, findings, aggregate performance, sample-level evidence, and
artifact paths. The full `kova.report.v1` JSON remains the audit trail with raw
records, phases, commands, and collector evidence.

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
  "mode": "execution",
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
  "gate": {
    "verdict": "SHIP",
    "baselineRegressionCount": 0,
    "missingBaselineCount": 0,
    "skippedMetricCount": 0,
    "resourceMeasurementScope": "product",
    "resourceHeadlineContract": "primary-role-product-scope-v3",
    "resourceContractMismatchCount": 0
  },
  "performance": {
    "resourceMeasurementScope": "product",
    "resourceHeadlineContract": "primary-role-product-scope-v3",
    "baselineRegressionCount": 0,
    "missingBaselineCount": 0,
    "skippedMetricCount": 0,
    "resourceContractMismatchCount": 0
  },
  "summary": {
    "total": 4,
    "statuses": {
      "PASS": 4
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
  "purpose": "release",
  "profileId": "release",
  "policyId": "openclaw-release",
  "verdict": "DO_NOT_SHIP",
  "outcome": "DO_NOT_SHIP",
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
    "requirements": {
      "blocking": ["release-runtime-startup:baseline"]
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
  was not executed, skipped, missing required proof, or blocked by
  harness/provisioning behavior.

`outcome` is purpose-aware. For `release` gates it matches `verdict`. For
non-release purposes, a passing complete gate reports `PASS`, a blocking
OpenClaw failure reports `FAIL`, and incomplete or harness-blocked gates report
`PARTIAL` or `BLOCKED`.

Filtered gate slices are partial. They can produce `DO_NOT_SHIP` when a selected
blocking scenario fails, but they cannot produce `SHIP` because required gate
coverage is missing. A passing filtered slice remains `PARTIAL`.

Release profiles define explicit platform coverage and requirement coverage
using `surface:requirement` ids. Surface, scenario, state, trait, and
state-surface coverage views are derived from resolved obligations for report
compatibility. Missing blocking requirement/platform coverage prevents `SHIP`;
missing warning coverage creates warning cards. Platform coverage keys include
`darwin-arm64`, `linux-x64`, `linux-arm64`, and `wsl2` where detectable.

Gate cards are concise fixer records. They include severity, scenario/state,
status, summary, expected/actual, impact, likely owner, failed command when
available, violation text, and compact measurements. Gate reports also group
cards by likely OpenClaw subsystem and generate compact subsystem fixer briefs.
The matrix receipt includes only the gate verdict/count summary, including the
resource measurement identity and skipped comparison counts; the full cards,
resource mismatch details, and subsystem briefs live in the JSON report.

When `--baseline` is used, the gate also includes a compact historical baseline
summary with regression count, missing baseline count, resource measurement
scope, resource headline contract, resource contract mismatch count, skipped
metric count, mismatch details, and regressed scenario groups. Baseline
regressions remain blocking gate cards. Resource contract mismatches skip only
contract-dependent metrics; they do not suppress status or non-resource gates.

For non-ship gate runs, Kova retains a durable copy under
`artifacts/release-gates/<runId>/`:

```text
report.md
report.json
paste-summary.txt
<runId>-bundle-<sha256>.tar.gz
<runId>-bundle-<sha256>.tar.gz.sha256
retained-artifacts.json
```

## Compare Report

`kova report compare <baseline.json> <current.json> --json` prints:

```json
{
  "schemaVersion": "kova.compare.v1",
  "ok": false,
  "regressionCount": 1,
  "skippedMetricCount": 3,
  "resourceContractMismatchCount": 1,
  "scenarios": [
    {
      "key": "fresh-install:fresh",
      "status": "REGRESSED",
      "resourceComparison": {
        "baseline": {
          "measurementScope": "harness",
          "headlineContract": "primary-role-v1"
        },
        "current": {
          "measurementScope": "product",
          "headlineContract": "primary-role-product-scope-v3"
        },
        "compatible": false
      },
      "skippedMetrics": [
        "peakRssMb",
        "peakRssMb.max",
        "peakRssMb.p95"
      ],
      "metrics": {
        "peakRssMb": {
          "baseline": 400,
          "current": 520,
          "comparable": false,
          "delta": null
        }
      },
      "regressions": [
        {
          "metric": "modelsListMs",
          "message": "modelsListMs increased by 120..."
        }
      ]
    }
  ]
}
```

Comparison currently detects status regressions, missing scenario/state entries,
and increases in peak RSS, health failures, health p95, missing dependency
errors, plugin load failures, metadata scan mentions, and config normalization
mentions. It also reports group-level status changes and finding deltas before
metric deltas, so a comparison can say which failures were resolved, which
new findings appeared, and whether repeat-run pass/fail counts improved.

RSS, CPU, and resource sample-count metrics require matching
`resourceMeasurementScope` and `resourceHeadlineContract` values. When either
identity differs, median, max, and p95 rows retain their raw baseline/current
values but use `comparable: false`, `delta: null`, and `SKIPPED` in the rendered
table. Status transitions and non-resource metric regressions remain active.

Profiler-affected metrics become non-comparable when the baseline and current
profiling modes differ. The comparison uses `result: "INCONCLUSIVE"`,
`complete: false`, and `ok: false`; previous or new affected failures are not
reported as resolved, improved, or regressed. Same-profile instrumented reports
remain comparable. Behavioral status changes and non-performance findings
remain comparable.

## Artifact Bundle

`kova report bundle <report.json> --json` prints a bundle receipt:

```json
{
  "schemaVersion": "kova.artifact.bundle.v1",
  "runId": "kova-2026-04-29T000000Z",
  "outputPath": "/path/to/bundle.tar.gz",
  "checksumPath": "/path/to/bundle.tar.gz.sha256",
  "sha256": "...",
  "publicationOmissions": {
    "fileCount": 0,
    "totalBytes": 0
  },
  "artifactIndex": {
    "path": "artifact-index.json",
    "fileCount": 5,
    "totalBytes": 12345,
    "publicationOmissions": {
      "fileCount": 0,
      "totalBytes": 0
    }
  },
  "included": {
    "reportJson": true,
    "reportMarkdown": true,
    "pasteSummary": true,
    "runArtifacts": false
  }
}
```

Kova stages and preflights the complete artifact set before publication. It
omits raw Node traces only when a bundle limit would otherwise be exceeded,
never publishes an arbitrary subset of that class, and fails closed if the
remaining mandatory artifacts still exceed a limit.

### Linux CPU interval accounting

`primary-role-product-scope-v4` keeps the existing resource thresholds and
separates Linux interval CPU evidence from older lifetime-average samples.
Only product processes and the ancestor chains needed for their wait accounting
participate in the Linux CPU census. Existing wait owners discovered with a new
product process establish a baseline without importing historical host CPU.

Linux resource samples bracket CPU-counter scans and use their common inner
monotonic interval, retaining PID/start-time identities. Upper bounds conservatively
include work in the scan margins; lower bounds subtract the maximum possible
CPU in those margins. A range crossing a CPU threshold blocks qualification as
inconclusive harness evidence instead of inventing a product failure. New children contribute their
CPU since birth; reaped children contribute CPU not already observed in an
earlier sample. Vanished process roles remain attached to their wait accounting,
including a Gateway reaped by an external supervisor. Parent counters are read
before child counters; a product process disappearing during that census
discards the inconsistent scan before accounting. Collection attempts are
recorded, and three unstable censuses produce a harness failure. Ambiguous reaped CPU is
an upper bound for each affected role; it never raises the lower bound. Unsettled
terminal wait accounting blocks qualification. CPU percentages may exceed 100% when product threads or
processes execute concurrently. The collector does not sum `ps` lifetime CPU
averages from processes of different ages.

A product process born during collection but first discovered after an earlier
sample contributes its lifetime counters as an upper bound over the common
current interval, never as a lifetime-average percentage. Its
`cpuIntervalComplete: false` sample excludes that work from total and role lower
bounds. Missing earlier intervals keep `cpuCoverageComplete` false and block
qualification even if the current upper bound is below the CPU limit; later
complete samples cannot repair the discovery gap. Existing product processes
that predate collection still require a historical baseline.

For sampled commands, a Kova wait owner remains alive until the final CPU sample.
Its own CPU and RSS are harness work and excluded from product measurements;
its child accounting retains sub-second commands and the last interval before
exit. The watchdog remains active until inherited stdout/stderr writers drain
and the captured process closes; direct shell exit does not release that ownership. The command environment is forwarded privately to its shell; Node preload and
profiling options do not execute in the accounting helper. Product command
stdout, stderr, exit status, signal, and timeout behavior remain unchanged. Resource artifacts identify the counter contract as
`linux-process-interval-v1`. Incomplete counter/baseline evidence is a harness
failure, never a zero-CPU result. A single-process final `ps` snapshot remains
available as diagnostic data but does not override Linux interval CPU gates.

Old reports cannot be reprocessed into interval evidence because they lack CPU
time counters, process start identities, and terminal child accounting. Run
fresh qualification after adopting this collector; do not reuse or recalibrate
old zero-CPU short-command reports as an interval baseline.
