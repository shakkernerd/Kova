import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { quoteShell, runCommand } from "./commands.mjs";
import { summarizeCpuProfiles } from "./collectors/node-profiles.mjs";
import { summarizeHeapProfiles } from "./collectors/heap.mjs";
import { evaluateRecord } from "./evaluator.mjs";
import { evaluateGate } from "./gate.mjs";
import {
  comparePerformanceToBaseline,
  loadBaselineStore,
  saveBaselineStore,
  updateBaselineStore
} from "./performance/baselines.mjs";
import { buildPerformanceSummary } from "./performance/stats.mjs";
import { loadProcessRoles } from "./registries/process-roles.mjs";
import { validateStateShape } from "./registries/states.mjs";
import { validateRegistryReferences } from "./registries/validate.mjs";
import { assertSafeScenarioCommand } from "./safety.mjs";
import { parseTimelineText } from "./collectors/timeline.mjs";
import { renderPasteSummary, renderReportSummary } from "./report.mjs";

export async function runSelfCheck(flags = {}) {
  const checks = [];
  const tmp = await mkdtemp(join(tmpdir(), "kova-self-check-"));

  try {
    checks.push(await commandCheck(
      "syntax",
      "for f in bin/kova.mjs $(find src -name '*.mjs' -type f | sort); do node --check \"$f\" || exit 1; done"
    ));
    checks.push(await jsonCommandCheck("version-json", "node bin/kova.mjs version --json", (data) => {
      assertEqual(data.schemaVersion, "kova.version.v1", "version schema");
      assertString(data.version, "version");
    }));
    checks.push(await jsonCommandCheck("setup-json", "node bin/kova.mjs setup --ci --json", (data) => {
      assertEqual(data.schemaVersion, "kova.setup.v1", "setup schema");
      assertEqual(data.ok, true, "setup ok");
      assertEqual(data.auth?.method, "mock", "setup auth default");
      assertArrayNotEmpty(data.checks, "setup checks");
    }));
    checks.push(await failingCommandCheck(
      "setup-non-tty-requires-mode",
      "node bin/kova.mjs setup --json",
      "kova setup requires --non-interactive or --ci when stdin is not a TTY"
    ));
    checks.push(await credentialStoreSelfCheck(tmp));
    checks.push(await failingCommandCheck(
      "live-auth-requires-credentials",
      `KOVA_HOME=${quoteShell(join(tmp, "empty-auth-home"))} node bin/kova.mjs run --target runtime:stable --scenario fresh-install --auth live --json`,
      "--auth live requires configured live credentials"
    ));
    checks.push(await interactiveSetupChoiceCheck(tmp));
    checks.push(await externalCliSetupCheck(tmp));
    checks.push(await externalCliOpenClawConfigCheck(tmp));
    checks.push(await failingCommandCheck(
      "setup-custom-provider-rejects-external-cli",
      `KOVA_HOME=${quoteShell(join(tmp, "custom-external-cli-home"))} node bin/kova.mjs setup --non-interactive --provider custom-openai --auth external-cli --json`,
      "external-cli auth is only supported for provider openai or anthropic"
    ));
    checks.push(await failingCommandCheck(
      "setup-external-cli-verifies-auth",
      `HOME=${quoteShell(join(tmp, "no-codex-auth"))} KOVA_HOME=${quoteShell(join(tmp, "missing-external-cli-auth-home"))} node bin/kova.mjs setup --non-interactive --provider openai --auth external-cli --json`,
      "external-cli codex is not usable"
    ));
    checks.push(await externalCliRunAuthVerificationCheck(tmp));
    checks.push(await jsonCommandCheck("plan-json", "node bin/kova.mjs plan --json", (data) => {
      assertEqual(data.schemaVersion, "kova.plan.v1", "plan schema");
      assertArrayNotEmpty(data.surfaces, "plan surfaces");
      assertArrayNotEmpty(data.processRoles, "plan process roles");
      assertArrayNotEmpty(data.scenarios, "plan scenarios");
      assertArrayNotEmpty(data.states, "plan states");
      assertArrayNotEmpty(data.profiles, "profiles");
      assertEqual(data.coverage?.schemaVersion, "kova.coverage.v1", "coverage schema");
      assertArrayNotEmpty(data.coverage?.scenarioSurfaceMap, "scenario surface map");
      if (data.scenarios.some((scenario) => typeof scenario.surface !== "string" || scenario.surface.length === 0)) {
        throw new Error("every scenario must expose a surface");
      }
    }));
    checks.push(await jsonCommandCheck("matrix-plan-json", "node bin/kova.mjs matrix plan --profile smoke --target runtime:stable --include scenario:fresh-install --parallel 2 --json", (data) => {
      assertEqual(data.schemaVersion, "kova.matrix.plan.v1", "matrix plan schema");
      assertEqual(data.profile?.id, "smoke", "matrix profile id");
      assertArrayNotEmpty(data.entries, "matrix entries");
      assertEqual(data.entries.length, 1, "matrix include filter count");
      assertEqual(data.controls?.requestedParallel, 2, "matrix requested parallel");
    }));
    checks.push(await jsonCommandCheck("matrix-plan-repeat-json", "node bin/kova.mjs matrix plan --profile smoke --target runtime:stable --include scenario:fresh-install --repeat 3 --json", (data) => {
      assertEqual(data.controls?.repeat, 3, "matrix repeat control");
    }));
    checks.push(await jsonCommandCheck("run-auth-default-mock-json", `node bin/kova.mjs run --target runtime:stable --scenario fresh-install --report-dir ${quoteShell(tmp)} --json`, async (data) => {
      const report = JSON.parse(await readFile(data.jsonPath, "utf8"));
      const record = report.records?.[0];
      assertEqual(record?.auth?.mode, "mock", "default auth mode");
      const phaseIds = record?.phases?.map((phase) => phase.id) ?? [];
      if (!phaseIds.includes("auth-prepare") || !phaseIds.includes("auth-setup") || !phaseIds.includes("auth-cleanup")) {
        throw new Error(`default mock auth phases missing: ${phaseIds.join(", ")}`);
      }
    }));
    checks.push(await jsonCommandCheck("run-auth-missing-override-json", `node bin/kova.mjs run --target runtime:stable --scenario provider-models --state model-auth-missing --report-dir ${quoteShell(tmp)} --json`, async (data) => {
      const report = JSON.parse(await readFile(data.jsonPath, "utf8"));
      const record = report.records?.[0];
      assertEqual(record?.auth?.mode, "missing", "missing auth override mode");
      const phaseIds = record?.phases?.map((phase) => phase.id) ?? [];
      if (phaseIds.includes("auth-prepare") || phaseIds.includes("auth-setup")) {
        throw new Error(`missing auth override should not inject auth phases: ${phaseIds.join(", ")}`);
      }
    }));
    checks.push(await jsonCommandCheck("diagnostic-profile-plan-json", "node bin/kova.mjs matrix plan --profile diagnostic --target local-build:/tmp/openclaw --include scenario:release-runtime-startup --json", (data) => {
      assertEqual(data.schemaVersion, "kova.matrix.plan.v1", "diagnostic matrix plan schema");
      assertEqual(data.profile?.id, "diagnostic", "diagnostic profile id");
      assertEqual(data.profile?.diagnostics?.timelineRequired, true, "diagnostic timeline required");
      assertArrayNotEmpty(data.entries, "diagnostic entries");
    }));
    checks.push(await failingCommandCheck(
      "diagnostic-profile-rejects-non-local-build",
      "node bin/kova.mjs matrix plan --profile diagnostic --target runtime:stable --json",
      "profile 'diagnostic' requires target kind local-build"
    ));
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
    checks.push(await failingCommandCheck(
      "baseline-requires-execute",
      "node bin/kova.mjs run --target runtime:stable --scenario fresh-install --baseline --json",
      "--baseline and --save-baseline require --execute"
    ));
    checks.push(await jsonCommandCheck("cleanup-json", "node bin/kova.mjs cleanup envs --json", (data) => {
      assertEqual(data.schemaVersion, "kova.cleanup.envs.v1", "cleanup schema");
      assertEqual(data.execute, false, "cleanup execute flag");
      assertArray(data.envs, "cleanup envs");
    }));
    checks.push(await diagnosticsTimelineCheck());
    checks.push(await diagnosticsOpenSpanCheck());
    checks.push(diagnosticsTimelineEvaluationCheck());
    checks.push(await performanceBaselineCheck(tmp));
    checks.push(readinessClassificationCheck());
    checks.push(await resourceRoleAttributionCheck(tmp));
    checks.push(roleThresholdEvaluationCheck());
    checks.push(stateRegistryValidationCheck());
    checks.push(scenarioStateCompatibilityCheck());
    checks.push(await cpuProfileParserCheck());
    checks.push(await heapProfileParserCheck());
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
        const command = report.records?.[0]?.phases
          ?.flatMap((phase) => phase.commands ?? [])
          ?.find((item) => item.includes("ocm env clone")) ?? "";
        if (!command.includes("ocm env clone 'Team Env'")) {
          throw new Error(`source env was not shell-quoted: ${command}`);
        }
      }
    ));
    checks.push(await localBuildRuntimeCleanupCheck(tmp));
    checks.push(await localBuildRuntimeAlreadyAbsentCleanupCheck(tmp));

    const receiptCheck = await jsonCommandCheck(
      "dry-run-report-json",
      `node bin/kova.mjs run --target runtime:stable --scenario fresh-install --repeat 2 --report-dir ${quoteShell(tmp)} --json`,
      (data) => {
        assertEqual(data.schemaVersion, "kova.run.receipt.v1", "run receipt schema");
        assertEqual(data.mode, "dry-run", "run mode");
        assertEqual(data.summary?.statuses?.["DRY-RUN"], 2, "dry-run repeat count");
        assertEqual(data.performance?.repeat, 2, "run receipt repeat");
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
    checks.push(gatePartialFailureCheck());
    checks.push(safetyGuardCheck());
    checks.push(await failingCommandCheck(
      "gate-preflight-source-env",
      `node bin/kova.mjs matrix run --profile release --target runtime:stable --execute --gate --report-dir ${quoteShell(tmp)} --json`,
      "release gate preflight failed: --source-env <env> is required"
    ));

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

function gatePartialFailureCheck() {
  try {
    const gate = evaluateGate({
      mode: "execution",
      controls: {
        include: ["scenario:release-runtime-startup"],
        exclude: []
      },
      records: [
        {
          scenario: "release-runtime-startup",
          state: { id: "fresh" },
          status: "FAIL",
          title: "Release Runtime Startup",
          likelyOwner: "OpenClaw",
          violations: [{ message: "gateway became healthy after 47100ms, beyond the 30000ms threshold" }],
          phases: []
        }
      ]
    }, {
      id: "release",
      gate: {
        id: "test-release-gate",
        blocking: [
          { scenario: "release-runtime-startup", state: "fresh" },
          { scenario: "fresh-install", state: "fresh" }
        ]
      }
    });

    assertEqual(gate.verdict, "DO_NOT_SHIP", "partial gate failure verdict");
    assertEqual(gate.partial, true, "partial gate marker");
    assertEqual(gate.complete, false, "partial gate completeness");
    assertEqual(gate.missingRequiredCount, 1, "partial gate missing count");
    assertEqual(gate.cards.some((card) => card.kind === "filtered-required-scenario"), true, "filtered required card");
    return {
      id: "gate-partial-failure-do-not-ship",
      status: "PASS",
      command: "evaluate synthetic partial release gate failure",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "gate-partial-failure-do-not-ship",
      status: "FAIL",
      command: "evaluate synthetic partial release gate failure",
      durationMs: 0,
      message: error.message
    };
  }
}

async function performanceBaselineCheck(tmp) {
  try {
    const platform = { os: "darwin", arch: "arm64", release: "test", node: "v24.0.0" };
    const targetPlan = { kind: "local-build" };
    const baselineReport = syntheticPerformanceReport({
      runId: "baseline",
      platform,
      target: "local-build:/tmp/openclaw",
      records: [
        syntheticPerformanceRecord(1, { timeToHealthReadyMs: 1000, peakRssMb: 400, cpuPercentMax: 20, eventLoopDelayMs: 100, agentTurnMs: 2000 }),
        syntheticPerformanceRecord(2, { timeToHealthReadyMs: 1200, peakRssMb: 420, cpuPercentMax: 22, eventLoopDelayMs: 110, agentTurnMs: 2200 }),
        syntheticPerformanceRecord(3, { timeToHealthReadyMs: 1100, peakRssMb: 410, cpuPercentMax: 21, eventLoopDelayMs: 105, agentTurnMs: 2100 })
      ]
    });
    baselineReport.performance = buildPerformanceSummary(baselineReport.records, { repeat: 3 });

    const baselinePath = join(tmp, "baselines.json");
    const savedStore = updateBaselineStore(await loadBaselineStore(baselinePath), baselineReport, { targetPlan });
    await saveBaselineStore(baselinePath, savedStore);
    const loadedStore = await loadBaselineStore(baselinePath);
    assertEqual(Object.keys(loadedStore.entries).length, 1, "baseline entry count");

    const currentReport = syntheticPerformanceReport({
      runId: "current",
      platform,
      target: "local-build:/tmp/openclaw",
      records: [
        syntheticPerformanceRecord(1, { timeToHealthReadyMs: 1800, peakRssMb: 500, cpuPercentMax: 30, eventLoopDelayMs: 180, agentTurnMs: 3000 }),
        syntheticPerformanceRecord(2, { timeToHealthReadyMs: 1900, peakRssMb: 510, cpuPercentMax: 31, eventLoopDelayMs: 190, agentTurnMs: 3100 }),
        syntheticPerformanceRecord(3, { timeToHealthReadyMs: 2000, peakRssMb: 520, cpuPercentMax: 32, eventLoopDelayMs: 200, agentTurnMs: 3200 })
      ]
    });
    currentReport.performance = buildPerformanceSummary(currentReport.records, { repeat: 3 });
    assertEqual(currentReport.performance.groups[0].metrics.timeToHealthReadyMs.median, 1900, "performance median");
    assertEqual(currentReport.performance.groups[0].metrics.timeToHealthReadyMs.p95, 1990, "performance p95");

    const comparison = comparePerformanceToBaseline(currentReport, loadedStore, {
      targetPlan,
      regressionThresholds: {
        startupRegressionPercent: 10,
        rssRegressionPercent: 10,
        cpuRegressionPercent: 10,
        eventLoopRegressionPercent: 10,
        agentLatencyRegressionPercent: 10
      }
    });
    assertEqual(comparison.ok, false, "baseline comparison regression");
    assertEqual(comparison.regressions.some((regression) => regression.metric === "timeToHealthReadyMs"), true, "startup regression present");

    const gate = evaluateGate({
      mode: "execution",
      controls: {},
      platform,
      baseline: { path: baselinePath, comparison },
      records: currentReport.records
    }, {
      id: "perf-gate",
      gate: {
        id: "perf-gate",
        blocking: [{ scenario: "fresh-install", state: "fresh" }]
      }
    });
    assertEqual(gate.verdict, "DO_NOT_SHIP", "performance regression gate verdict");
    assertEqual(gate.cards.some((card) => card.kind === "performance-regression"), true, "performance regression gate card");

    return {
      id: "performance-baseline-regression",
      status: "PASS",
      command: "evaluate synthetic repeat performance baseline",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "performance-baseline-regression",
      status: "FAIL",
      command: "evaluate synthetic repeat performance baseline",
      durationMs: 0,
      message: error.message
    };
  }
}

function syntheticPerformanceReport({ runId, platform, target, records }) {
  return {
    schemaVersion: "kova.report.v1",
    generatedAt: "2026-04-29T00:00:00.000Z",
    runId,
    mode: "execution",
    target,
    platform,
    records
  };
}

function syntheticPerformanceRecord(index, measurements) {
  return {
    scenario: "fresh-install",
    surface: "fresh-install",
    title: "Fresh Install",
    status: "PASS",
    target: "local-build:/tmp/openclaw",
    state: { id: "fresh", title: "Fresh" },
    repeat: { index, total: 3 },
    envName: `kova-fresh-install-r${index}`,
    measurements,
    phases: []
  };
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
    const summary = renderReportSummary(report, { structured: true });
    assertString(summary.failureBrief?.fixerPrompt, "failure brief fixer prompt");
    assertString(data.retainedGateArtifacts?.outputDir, "retained gate artifact dir");
    assertString(data.retainedGateArtifacts?.pasteSummaryPath, "retained paste summary path");
    const retained = JSON.parse(await readFile(`${data.retainedGateArtifacts.outputDir}/retained-artifacts.json`, "utf8"));
    assertEqual(retained.verdict, "BLOCKED", "retained artifact verdict");
    await rm(data.retainedGateArtifacts.outputDir, { recursive: true, force: true });
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

function safetyGuardCheck() {
  try {
    assertSafeScenarioCommand("ocm start kova-safe-test --runtime stable --json", {}, "kova-safe-test");
    assertSafeScenarioCommand("ocm env clone 'Team Env' kova-safe-test --json", { sourceEnv: "Team Env" }, "kova-safe-test");
    let blocked = false;
    try {
      assertSafeScenarioCommand("ocm env destroy Violet --yes", {}, "kova-safe-test");
    } catch (error) {
      blocked = /refusing to mutate non-Kova/.test(error.message);
    }
    assertEqual(blocked, true, "durable env mutation blocked");
    return {
      id: "durable-env-mutation-guard",
      status: "PASS",
      command: "evaluate synthetic command guard cases",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "durable-env-mutation-guard",
      status: "FAIL",
      command: "evaluate synthetic command guard cases",
      durationMs: 0,
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

async function heapProfileParserCheck() {
  try {
    const summary = await summarizeHeapProfiles(["fixtures/diagnostics/sample.heapprofile"], { limit: 3 });
    assertEqual(summary.profileCount, 1, "heap profile count");
    assertEqual(summary.parseErrorCount, 0, "heap profile parse errors");
    assertEqual(summary.topFunctions[0]?.functionName, "loadBundledPluginMetadata", "top heap function");
    assertEqual(summary.topFunctions[0]?.selfSizeMb, 7, "top heap size mb");
    return {
      id: "heap-profile-parser",
      status: "PASS",
      command: "parse fixtures/diagnostics/sample.heapprofile",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "heap-profile-parser",
      status: "FAIL",
      command: "parse fixtures/diagnostics/sample.heapprofile",
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
    assertEqual(timeline.keySpans["gateway.startup"].maxDurationMs, 2450, "gateway startup key span");
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

async function diagnosticsOpenSpanCheck() {
  try {
    const text = await readFile("fixtures/diagnostics/timeline-open-span.jsonl", "utf8");
    const timeline = parseTimelineText(text);
    assertEqual(timeline.available, true, "open timeline available");
    assertEqual(timeline.openSpanCount, 1, "open span count");
    assertEqual(timeline.openSpans[0]?.name, "runtimeDeps.stage", "open span name");
    assertEqual(timeline.openSpans[0]?.ageMs, 5000, "open span age");
    assertEqual(timeline.keySpans["runtimeDeps.stage"].openCount, 1, "key open span count");
    return {
      id: "diagnostics-open-span-parser",
      status: "PASS",
      command: "parse fixtures/diagnostics/timeline-open-span.jsonl",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "diagnostics-open-span-parser",
      status: "FAIL",
      command: "parse fixtures/diagnostics/timeline-open-span.jsonl",
      durationMs: 0,
      message: error.message
    };
  }
}

function diagnosticsTimelineEvaluationCheck() {
  try {
    const missingTimelineRecord = {
      scenario: "diagnostic-missing-timeline",
      status: "PASS",
      phases: [],
      finalMetrics: {
        service: { gatewayState: "running" },
        logs: zeroLogMetrics(),
        timeline: {
          available: false,
          eventCount: 0,
          parseErrorCount: 0,
          openSpanCount: 0,
          openSpans: [],
          keySpans: {},
          runtimeDeps: {},
          eventLoop: {},
          providers: {},
          childProcesses: {}
        }
      }
    };
    evaluateRecord(missingTimelineRecord, { thresholds: {} }, {
      targetPlan: { kind: "local-build" },
      profile: {
        id: "diagnostic",
        diagnostics: {
          timelineRequired: true,
          timelineRequiredForTargetKinds: ["local-build"]
        }
      },
      surface: {
        id: "release-runtime-startup",
        diagnostics: { expectedSpans: ["runtimeDeps.stage"] },
        thresholds: {}
      }
    });
    assertEqual(missingTimelineRecord.status, "FAIL", "missing diagnostic timeline status");
    assertEqual(
      missingTimelineRecord.violations.some((violation) => violation.metric === "openclawTimelineAvailable"),
      true,
      "missing diagnostic timeline violation"
    );

    const openSpanRecord = {
      scenario: "diagnostic-open-span",
      status: "PASS",
      phases: [],
      finalMetrics: {
        service: { gatewayState: "running" },
        logs: zeroLogMetrics(),
        timeline: parseTimelineText([
          "{\"type\":\"span.start\",\"timestamp\":\"2026-04-29T15:30:00.000Z\",\"name\":\"runtimeDeps.stage\",\"spanId\":\"1\"}",
          "{\"type\":\"eventLoop.sample\",\"timestamp\":\"2026-04-29T15:30:06.000Z\",\"name\":\"eventLoop\",\"maxMs\":400}"
        ].join("\n"))
      }
    };
    evaluateRecord(openSpanRecord, { thresholds: {} }, {
      targetPlan: { kind: "local-build" },
      profile: { id: "diagnostic", diagnostics: { timelineRequired: true } },
      surface: {
        id: "bundled-runtime-deps",
        diagnostics: { expectedSpans: ["runtimeDeps.stage"] },
        thresholds: {}
      }
    });
    assertEqual(openSpanRecord.status, "FAIL", "open required span status");
    assertEqual(openSpanRecord.measurements.openclawOpenRequiredSpanCount, 1, "open required span measurement");
    assertEqual(
      openSpanRecord.violations.some((violation) => violation.metric === "openclawOpenRequiredSpanCount"),
      true,
      "open required span violation"
    );
    const reportSummary = renderReportSummary({
      schemaVersion: "kova.report.v1",
      generatedAt: "2026-04-29T15:30:10.000Z",
      runId: "self-check-diagnostics",
      summary: { total: 1, statuses: { FAIL: 1 } },
      records: [openSpanRecord]
    }, { structured: true });
    assertEqual(
      reportSummary.scenarios[0]?.measurements?.openclawOpenRequiredSpanCount,
      1,
      "structured report open span evidence"
    );
    assertEqual(
      reportSummary.scenarios[0]?.measurements?.openclawOpenSpans?.[0]?.name,
      "runtimeDeps.stage",
      "structured report open span name"
    );
    assertEqual(
      renderPasteSummary({
        runId: "self-check-diagnostics",
        target: "local-build:/tmp/openclaw",
        mode: "self-check",
        records: [openSpanRecord]
      }).includes("openRequiredSpans: 1"),
      true,
      "brief evidence includes open required spans"
    );

    return {
      id: "diagnostics-timeline-evaluation",
      status: "PASS",
      command: "evaluate synthetic diagnostic timeline records",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "diagnostics-timeline-evaluation",
      status: "FAIL",
      command: "evaluate synthetic diagnostic timeline records",
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

async function resourceRoleAttributionCheck(tmp) {
  const command = "node -e 'setTimeout(() => {}, 650)'";
  const artifactPath = join(tmp, "resource-role-attribution.jsonl");
  const result = await runCommand(command, {
    timeoutMs: 5000,
    resourceSample: {
      intervalMs: 250,
      processRoles: await loadProcessRoles(),
      artifactPath
    }
  });

  try {
    assertEqual(result.status, 0, "resource attribution command status");
    assertEqual(result.resourceSamples?.schemaVersion, "kova.resourceSamples.v1", "resource schema");
    assertEqual(Boolean(result.resourceSamples?.byRole?.["command-tree"]), true, "command-tree role");
    assertEqual(Boolean(result.resourceSamples?.byRole?.uncategorized), true, "uncategorized role");
    assertArrayNotEmpty(result.resourceSamples?.topRolesByRss, "top roles by RSS");
    assertString(result.resourceSamples?.artifactPath, "resource artifact path");
    return {
      id: "resource-role-attribution",
      status: "PASS",
      command,
      durationMs: result.durationMs
    };
  } catch (error) {
    return {
      id: "resource-role-attribution",
      status: "FAIL",
      command,
      durationMs: result.durationMs,
      message: error.message
    };
  }
}

function roleThresholdEvaluationCheck() {
  try {
    const record = {
      scenario: "synthetic-role-threshold",
      title: "Synthetic Role Threshold",
      status: "PASS",
      phases: [
        {
          id: "sample",
          results: [
            {
              command: "synthetic",
              status: 0,
              durationMs: 1,
              resourceSamples: {
                schemaVersion: "kova.resourceSamples.v1",
                sampleCount: 1,
                peakTotalRssMb: 250,
                maxTotalCpuPercent: 80,
                byRole: {
                  gateway: {
                    peakRssMb: 250,
                    maxCpuPercent: 80,
                    peakRssAtMs: 10,
                    peakCpuAtMs: 10,
                    peakProcessCount: 1
                  }
                },
                topRolesByRss: [{ role: "gateway", peakRssMb: 250, maxCpuPercent: 80 }],
                topRolesByCpu: [{ role: "gateway", peakRssMb: 250, maxCpuPercent: 80 }],
                topByRss: [],
                topByCpu: []
              }
            }
          ],
          metrics: {
            logs: zeroLogMetrics()
          }
        }
      ],
      finalMetrics: {
        service: { gatewayState: "running" },
        logs: zeroLogMetrics()
      }
    };
    evaluateRecord(record, { thresholds: {} }, {
      surface: {
        thresholds: {},
        roleThresholds: {
          gateway: { peakRssMb: 100, maxCpuPercent: 50 }
        }
      }
    });
    assertEqual(record.status, "FAIL", "role threshold status");
    assertEqual(record.measurements.resourceByRole.gateway.peakRssMb, 250, "gateway role RSS measurement");
    assertEqual(
      record.violations.some((violation) => violation.metric === "resourceByRole.gateway.peakRssMb"),
      true,
      "role RSS violation"
    );
    assertEqual(
      record.violations.some((violation) => violation.metric === "resourceByRole.gateway.maxCpuPercent"),
      true,
      "role CPU violation"
    );
    return {
      id: "resource-role-thresholds",
      status: "PASS",
      command: "evaluate synthetic role resource thresholds",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "resource-role-thresholds",
      status: "FAIL",
      command: "evaluate synthetic role resource thresholds",
      durationMs: 0,
      message: error.message
    };
  }
}

function stateRegistryValidationCheck() {
  try {
    let rejectedTrait = false;
    try {
      validateStateShape({
        id: "bad-state",
        title: "Bad State",
        objective: "Invalid state fixture",
        tags: [],
        traits: ["not-a-real-trait"],
        compatibleSurfaces: [],
        incompatibleSurfaces: [],
        riskArea: "test",
        ownerArea: "test",
        setupEvidence: ["evidence"],
        cleanupGuarantees: ["cleanup"],
        setup: []
      }, "bad-state.json");
    } catch (error) {
      rejectedTrait = /unknown trait/.test(error.message);
    }
    assertEqual(rejectedTrait, true, "unknown state trait rejected");

    let rejectedEvidence = false;
    try {
      validateStateShape({
        id: "bad-evidence-state",
        title: "Bad Evidence State",
        objective: "Invalid state fixture evidence",
        tags: [],
        traits: ["fresh-user"],
        compatibleSurfaces: [],
        incompatibleSurfaces: [],
        riskArea: "test",
        ownerArea: "test",
        setupEvidence: [],
        cleanupGuarantees: [],
        setup: []
      }, "bad-evidence-state.json");
    } catch (error) {
      rejectedEvidence = /setupEvidence must not be empty/.test(error.message) &&
        /cleanupGuarantees must not be empty/.test(error.message);
    }
    assertEqual(rejectedEvidence, true, "empty state evidence rejected");

    let rejectedSurface = false;
    try {
      validateRegistryReferences({
        scenarios: [{
          id: "scenario",
          surface: "known-surface",
          states: [],
          targetKinds: [],
          processRoles: []
        }],
        states: [{
          id: "state",
          traits: ["fresh-user"],
          compatibleSurfaces: ["missing-surface"],
          incompatibleSurfaces: []
        }],
        profiles: [],
        surfaces: [{
          id: "known-surface",
          processRoles: [],
          requiredStates: [],
          targetKinds: []
        }],
        processRoles: []
      });
    } catch (error) {
      rejectedSurface = /compatibleSurfaces references unknown surface/.test(error.message);
    }
    assertEqual(rejectedSurface, true, "unknown compatible surface rejected");

    let rejectedCoveragePair = false;
    try {
      validateRegistryReferences({
        scenarios: [{
          id: "scenario",
          surface: "known-surface",
          states: [],
          targetKinds: [],
          processRoles: []
        }],
        states: [{
          id: "state",
          traits: ["fresh-user"],
          compatibleSurfaces: ["other-surface"],
          incompatibleSurfaces: ["known-surface"]
        }],
        profiles: [{
          id: "profile",
          entries: [],
          gate: {
            coverage: {
              stateSurfaces: {
                blocking: ["known-surface:state"]
              }
            }
          }
        }],
        surfaces: [
          {
            id: "known-surface",
            processRoles: [],
            requiredStates: [],
            targetKinds: []
          },
          {
            id: "other-surface",
            processRoles: [],
            requiredStates: [],
            targetKinds: []
          }
        ],
        processRoles: []
      });
    } catch (error) {
      rejectedCoveragePair = /explicitly incompatible state\/surface pair/.test(error.message) ||
        /state compatible surfaces/.test(error.message);
    }
    assertEqual(rejectedCoveragePair, true, "invalid coverage state/surface pair rejected");

    return {
      id: "state-registry-validation",
      status: "PASS",
      command: "evaluate synthetic invalid state contracts",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "state-registry-validation",
      status: "FAIL",
      command: "evaluate synthetic invalid state contracts",
      durationMs: 0,
      message: error.message
    };
  }
}

function scenarioStateCompatibilityCheck() {
  try {
    let rejected = false;
    try {
      validateRegistryReferences({
        scenarios: [{
          id: "upgrade-existing-user",
          surface: "upgrade-existing-user",
          states: [],
          targetKinds: [],
          processRoles: []
        }],
        states: [{
          id: "fresh",
          traits: ["fresh-user"],
          compatibleSurfaces: ["fresh-install"],
          incompatibleSurfaces: ["upgrade-existing-user"]
        }],
        profiles: [{
          id: "bad-profile",
          entries: [{ scenario: "upgrade-existing-user", state: "fresh" }]
        }],
        surfaces: [{
          id: "upgrade-existing-user",
          processRoles: [],
          requiredStates: ["old-release-user"],
          targetKinds: []
        }],
        processRoles: []
      });
    } catch (error) {
      rejected = /pairs scenario 'upgrade-existing-user' with state 'fresh'/.test(error.message) ||
        /explicitly incompatible surface/.test(error.message);
    }
    assertEqual(rejected, true, "invalid scenario/state profile pairing rejected");
    return {
      id: "scenario-state-compatibility",
      status: "PASS",
      command: "evaluate synthetic invalid scenario/state pairing",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "scenario-state-compatibility",
      status: "FAIL",
      command: "evaluate synthetic invalid scenario/state pairing",
      durationMs: 0,
      message: error.message
    };
  }
}

function zeroLogMetrics() {
  return {
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
  };
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

async function credentialStoreSelfCheck(tmp) {
  const home = join(tmp, "credentials-home");
  const command = `KOVA_HOME=${quoteShell(home)} node bin/kova.mjs setup --non-interactive --auth env-only --provider openai --env-var OPENAI_API_KEY --json`;
  const result = await runCommand(command, { timeoutMs: 30000, maxOutputChars: 1000000 });
  try {
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`);
    }
    const data = JSON.parse(result.stdout);
    assertEqual(data.schemaVersion, "kova.setup.v1", "setup schema");
    assertEqual(data.auth?.method, "env-only", "setup auth method");
    const liveEnv = join(home, "credentials", "live.env");
    const metadata = await stat(liveEnv);
    const mode = metadata.mode & 0o777;
    if (mode !== 0o600) {
      throw new Error(`live.env permissions expected 0600, got ${mode.toString(8)}`);
    }
    return {
      id: "credential-store",
      status: "PASS",
      command,
      durationMs: result.durationMs
    };
  } catch (error) {
    return {
      id: "credential-store",
      status: "FAIL",
      command,
      durationMs: result.durationMs,
      message: error.message
    };
  }
}

async function interactiveSetupChoiceCheck(tmp) {
  const home = join(tmp, "numeric-auth-home");
  const command = `KOVA_HOME=${quoteShell(home)} node bin/kova.mjs setup --non-interactive --provider 2 --auth 3 --value kova-selfcheck-key --json`;
  const result = await runCommand(command, { timeoutMs: 30000, maxOutputChars: 1000000 });
  try {
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`);
    }
    const data = JSON.parse(result.stdout);
    assertEqual(data.schemaVersion, "kova.setup.v1", "numeric setup schema");
    assertEqual(data.auth?.provider, "anthropic", "provider selected by number");
    assertEqual(data.auth?.method, "api-key", "auth method selected by number");
    assertEqual(data.auth?.envVar, "ANTHROPIC_API_KEY", "provider env var default");
    return {
      id: "setup-provider-auth-numeric",
      status: "PASS",
      command,
      durationMs: result.durationMs
    };
  } catch (error) {
    return {
      id: "setup-provider-auth-numeric",
      status: "FAIL",
      command,
      durationMs: result.durationMs,
      message: error.message
    };
  }
}

async function externalCliSetupCheck(tmp) {
  const home = join(tmp, "external-cli-home");
  const fakeBin = join(tmp, "fake-bin");
  const kovaHome = join(tmp, "external-cli-kova-home");
  await mkdir(join(home, ".codex"), { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  const fakeCodex = join(fakeBin, "codex");
  await writeFile(join(home, ".codex", "auth.json"), "{\"tokens\":{\"access_token\":\"redacted\"}}\n", "utf8");
  await writeFile(fakeCodex, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(fakeCodex, 0o755);

  const command = [
    `HOME=${quoteShell(home)}`,
    `PATH=${quoteShell(`${fakeBin}:${process.env.PATH ?? ""}`)}`,
    `KOVA_HOME=${quoteShell(kovaHome)}`,
    "node bin/kova.mjs setup --non-interactive --provider openai --auth external-cli --json"
  ].join(" ");
  const result = await runCommand(command, { timeoutMs: 30000, maxOutputChars: 1000000 });
  try {
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`);
    }
    const data = JSON.parse(result.stdout);
    assertEqual(data.schemaVersion, "kova.setup.v1", "external cli setup schema");
    assertEqual(data.auth?.provider, "openai", "external cli provider");
    assertEqual(data.auth?.method, "external-cli", "external cli method");
    assertEqual(data.auth?.externalCli, "codex", "external cli name");
    assertEqual(data.auth?.verification?.verified, true, "external cli verification");
    const credential = data.checks?.find((check) => check.id === "credentials");
    if (!credential || !credential.message.includes("external-cli codex verified")) {
      throw new Error(`credential check did not report verified external CLI: ${credential?.message ?? "missing"}`);
    }
    return {
      id: "setup-external-cli-verification",
      status: "PASS",
      command,
      durationMs: result.durationMs
    };
  } catch (error) {
    return {
      id: "setup-external-cli-verification",
      status: "FAIL",
      command,
      durationMs: result.durationMs,
      message: error.message
    };
  }
}

async function externalCliOpenClawConfigCheck(tmp) {
  const home = join(tmp, "external-cli-config-home");
  const command = [
    `OPENCLAW_HOME=${quoteShell(home)}`,
    "node support/configure-openclaw-live-auth.mjs --provider openai --auth-method external-cli --external-cli codex"
  ].join(" ");
  const result = await runCommand(command, { timeoutMs: 30000, maxOutputChars: 1000000 });
  try {
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`);
    }
    const config = JSON.parse(await readFile(join(home, ".openclaw", "openclaw.json"), "utf8"));
    assertEqual(config.agents?.defaults?.model?.primary, "openai/gpt-5.5", "external cli model ref");
    assertEqual(config.agents?.defaults?.agentRuntime?.id, "codex", "external cli runtime id");
    assertEqual(config.agents?.defaults?.agentRuntime?.fallback, "none", "external cli runtime fallback");
    if (config.models?.providers?.openai?.apiKey !== undefined) {
      throw new Error("external CLI config must not write env apiKey config");
    }
    return {
      id: "external-cli-openclaw-config",
      status: "PASS",
      command,
      durationMs: result.durationMs
    };
  } catch (error) {
    return {
      id: "external-cli-openclaw-config",
      status: "FAIL",
      command,
      durationMs: result.durationMs,
      message: error.message
    };
  }
}

async function externalCliRunAuthVerificationCheck(tmp) {
  const home = join(tmp, "stale-external-cli-home");
  const kovaHome = join(tmp, "stale-external-cli-kova-home");
  const credentials = join(kovaHome, "credentials");
  await mkdir(credentials, { recursive: true });
  await writeFile(join(credentials, "providers.json"), `${JSON.stringify({
    schemaVersion: "kova.credentials.providers.v1",
    defaultProvider: "openai",
    providers: {
      openai: {
        id: "openai",
        method: "external-cli",
        envVars: [],
        externalCli: "codex",
        fallbackPolicy: "mock",
        configuredAt: new Date().toISOString()
      }
    }
  }, null, 2)}\n`, "utf8");
  await writeFile(join(credentials, "live.env"), "", { encoding: "utf8", mode: 0o600 });
  const command = [
    `HOME=${quoteShell(home)}`,
    `KOVA_HOME=${quoteShell(kovaHome)}`,
    "node bin/kova.mjs run --target runtime:stable --scenario fresh-install --auth live --json"
  ].join(" ");
  const result = await runCommand(command, { timeoutMs: 30000, maxOutputChars: 1000000 });
  const output = `${result.stdout}\n${result.stderr}`;
  return {
    id: "run-external-cli-revalidates-auth",
    status: result.status !== 0 && output.includes("external-cli codex is not usable") ? "PASS" : "FAIL",
    command,
    durationMs: result.durationMs,
    message: result.status !== 0 && output.includes("external-cli codex is not usable")
      ? ""
      : `expected stale external CLI failure, got status ${result.status}: ${output.trim()}`
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
    assertEqual(report.summary?.statuses?.["DRY-RUN"], 2, "report dry-run count");
    assertEqual(report.performance?.repeat, 2, "report repeat count");
    assertEqual(report.performance?.groupCount, 1, "report performance group count");
    assertArrayNotEmpty(report.records, "report records");
    const dirs = report.records[0]?.collectorArtifactDirs;
    assertEqual(dirs?.schemaVersion, "kova.collectorArtifactDirs.v1", "collector artifact dirs schema");
    assertString(dirs?.resourceSamples, "collector resource samples dir");
    assertString(dirs?.openclaw, "collector OpenClaw dir");
    assertString(dirs?.nodeProfiles, "collector node profiles dir");
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
