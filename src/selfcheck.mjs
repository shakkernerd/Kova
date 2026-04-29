import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { quoteShell, runCommand } from "./commands.mjs";
import { summarizeCpuProfiles } from "./cpuprofile.mjs";
import { evaluateRecord } from "./evaluator.mjs";
import { parseTimelineText } from "./timeline.mjs";

export async function runSelfCheck(flags = {}) {
  const checks = [];
  const tmp = await mkdtemp(join(tmpdir(), "kova-self-check-"));

  try {
    checks.push(await commandCheck(
      "syntax",
      "for f in src/*.mjs bin/kova.mjs; do node --check \"$f\" || exit 1; done"
    ));
    checks.push(await jsonCommandCheck("version-json", "node bin/kova.mjs version --json", (data) => {
      assertEqual(data.schemaVersion, "kova.version.v1", "version schema");
      assertString(data.version, "version");
    }));
    checks.push(await jsonCommandCheck("setup-json", "node bin/kova.mjs setup --json", (data) => {
      assertEqual(data.schemaVersion, "kova.setup.v1", "setup schema");
      assertEqual(data.ok, true, "setup ok");
      assertArrayNotEmpty(data.checks, "setup checks");
    }));
    checks.push(await jsonCommandCheck("plan-json", "node bin/kova.mjs plan --json", (data) => {
      assertEqual(data.schemaVersion, "kova.plan.v1", "plan schema");
      assertArrayNotEmpty(data.scenarios, "plan scenarios");
      assertArrayNotEmpty(data.states, "plan states");
      assertArrayNotEmpty(data.profiles, "profiles");
    }));
    checks.push(await jsonCommandCheck("matrix-plan-json", "node bin/kova.mjs matrix plan --profile smoke --target runtime:stable --include scenario:fresh-install --parallel 2 --json", (data) => {
      assertEqual(data.schemaVersion, "kova.matrix.plan.v1", "matrix plan schema");
      assertEqual(data.profile?.id, "smoke", "matrix profile id");
      assertArrayNotEmpty(data.entries, "matrix entries");
      assertEqual(data.entries.length, 1, "matrix include filter count");
      assertEqual(data.controls?.requestedParallel, 2, "matrix requested parallel");
    }));
    checks.push(await failingCommandCheck(
      "invalid-parallel-rejected",
      "node bin/kova.mjs matrix plan --profile smoke --target runtime:stable --parallel nope --json",
      "--parallel must be a positive integer"
    ));
    checks.push(await failingCommandCheck(
      "invalid-timeout-rejected",
      "node bin/kova.mjs run --target runtime:stable --scenario fresh-install --timeout-ms 0 --json",
      "--timeout-ms must be a positive integer"
    ));
    checks.push(await jsonCommandCheck("cleanup-json", "node bin/kova.mjs cleanup envs --json", (data) => {
      assertEqual(data.schemaVersion, "kova.cleanup.envs.v1", "cleanup schema");
      assertEqual(data.execute, false, "cleanup execute flag");
      assertArray(data.envs, "cleanup envs");
    }));
    checks.push(await diagnosticsTimelineCheck());
    checks.push(readinessClassificationCheck());
    checks.push(await cpuProfileParserCheck());
    checks.push(await jsonCommandCheck(
      "dry-run-state-lifecycle-json",
      `node bin/kova.mjs run --target runtime:stable --scenario fresh-install --state missing-plugin-index --report-dir ${quoteShell(tmp)} --json`,
      async (data) => {
        assertEqual(data.schemaVersion, "kova.run.receipt.v1", "state dry-run receipt schema");
        const report = JSON.parse(await readFile(data.jsonPath, "utf8"));
        const commands = report.records?.[0]?.phases?.flatMap((phase) => phase.commands ?? []) ?? [];
        if (!commands.some((command) => command.includes("rm -f") && command.includes("plugins/installs.json"))) {
          throw new Error("state lifecycle command missing from dry-run report");
        }
      }
    ));
    checks.push(await jsonCommandCheck(
      "dry-run-source-env-quoting-json",
      `node bin/kova.mjs run --target runtime:stable --scenario upgrade-existing-user --source-env 'Team Env' --report-dir ${quoteShell(tmp)} --json`,
      async (data) => {
        const report = JSON.parse(await readFile(data.jsonPath, "utf8"));
        const command = report.records?.[0]?.phases?.[0]?.commands?.[0] ?? "";
        if (!command.includes("ocm env clone 'Team Env'")) {
          throw new Error(`source env was not shell-quoted: ${command}`);
        }
      }
    ));
    checks.push(await localBuildRuntimeCleanupCheck(tmp));
    checks.push(await localBuildRuntimeAlreadyAbsentCleanupCheck(tmp));

    const receiptCheck = await jsonCommandCheck(
      "dry-run-report-json",
      `node bin/kova.mjs run --target runtime:stable --scenario fresh-install --report-dir ${quoteShell(tmp)} --json`,
      (data) => {
        assertEqual(data.schemaVersion, "kova.run.receipt.v1", "run receipt schema");
        assertEqual(data.mode, "dry-run", "run mode");
        assertEqual(data.summary?.statuses?.["DRY-RUN"], 1, "dry-run count");
        assertString(data.jsonPath, "json report path");
      }
    );
    checks.push(receiptCheck);

    checks.push(await jsonCommandCheck(
      "matrix-dry-run-json",
      `node bin/kova.mjs matrix run --profile smoke --target runtime:stable --include tag:plugins --exclude state:stale-runtime-deps --parallel 2 --report-dir ${quoteShell(tmp)} --json`,
      (data) => {
        assertEqual(data.schemaVersion, "kova.matrix.run.receipt.v1", "matrix run receipt schema");
        assertEqual(data.mode, "dry-run", "matrix dry-run mode");
        assertString(data.jsonPath, "matrix json report path");
        assertString(data.bundlePath, "matrix bundle path");
        if (!data.bundlePath.startsWith(tmp)) {
          throw new Error(`matrix bundle path should use report dir: ${data.bundlePath}`);
        }
        assertEqual(data.summary?.statuses?.["DRY-RUN"], 5, "filtered matrix dry-run count");
      }
    ));
    checks.push(await gateDryRunCheck(tmp));

    if (receiptCheck.status === "PASS") {
      const report = JSON.parse(await readFile(receiptCheck.data.jsonPath, "utf8"));
      checks.push(validateReport(report));
      checks.push(await jsonCommandCheck(
        "report-compare-json",
        `node bin/kova.mjs report compare ${quoteShell(receiptCheck.data.jsonPath)} ${quoteShell(receiptCheck.data.jsonPath)} --json`,
        (data) => {
          assertEqual(data.schemaVersion, "kova.compare.v1", "compare schema");
          assertEqual(data.ok, true, "compare ok");
          assertEqual(data.regressionCount, 0, "compare regression count");
        }
      ));
      checks.push(await jsonCommandCheck(
        "report-bundle-json",
        `node bin/kova.mjs report bundle ${quoteShell(receiptCheck.data.jsonPath)} --output-dir ${quoteShell(tmp)} --json`,
        (data) => {
          assertEqual(data.schemaVersion, "kova.artifact.bundle.v1", "bundle schema");
          assertString(data.outputPath, "bundle output path");
          assertString(data.checksumPath, "bundle checksum path");
          assertString(data.sha256, "bundle sha256");
        }
      ));
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  const ok = checks.every((check) => check.status === "PASS");
  const result = {
    schemaVersion: "kova.selfcheck.v1",
    generatedAt: new Date().toISOString(),
    ok,
    checks: checks.map(({ data, ...check }) => check)
  };

  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const check of result.checks) {
      console.log(`${check.status} ${check.id}${check.message ? `: ${check.message}` : ""}`);
    }
  }

  if (!ok) {
    throw new Error("self-check failed");
  }
}

async function gateDryRunCheck(tmp) {
  const command = `node bin/kova.mjs matrix run --profile release --target runtime:stable --include scenario:release-runtime-startup --gate --report-dir ${quoteShell(tmp)} --json`;
  const result = await runCommand(command, { timeoutMs: 30000, maxOutputChars: 1000000 });
  try {
    if (result.status === 0) {
      throw new Error("gate dry-run should exit non-zero");
    }
    const data = JSON.parse(result.stdout);
    assertEqual(data.schemaVersion, "kova.matrix.run.receipt.v1", "gate receipt schema");
    assertEqual(data.gate?.verdict, "BLOCKED", "gate dry-run verdict");
    assertEqual(data.gate?.ok, false, "gate dry-run ok");
    const report = JSON.parse(await readFile(data.jsonPath, "utf8"));
    assertEqual(report.gate?.cards?.some((card) => card.kind === "not-executed"), true, "gate not-executed card");
    return {
      id: "gate-dry-run-blocked",
      status: "PASS",
      command,
      durationMs: result.durationMs
    };
  } catch (error) {
    return {
      id: "gate-dry-run-blocked",
      status: "FAIL",
      command,
      durationMs: result.durationMs,
      message: error.message
    };
  }
}

async function localBuildRuntimeCleanupCheck(tmp) {
  const binDir = join(tmp, "mock-bin");
  const repoDir = join(tmp, "mock-openclaw repo");
  const reportDir = join(tmp, "local-build-cleanup-report");
  const ocmLog = join(tmp, "mock-ocm.log");
  await mkdir(binDir, { recursive: true });
  await mkdir(repoDir, { recursive: true });
  const ocmPath = join(binDir, "ocm");
  await writeFile(ocmPath, `#!/bin/sh
printf '%s\\n' "$*" >> "$KOVA_MOCK_OCM_LOG"
case "$1:$2" in
  runtime:build-local) echo '{"ok":true}'; exit 0 ;;
  runtime:remove) echo '{"removed":true}'; exit 0 ;;
  service:status) echo '{"running":false,"desiredRunning":false,"childPid":null,"gatewayPort":null,"gatewayState":"stopped"}'; exit 0 ;;
  env:exec) exit 0 ;;
  env:destroy) echo '{"destroyed":true}'; exit 0 ;;
esac
case "$1" in
  start) echo '{"ok":true}'; exit 0 ;;
  logs) exit 0 ;;
  @*) echo 'ok'; exit 0 ;;
  --version) echo 'mock-ocm'; exit 0 ;;
esac
echo "unhandled mock ocm command: $*" >&2
exit 2
`, "utf8");
  await chmod(ocmPath, 0o755);

  const command = `node bin/kova.mjs run --target local-build:${quoteShell(repoDir)} --scenario fresh-install --execute --report-dir ${quoteShell(reportDir)} --json`;
  const result = await runCommand(command, {
    timeoutMs: 30000,
    maxOutputChars: 1000000,
    env: {
      PATH: `${binDir}:${process.env.PATH}`,
      KOVA_MOCK_OCM_LOG: ocmLog
    }
  });

  try {
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`);
    }
    const receipt = JSON.parse(result.stdout);
    const report = JSON.parse(await readFile(receipt.jsonPath, "utf8"));
    const log = await readFile(ocmLog, "utf8");
    assertEqual(report.targetCleanup?.status, "removed", "local-build target cleanup status");
    if (!/runtime remove kova-local-\d+ --json/.test(log)) {
      throw new Error(`runtime remove was not called; log:\n${log}`);
    }
    return {
      id: "local-build-runtime-cleanup",
      status: "PASS",
      command,
      durationMs: result.durationMs
    };
  } catch (error) {
    return {
      id: "local-build-runtime-cleanup",
      status: "FAIL",
      command,
      durationMs: result.durationMs,
      message: error.message
    };
  }
}

async function localBuildRuntimeAlreadyAbsentCleanupCheck(tmp) {
  const binDir = join(tmp, "mock-bin-absent-runtime");
  const repoDir = join(tmp, "mock-openclaw failed build");
  const reportDir = join(tmp, "local-build-absent-cleanup-report");
  const ocmLog = join(tmp, "mock-ocm-absent.log");
  await mkdir(binDir, { recursive: true });
  await mkdir(repoDir, { recursive: true });
  const ocmPath = join(binDir, "ocm");
  await writeFile(ocmPath, `#!/bin/sh
printf '%s\\n' "$*" >> "$KOVA_MOCK_OCM_LOG"
case "$1:$2" in
  runtime:build-local) echo 'dependency install failed' >&2; exit 1 ;;
  runtime:remove) echo 'ocm: runtime "kova-local-mock" does not exist' >&2; exit 1 ;;
  service:status) echo '{"running":false,"desiredRunning":false,"childPid":null,"gatewayPort":null,"gatewayState":"stopped"}'; exit 0 ;;
  env:destroy) echo 'ocm: environment "kova-mock" does not exist' >&2; exit 1 ;;
esac
case "$1" in
  --version) echo 'mock-ocm'; exit 0 ;;
esac
echo "unhandled mock ocm command: $*" >&2
exit 2
`, "utf8");
  await chmod(ocmPath, 0o755);

  const command = `node bin/kova.mjs run --target local-build:${quoteShell(repoDir)} --scenario fresh-install --execute --report-dir ${quoteShell(reportDir)} --json`;
  const result = await runCommand(command, {
    timeoutMs: 30000,
    maxOutputChars: 1000000,
    env: {
      PATH: `${binDir}:${process.env.PATH}`,
      KOVA_MOCK_OCM_LOG: ocmLog
    }
  });

  try {
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`);
    }
    const receipt = JSON.parse(result.stdout);
    const report = JSON.parse(await readFile(receipt.jsonPath, "utf8"));
    const summaryResult = await runCommand(`node bin/kova.mjs report summarize ${quoteShell(receipt.jsonPath)} --json`, {
      timeoutMs: 30000,
      maxOutputChars: 1000000
    });
    if (summaryResult.status !== 0) {
      throw new Error(summaryResult.stderr.trim() || summaryResult.stdout.trim() || `summary exit ${summaryResult.status}`);
    }
    const summary = JSON.parse(summaryResult.stdout);
    const log = await readFile(ocmLog, "utf8");
    assertEqual(report.summary?.statuses?.BLOCKED, 1, "failed local-build scenario status");
    assertEqual(report.records?.[0]?.cleanup, "already-absent", "already absent env cleanup status");
    assertEqual(report.targetCleanup?.status, "already-absent", "already absent local-build target cleanup status");
    assertEqual(summary.summary?.scenarios?.[0]?.failureReason, "dependency install failed", "summary failure reason");
    if (!/runtime remove kova-local-\d+ --json/.test(log)) {
      throw new Error(`runtime remove was not called after failed build; log:\n${log}`);
    }
    return {
      id: "local-build-runtime-already-absent-cleanup",
      status: "PASS",
      command,
      durationMs: result.durationMs
    };
  } catch (error) {
    return {
      id: "local-build-runtime-already-absent-cleanup",
      status: "FAIL",
      command,
      durationMs: result.durationMs,
      message: error.message
    };
  }
}

async function cpuProfileParserCheck() {
  try {
    const summary = await summarizeCpuProfiles(["fixtures/diagnostics/sample.cpuprofile"], { limit: 3 });
    assertEqual(summary.profileCount, 1, "CPU profile count");
    assertEqual(summary.parseErrorCount, 0, "CPU profile parse errors");
    assertEqual(summary.topFunctions[0]?.functionName, "collectBundledPluginMetadata", "top CPU function");
    assertEqual(summary.topFunctions[0]?.selfMs, 7, "top CPU self ms");
    return {
      id: "cpu-profile-parser",
      status: "PASS",
      command: "parse fixtures/diagnostics/sample.cpuprofile",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "cpu-profile-parser",
      status: "FAIL",
      command: "parse fixtures/diagnostics/sample.cpuprofile",
      durationMs: 0,
      message: error.message
    };
  }
}

async function diagnosticsTimelineCheck() {
  try {
    const text = await readFile("fixtures/diagnostics/timeline.jsonl", "utf8");
    const timeline = parseTimelineText(text);
    assertEqual(timeline.available, true, "timeline available");
    assertEqual(timeline.eventCount, 8, "timeline event count");
    assertEqual(timeline.parseErrorCount, 0, "timeline parse errors");
    assertEqual(
      timeline.repeatedSpans.some((span) => span.name === "plugins.metadata.scan"),
      true,
      "repeated plugin metadata span"
    );
    assertEqual(timeline.runtimeDeps.slowest?.pluginId, "browser", "runtime deps slowest plugin");
    assertEqual(timeline.runtimeDeps.byPlugin[1]?.pluginId, "memory-core", "runtime deps by plugin");
    assertEqual(timeline.eventLoop.maxMs, 214, "event loop max");
    assertEqual(timeline.providers.maxDurationMs, 1220, "provider duration");
    assertEqual(timeline.childProcesses.failedCount, 1, "child process failures");
    return {
      id: "diagnostics-timeline-parser",
      status: "PASS",
      command: "parse fixtures/diagnostics/timeline.jsonl",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "diagnostics-timeline-parser",
      status: "FAIL",
      command: "parse fixtures/diagnostics/timeline.jsonl",
      durationMs: 0,
      message: error.message
    };
  }
}

function readinessClassificationCheck() {
  try {
    const record = {
      status: "PASS",
      phases: [
        {
          id: "provision",
          results: [],
          metrics: {
            readiness: {
              deadlineMs: 90000,
              thresholdMs: 30000,
              ready: true,
              listeningReady: true,
              listeningReadyAtMs: 47000,
              healthReadyAtMs: 47100,
              classification: {
                state: "slow-startup",
                severity: "fail",
                reason: "gateway became healthy after 47100ms, beyond the 30000ms threshold"
              }
            },
            logs: {
              missingDependencyErrors: 0,
              pluginLoadFailures: 0,
              metadataScanMentions: 0,
              configNormalizationMentions: 0,
              gatewayRestartMentions: 0,
              providerLoadMentions: 0,
              modelCatalogMentions: 0,
              providerTimeoutMentions: 0,
              eventLoopDelayMentions: 0,
              v8DiagnosticMentions: 0
            }
          }
        }
      ],
      finalMetrics: {
        service: { gatewayState: "running" },
        logs: {
          missingDependencyErrors: 0,
          pluginLoadFailures: 0,
          metadataScanMentions: 0,
          configNormalizationMentions: 0,
          gatewayRestartMentions: 0,
          providerLoadMentions: 0,
          modelCatalogMentions: 0,
          providerTimeoutMentions: 0,
          eventLoopDelayMentions: 0,
          v8DiagnosticMentions: 0
        }
      }
    };
    evaluateRecord(record, { thresholds: { gatewayReadyMs: 30000 } });
    assertEqual(record.status, "FAIL", "slow readiness status");
    assertEqual(record.measurements.readinessClassification, "slow-startup", "readiness classification");
    assertEqual(
      record.violations.some((violation) => violation.metric === "readinessClassification"),
      true,
      "readiness violation"
    );
    return {
      id: "readiness-classification",
      status: "PASS",
      command: "evaluate synthetic slow readiness record",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "readiness-classification",
      status: "FAIL",
      command: "evaluate synthetic slow readiness record",
      durationMs: 0,
      message: error.message
    };
  }
}

async function commandCheck(id, command) {
  const result = await runCommand(command, { timeoutMs: 30000 });
  return {
    id,
    status: result.status === 0 ? "PASS" : "FAIL",
    command,
    durationMs: result.durationMs,
    message: result.status === 0 ? "" : result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`
  };
}

async function failingCommandCheck(id, command, expectedMessage) {
  const result = await runCommand(command, { timeoutMs: 30000, maxOutputChars: 1000000 });
  const output = `${result.stdout}\n${result.stderr}`;
  return {
    id,
    status: result.status !== 0 && output.includes(expectedMessage) ? "PASS" : "FAIL",
    command,
    durationMs: result.durationMs,
    message: result.status !== 0 && output.includes(expectedMessage)
      ? ""
      : `expected failure containing ${JSON.stringify(expectedMessage)}, got status ${result.status}: ${output.trim()}`
  };
}

async function jsonCommandCheck(id, command, validate) {
  const result = await runCommand(command, { timeoutMs: 30000, maxOutputChars: 1000000 });
  if (result.status !== 0) {
    return {
      id,
      status: "FAIL",
      command,
      durationMs: result.durationMs,
      message: result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`
    };
  }

  try {
    const data = JSON.parse(result.stdout);
    await validate(data);
    return {
      id,
      status: "PASS",
      command,
      durationMs: result.durationMs,
      data
    };
  } catch (error) {
    return {
      id,
      status: "FAIL",
      command,
      durationMs: result.durationMs,
      message: error.message
    };
  }
}

function validateReport(report) {
  try {
    assertEqual(report.schemaVersion, "kova.report.v1", "report schema");
    assertEqual(report.mode, "dry-run", "report mode");
    assertEqual(report.summary?.statuses?.["DRY-RUN"], 1, "report dry-run count");
    assertArrayNotEmpty(report.records, "report records");
    return {
      id: "dry-run-report-file",
      status: "PASS",
      command: "read generated JSON report",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "dry-run-report-file",
      status: "FAIL",
      command: "read generated JSON report",
      durationMs: 0,
      message: error.message
    };
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function assertArray(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
}

function assertArrayNotEmpty(value, label) {
  assertArray(value, label);
  if (value.length === 0) {
    throw new Error(`${label} must not be empty`);
  }
}
