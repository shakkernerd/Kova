# Changelog

All notable changes to Kova are documented in this file.

## Unreleased

## 0.1.5 - 2026-09-07

**Highlights:** Linux CPU validation now measures process lifetimes without mistaking serial work for parallel load or qualifying incomplete interval evidence.

### Fixed

- Measure Linux CPU over common intervals so serial parent/child work is not reported as concurrent CPU, short commands retain final CPU evidence, and incomplete measurements cannot qualify a release. (#110)
- Keep late-discovered process CPU as conservative interval evidence and block qualification when earlier intervals are missing, instead of allowing lifetime averages to hide CPU bursts. Thanks @RomneyDa. (#112)
- Support Node executable paths containing spaces in the CPU-accounting regression workload. Thanks @vincentkoc. (#111)

### Internal

- Refresh the checksum-verified OCM CI runtime to 0.2.41 and website Node.js types to 26.5.0.

## [0.1.4] - 2026-09-05

**Highlights:** Setup now recovers from an unresponsive OCM version probe, and fresh validation machines provision and hydrate reliably.

### Fixed

- Bound setup's OCM version probe to 30 seconds, forcibly stop unresponsive probes, and report timeouts as failed prerequisites. Thanks @SebTardif. (#107)

### Internal

- Restore AWS validation provisioning by sizing the root volume for the current 400 GB base image.
- Update Crabbox hydration to pnpm 12.3.4 with a portable install step supported by local Actions hydration.
- Refresh the transitive bare-path and bare-url patch releases used by archive dependencies.
- Refresh compatible CLI and website dependencies, including Zod 4.5.4 and Astro 7.3.1, and update the pinned OCM CI runtime, pnpm hydration toolchain, and release action.

## [0.1.3] - 2026-08-30

### Fixed

- Bound mock-provider process inspection to two seconds so a stuck `ps` cannot indefinitely block mock-auth runs or cleanup. Thanks @SebTardif. (#103)

## [0.1.2] - 2026-08-28

### Highlights

- Reports and receipts can no longer claim an unrelated runtime's digest after failed provisioning: capture exact npm target identity only from successful runtime bindings, before rollback or cleanup. Thanks @pdurlej. (#98)
- Refresh CLI and website dependencies, including Astro 7.2.9, and clear all three Dependabot alerts. (#97)

### Fixed

- Avoid false blocked runtime-identity checks by using supported Gateway RPC options while still verifying the reported PID and port against OCM.
- Keep profiled performance evidence diagnostic, exclude instrumented runs from normal baselines and release approval, and scope deep profiles to product commands. Thanks @vincentkoc. (#82, #89)
- Allow local runtime packaging and dependency installation up to ten minutes instead of failing at the two-minute scenario timeout. Thanks @vincentkoc. (#88)
- Recover local-agent startup attribution from timeline spans and isolate process-cold startup from warmup in agent cold/warm scenarios. Thanks @vincentkoc. (#86, #91)
- Attribute agent CLI, agent runtime, and mock-provider memory to distinct process roles so RSS gates count each process once. Thanks @vincentkoc. (#80)
- Calibrate fresh-install, gateway pressure, bundled-plugin restart, and agent cold/warm memory budgets against repeated release-shaped runs, using the gateway's Node major while retaining scenario-specific regression caps. Thanks @vincentkoc and @RomneyDa. (#73, #74, #75, #77, #93)
- Use canonical OpenClaw plugin install records and prepare many-plugin pressure fixtures before cold startup while preserving older-release compatibility. Thanks @vincentkoc. (#79, #87)
- Stop requiring retired runtime dependency staging spans, and add mock-provider alias coverage. Thanks @vincentkoc. (#81, #90)
- Handle proxy log stream errors without crashing the network frontage process. Thanks @SebTardif. (#92)

### Internal

- Route version bumps through pull requests, require passing CI for the exact main commit before signing tags, and select a repository-authorized SSH signing key automatically.
- Keep the full release gate on the version-bump CI path and avoid repeating it during tag builds; retain packaged-install self-checks.
- Restrict command-output assertions to literal markers, keep CI tokens read-only, and skip ClawSweeper token creation for ordinary comments.
- Refresh pinned GitHub Actions off deprecated Node 20 runtimes and update the checksum-verified OCM CI runtime to 0.2.33.
- Refresh the README and align the pull request template. Thanks @hannesrudolph. (#72, #83)

## [0.1.1] - 2026-07-12

### Fixed

- Fetch the annotated release tag object before signature verification in the tag-triggered build workflow.
- Calibrate the channel workflow provider window for its intentionally batched multi-request and asynchronous completion phases.
- Validate asynchronous threaded completion handoffs by their preserved thread route without requiring a stale reply to the original inbound message.
- Accept complete no-service final evidence without fabricated health samples, and recognize explicit local runtime bindings without a release track.
- Migrate credential stores written by older Kova builds by removing the retired provider fallback policy instead of rejecting every run.
- Preserve the original scenario failure when `--retain-on-failure` runs before an OCM environment exists.
- Wait for asynchronous channel-probe and provider evidence to go quiet before resetting the next case's mock script.
- Give every channel-probe invocation a unique synthetic conversation target so stale records and late async completions cannot satisfy or consume a later rerun.
- Isolate channel-probe observations by inbound event and target, and preserve every media item when fallback delivery receives a batch.
- Stage channel-probe media fixtures inside the selected OCM environment so packaged message-tool delivery tests exercise sendable files instead of the runner checkout.
- Use OpenClaw's canonical inbound dispatch API in the packaged channel probe after the deprecated channel turn aliases were removed.
- Remove the stale channel-recovery reference that caused every packaged channel workflow probe to fail before evaluating OpenClaw behavior.
- Run installed self-checks from the packaged Kova root and smoke them outside the source checkout so releases cannot borrow missing files from a developer tree.
- Collect final post-ready health samples when readiness has no wait budget so successful executed scenarios retain complete pre-cleanup evidence.
- Made terminal reports width-safe for Unicode, narrow layouts, wrapped shell hints, duration rollover, and strict numeric samples.
- Hardened command execution with bounded streaming redaction, POSIX process-group cleanup, strict optional-log matching, and direct scenario command validation.
- Hardened artifact confidentiality by redacting credential-bearing logs before persistence and containing OpenClaw state collection against symlink escapes and hostile filesystem inputs.
- Hardened mock-provider and diagnostic process handling to reject non-decimal PID state, migrate active legacy providers safely, reject stale startup metadata, avoid signaling unrelated processes, retain retryable PID state, and preserve colliding diagnostic artifacts.
- Fixed OpenClaw inventory discovery to recognize canonical JSON5 plugin manifests consistently across platforms while deterministically bounding scans.
- Isolated concurrent self-check OCM identities, child environments, runtime names, and temp cleanup ownership.
- Escape runtime-derived Markdown and paste fields without changing JSON report data.
- Keep RSS and CPU role peaks independently attributed to their actual scenarios.
- Hardened performance baseline persistence, unstable-group detection, and repeated-work audit isolation.
- Fixed web reports to reset matrix deltas across missing samples, preserve scenario breach status, render blocked OG verdicts safely, revalidate mutable OG images, and normalize rounded minute durations.
- Made matrix gates honor scenario-wide policies and validate all seven coverage dimensions only from records that actually executed.
- Stopped parallel matrix workers from scheduling new scenarios after a rejection, drained active workers before rethrowing, and made lifecycle command indexes phase-wide to prevent artifact overwrites.
- Fixed web release projections to select same-day priors numerically, match headline deltas by scenario, metric, and unit, label comparisons with the measured metric, and median-aggregate repeated turn measurements.
- Fixed report status precedence, repeated-sample diagnostics, finding identity, worst-case metrics, confidence labels, blocked outcomes, and rendered CLI guidance.
- Hardened release validation against missing, malformed, misplaced, partial, or incomplete provider, health, snapshot, plugin-security, command-timing, and measurement evidence.
- Hardened release publishing and run evidence contracts so invalid payloads are rejected and missing final metrics cannot be reported as healthy.
- Hardened runtime teardown with collision-resistant local-build names, exact OCM missing-resource matching, awaited proxy shutdown, and independent cleanup stages.
- Centralized disposable environment cleanup in Kova's lifecycle and removed stale scenario cleanup commands and unused raw selector substitutions.
- Hardened registry and evaluation integrity for capability catalogs, workflow derivation, thresholds, and malformed harness evidence.
- Fixed credential setup to validate provider/CLI pairings and recover concurrent or interrupted updates through a durable transaction journal and cross-process lock.
- Replaced external CLI credential-file guessing with native Codex and Claude authentication status checks.
- Hardened interactive setup with no-echo secret input, JSON-clean stdout, terminal-state restoration, and real directory write probes.
- Hardened CLI option and error contracts, release versioning and provenance checks, release archive packaging, pinned CI dependencies, and Crabbox hydration state.
- Hardened collector evidence integrity across profiles, provider attribution, process sampling, diagnostics, timelines, state fixtures, redaction, and artifact retention.
- Made report, portable USTAR bundle, retained-artifact, and baseline publication concurrency-safe, rollback-aware, crash-cleaning, and fail-closed on incomplete evidence.
- Kept installed release self-checks independent of source-only test fixtures.
- Made cleanup skip active, retained, recent, and unknown-state environments by default, finalized local runtimes after failures, and made failed comparisons exit non-zero in every output format.
