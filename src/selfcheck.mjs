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
import {
  buildAgentTurnBreakdown,
  summarizeAgentTurnBreakdownForMarkdown
} from "./collectors/agent-turns.mjs";
import {
  computeProviderTurnAttribution,
  parseProviderRequestLog,
  parseTimelineProviderRequestLog
} from "./collectors/provider.mjs";
import { captureProcessSnapshot, diffProcessSnapshots } from "./collectors/resources.mjs";
import { renderMarkdownReport, renderPasteSummary, renderReportSummary } from "./report.mjs";

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
    checks.push(await anthropicApiKeyOpenClawConfigCheck(tmp));
    checks.push(await claudeCliOpenClawConfigCheck(tmp));
    checks.push(await liveApiKeyExecutionCheck(tmp));
    checks.push(await liveExternalCliDryRunCheck(tmp));
    checks.push(await liveExternalCliFallbackCheck(tmp));
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
    checks.push(await processSnapshotCheck(tmp));
    checks.push(roleThresholdEvaluationCheck());
    checks.push(stateRegistryValidationCheck());
    checks.push(scenarioStateCompatibilityCheck());
    checks.push(await cpuProfileParserCheck());
    checks.push(await heapProfileParserCheck());
    checks.push(await providerEvidenceParserCheck());
    checks.push(agentTurnBreakdownCheck());
    checks.push(await mockProviderBehaviorCheck(tmp));
    checks.push(providerFailureEvaluationCheck());
    checks.push(agentColdWarmEvaluationCheck());
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
    checks.push(gatePartialPassCheck());
    checks.push(gateSubsystemSummaryCheck());
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

function gatePartialPassCheck() {
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
          status: "PASS",
          title: "Release Runtime Startup",
          likelyOwner: "OpenClaw",
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

    assertEqual(gate.verdict, "PARTIAL", "partial gate pass verdict");
    assertEqual(gate.ok, false, "partial gate not ok");
    assertEqual(gate.complete, false, "partial gate completeness");
    assertEqual(gate.partial, true, "partial gate marker");
    return {
      id: "gate-partial-pass",
      status: "PASS",
      command: "evaluate synthetic partial release gate pass",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "gate-partial-pass",
      status: "FAIL",
      command: "evaluate synthetic partial release gate pass",
      durationMs: 0,
      message: error.message
    };
  }
}

function gateSubsystemSummaryCheck() {
  try {
    const gate = evaluateGate({
      mode: "execution",
      controls: {
        include: [],
        exclude: []
      },
      records: [
        {
          scenario: "gateway-performance",
          state: { id: "many-bundled-plugins" },
          status: "FAIL",
          title: "Gateway Performance",
          likelyOwner: "gateway-runtime",
          violations: [{ message: "gateway RSS 1200 MB exceeded threshold 900 MB" }],
          phases: []
        },
        {
          scenario: "agent-provider-timeout",
          state: { id: "mock-openai-provider" },
          status: "FAIL",
          title: "Agent Provider Timeout",
          likelyOwner: "agent-runtime/provider",
          violations: [{ message: "provider timeout was not contained" }],
          phases: []
        }
      ]
    }, {
      id: "release",
      gate: {
        id: "test-release-gate",
        blocking: [
          { scenario: "gateway-performance", state: "many-bundled-plugins" },
          { scenario: "agent-provider-timeout", state: "mock-openai-provider" }
        ]
      }
    });

    assertEqual(gate.verdict, "DO_NOT_SHIP", "subsystem gate verdict");
    assertEqual(gate.subsystems?.length, 2, "subsystem count");
    assertEqual(gate.fixerSummaries?.length, 2, "fixer summary count");
    assertEqual(gate.fixerSummaries[0]?.fixerPrompt.includes("Use the JSON report card measurements"), true, "fixer prompt evidence guidance");
    return {
      id: "gate-subsystem-summary",
      status: "PASS",
      command: "evaluate synthetic gate subsystem summaries",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "gate-subsystem-summary",
      status: "FAIL",
      command: "evaluate synthetic gate subsystem summaries",
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
    assertEqual(gate.baseline?.regressionCount, comparison.regressionCount, "gate baseline regression count");
    assertEqual(gate.baseline?.regressedGroups?.[0]?.scenario, "fresh-install", "gate baseline group scenario");
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

async function providerEvidenceParserCheck() {
  try {
    const text = await readFile("fixtures/provider/mock-requests.jsonl", "utf8");
    const evidence = parseProviderRequestLog(text);
    assertEqual(evidence.requestCount, 2, "provider request count");
    assertEqual(evidence.providerDurationMs, 6700, "provider duration includes first through last response");
    assertEqual(evidence.firstByteLatencyMs, 15, "first byte latency");
    const timelineEvidence = parseTimelineProviderRequestLog([
      JSON.stringify({
        schemaVersion: "openclaw.diagnostics.v1",
        type: "provider.request",
        timestamp: "2026-04-30T10:00:01.250Z",
        name: "provider.request",
        provider: "openai",
        operation: "responses.create",
        model: "gpt-5.5",
        durationMs: 350,
        ok: true
      })
    ].join("\n"));
    assertEqual(timelineEvidence.requestCount, 1, "timeline provider request count");
    assertEqual(timelineEvidence.providerDurationMs, 350, "timeline provider duration");
    assertEqual(timelineEvidence.requests[0]?.route, "responses.create", "timeline provider route");
    const attribution = computeProviderTurnAttribution({
      command: "ocm @kova -- agent --local --agent main --session-id kova --message hi --json",
      startedAt: "2026-04-30T10:00:01.000Z",
      startedAtEpochMs: 1777543201000,
      finishedAt: "2026-04-30T10:00:07.000Z",
      finishedAtEpochMs: 1777543207000
    }, {
      ...evidence,
      available: true
    });
    assertEqual(attribution.preProviderMs, 5000, "pre-provider latency");
    assertEqual(attribution.providerFinalMs, 800, "provider final latency");
    assertEqual(attribution.postProviderMs, 200, "post-provider latency");
    assertEqual(evidence.usage?.available, true, "provider usage availability");
    assertEqual(evidence.usage?.totalTokens, 12, "provider usage total tokens");
    return {
      id: "provider-evidence-parser",
      status: "PASS",
      command: "parse fixtures/provider/mock-requests.jsonl",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "provider-evidence-parser",
      status: "FAIL",
      command: "parse fixtures/provider/mock-requests.jsonl",
      durationMs: 0,
      message: error.message
    };
  }
}

async function liveApiKeyExecutionCheck(tmp) {
  const home = join(tmp, "live-api-key-home");
  const reportDir = join(tmp, "live-api-key-report");
  const openclawHome = join(tmp, "live-api-key-openclaw-home");
  const binDir = join(tmp, "live-api-key-bin");
  const ocmLog = join(tmp, "live-api-key-ocm.log");
  const secret = "kova-live-secret-selfcheck";
  await mkdir(join(home, "credentials"), { recursive: true });
  await mkdir(binDir, { recursive: true });
  await writeFile(join(home, "credentials", "providers.json"), `${JSON.stringify({
    schemaVersion: "kova.credentials.providers.v1",
    defaultProvider: "openai",
    providers: {
      openai: {
        id: "openai",
        method: "api-key",
        envVars: ["OPENAI_API_KEY"],
        externalCli: null,
        fallbackPolicy: "mock",
        configuredAt: new Date().toISOString()
      }
    }
  }, null, 2)}\n`, "utf8");
  await writeFile(join(home, "credentials", "live.env"), `OPENAI_API_KEY=${secret}\n`, { encoding: "utf8", mode: 0o600 });
  await writeFile(join(binDir, "ocm"), fakeOcmScript(), "utf8");
  await chmod(join(binDir, "ocm"), 0o755);

  const command = [
    `KOVA_HOME=${quoteShell(home)}`,
    `PATH=${quoteShell(`${binDir}:${process.env.PATH}`)}`,
    `KOVA_FAKE_OPENCLAW_HOME=${quoteShell(openclawHome)}`,
    `KOVA_MOCK_OCM_LOG=${quoteShell(ocmLog)}`,
    `node bin/kova.mjs run --target runtime:stable --scenario fresh-install --auth live --execute --report-dir ${quoteShell(reportDir)} --json`
  ].join(" ");
  const result = await runCommand(command, { timeoutMs: 30000, maxOutputChars: 1000000, redactValues: [secret] });

  try {
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`);
    }
    const receipt = JSON.parse(result.stdout);
    const reportText = await readFile(receipt.jsonPath, "utf8");
    if (reportText.includes(secret)) {
      throw new Error("live API key leaked into JSON report");
    }
    const report = JSON.parse(reportText);
    const record = report.records?.[0];
    assertEqual(report.auth?.requestedMode, "live", "report requested live auth");
    assertEqual(report.auth?.live?.environmentDependent, true, "top-level live env-dependent flag");
    assertEqual(record?.auth?.mode, "live", "record live auth mode");
    assertEqual(record?.auth?.source, "api-key", "record live auth source");
    assertEqual(record?.auth?.environmentDependent, true, "record live env-dependent flag");
    assertEqual(record?.auth?.secretValues, "redacted", "record secret values redacted");
    assertEqual(record?.providerEvidence?.environmentDependent, true, "provider evidence live env-dependent flag");
    const config = JSON.parse(await readFile(join(openclawHome, ".openclaw", "openclaw.json"), "utf8"));
    assertEqual(config.models?.providers?.openai?.apiKey?.id, "OPENAI_API_KEY", "OpenClaw live config env ref");
    const serializedConfig = JSON.stringify(config);
    if (serializedConfig.includes(secret)) {
      throw new Error("live API key leaked into OpenClaw config");
    }
    const statusResult = record.phases
      ?.flatMap((phase) => phase.results ?? [])
      ?.find((item) => item.command.includes(" -- status"));
    if (!statusResult || statusResult.stdout.includes(secret) || !statusResult.stdout.includes("[REDACTED]")) {
      throw new Error("live command env was not redacted in command output");
    }
    return {
      id: "live-api-key-execution",
      status: "PASS",
      command,
      durationMs: result.durationMs
    };
  } catch (error) {
    return {
      id: "live-api-key-execution",
      status: "FAIL",
      command,
      durationMs: result.durationMs,
      message: error.message
    };
  }
}

async function liveExternalCliDryRunCheck(tmp) {
  const home = join(tmp, "live-external-cli-home");
  const kovaHome = join(tmp, "live-external-cli-kova-home");
  const fakeBin = join(tmp, "live-external-cli-bin");
  const reportDir = join(tmp, "live-external-cli-report");
  await mkdir(join(home, ".codex"), { recursive: true });
  await mkdir(join(kovaHome, "credentials"), { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await writeFile(join(home, ".codex", "auth.json"), "{\"tokens\":{\"access_token\":\"redacted\"}}\n", "utf8");
  await writeFile(join(fakeBin, "codex"), "#!/bin/sh\necho codex-selfcheck\n", "utf8");
  await chmod(join(fakeBin, "codex"), 0o755);
  await writeFile(join(kovaHome, "credentials", "providers.json"), `${JSON.stringify({
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
  await writeFile(join(kovaHome, "credentials", "live.env"), "", { encoding: "utf8", mode: 0o600 });

  const command = [
    `HOME=${quoteShell(home)}`,
    `PATH=${quoteShell(`${fakeBin}:${process.env.PATH}`)}`,
    `KOVA_HOME=${quoteShell(kovaHome)}`,
    `node bin/kova.mjs run --target runtime:stable --scenario fresh-install --auth live --report-dir ${quoteShell(reportDir)} --json`
  ].join(" ");
  const result = await runCommand(command, { timeoutMs: 30000, maxOutputChars: 1000000 });

  try {
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`);
    }
    const receipt = JSON.parse(result.stdout);
    const report = JSON.parse(await readFile(receipt.jsonPath, "utf8"));
    const record = report.records?.[0];
    assertEqual(report.auth?.requestedMode, "live", "external cli requested live auth");
    assertEqual(report.auth?.live?.method, "external-cli", "external cli live method");
    assertEqual(report.auth?.live?.verification?.verified, true, "external cli verification");
    assertEqual(record?.auth?.mode, "live", "external cli record live mode");
    assertEqual(record?.auth?.source, "external-cli", "external cli record source");
    assertEqual(record?.auth?.externalCli, "codex", "external cli record name");
    const authSetupCommand = record.phases
      ?.flatMap((phase) => phase.commands ?? [])
      ?.find((item) => item.includes("configure-openclaw-live-auth.mjs")) ?? "";
    if (!authSetupCommand.includes("--auth-method external-cli") || !/--external-cli\s+'?codex'?/.test(authSetupCommand)) {
      throw new Error(`external-cli auth setup command missing expected args: ${authSetupCommand}`);
    }
    return {
      id: "live-external-cli-dry-run",
      status: "PASS",
      command,
      durationMs: result.durationMs
    };
  } catch (error) {
    return {
      id: "live-external-cli-dry-run",
      status: "FAIL",
      command,
      durationMs: result.durationMs,
      message: error.message
    };
  }
}

async function liveExternalCliFallbackCheck(tmp) {
  const home = join(tmp, "live-external-cli-fallback-home");
  const kovaHome = join(tmp, "live-external-cli-fallback-kova-home");
  const fakeBin = join(tmp, "live-external-cli-fallback-bin");
  const reportDir = join(tmp, "live-external-cli-fallback-report");
  await mkdir(join(home, ".codex"), { recursive: true });
  await mkdir(join(kovaHome, "credentials"), { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await writeFile(join(home, ".codex", "auth.json"), "{\"tokens\":{\"access_token\":\"redacted\"}}\n", "utf8");
  await writeFile(join(fakeBin, "codex"), "#!/bin/sh\necho codex-selfcheck\n", "utf8");
  await chmod(join(fakeBin, "codex"), 0o755);
  await writeFile(join(kovaHome, "credentials", "providers.json"), `${JSON.stringify({
    schemaVersion: "kova.credentials.providers.v1",
    defaultProvider: "openai",
    providers: {
      openai: {
        id: "openai",
        method: "env-only",
        envVars: ["OPENAI_API_KEY"],
        externalCli: null,
        fallbackPolicy: "external-cli",
        configuredAt: new Date().toISOString()
      }
    }
  }, null, 2)}\n`, "utf8");
  await writeFile(join(kovaHome, "credentials", "live.env"), "", { encoding: "utf8", mode: 0o600 });

  const command = [
    `HOME=${quoteShell(home)}`,
    `PATH=${quoteShell(`${fakeBin}:${process.env.PATH}`)}`,
    `KOVA_HOME=${quoteShell(kovaHome)}`,
    `node bin/kova.mjs run --target runtime:stable --scenario fresh-install --auth live --report-dir ${quoteShell(reportDir)} --json`
  ].join(" ");
  const result = await runCommand(command, { timeoutMs: 30000, maxOutputChars: 1000000 });

  try {
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`);
    }
    const receipt = JSON.parse(result.stdout);
    const report = JSON.parse(await readFile(receipt.jsonPath, "utf8"));
    const record = report.records?.[0];
    assertEqual(report.auth?.live?.method, "external-cli", "fallback live method");
    assertEqual(report.auth?.live?.fallbackFrom, "env-only", "fallback source method");
    assertEqual(report.auth?.live?.fallbackPolicy, "external-cli", "fallback policy");
    assertEqual(record?.auth?.source, "external-cli", "record fallback source");
    assertEqual(record?.auth?.fallbackFrom, "env-only", "record fallback from");
    assertEqual(record?.auth?.externalCli, "codex", "record fallback CLI");
    return {
      id: "live-external-cli-fallback",
      status: "PASS",
      command,
      durationMs: result.durationMs
    };
  } catch (error) {
    return {
      id: "live-external-cli-fallback",
      status: "FAIL",
      command,
      durationMs: result.durationMs,
      message: error.message
    };
  }
}

function fakeOcmScript() {
  return `#!/bin/sh
printf '%s\\n' "$*" >> "$KOVA_MOCK_OCM_LOG"
case "$1:$2" in
  service:status) echo '{"running":false,"desiredRunning":false,"childPid":null,"gatewayPort":null,"gatewayState":"stopped"}'; exit 0 ;;
  env:exec)
    env_name="$3"
    shift 4
    OPENCLAW_HOME="$KOVA_FAKE_OPENCLAW_HOME" "$@"
    exit $?
    ;;
  env:destroy) echo '{"destroyed":true}'; exit 0 ;;
esac
case "$1" in
  start) echo '{"ok":true}'; exit 0 ;;
  logs) exit 0 ;;
  @*) echo "live command key=$OPENAI_API_KEY"; exit 0 ;;
  --version) echo 'mock-ocm'; exit 0 ;;
esac
echo "unhandled mock ocm command: $*" >&2
exit 2
`;
}

function agentTurnBreakdownCheck() {
  try {
    const normal = syntheticTurn({
      startedAtEpochMs: 1000,
      firstProviderRequestAtEpochMs: 1200,
      firstByteLatencyMs: 15,
      firstChunkLatencyMs: 18,
      lastProviderResponseAtEpochMs: 1600,
      finishedAtEpochMs: 2000,
      timelineSummary: {
        available: true,
        spanTotals: {
          "agent.prepare": { count: 1, totalDurationMs: 90, maxDurationMs: 90 },
          "models.catalog.gateway": { count: 1, totalDurationMs: 70, maxDurationMs: 70 },
          "channel.plugin.load": { count: 1, totalDurationMs: 25, maxDurationMs: 25 }
        },
        keySpans: {}
      }
    });
    assertEqual(normal.breakdown.buckets.preProviderOpenClawMs, 200, "normal pre-provider bucket");
    assertEqual(normal.breakdown.buckets.providerMs, 400, "normal provider bucket");
    assertEqual(normal.breakdown.buckets.postProviderMs, 400, "normal post-provider bucket");
    assertEqual(normal.breakdown.buckets.unknownMs, 15, "normal unattributed pre-provider bucket");
    assertEqual(normal.breakdown.provider.firstByteLatencyMs, 15, "normal first byte latency");
    assertEqual(normal.breakdown.sourceSpans.categories.modelCatalog.totalDurationMs, 70, "model catalog source span");

    const preProviderStall = syntheticTurn({
      startedAtEpochMs: 1000,
      firstProviderRequestAtEpochMs: 62000,
      lastProviderResponseAtEpochMs: 62800,
      finishedAtEpochMs: 63000,
      timelineSummary: null
    });
    assertEqual(preProviderStall.breakdown.evidenceQuality, "outside-in-only", "pre-provider missing timeline quality");
    assertEqual(preProviderStall.breakdown.buckets.preProviderOpenClawMs, 61000, "pre-provider stall bucket");
    assertEqual(preProviderStall.breakdown.buckets.unknownMs, 61000, "pre-provider stall unknown");

    const providerStall = syntheticTurn({
      startedAtEpochMs: 1000,
      firstProviderRequestAtEpochMs: 1500,
      lastProviderResponseAtEpochMs: 21500,
      finishedAtEpochMs: 22000,
      timelineSummary: null
    });
    assertEqual(providerStall.breakdown.buckets.providerMs, 20000, "provider stall bucket");
    assertEqual(providerStall.breakdown.buckets.unknownMs, 500, "provider stall unknown pre-provider");

    const cleanupStall = syntheticTurn({
      startedAtEpochMs: 1000,
      firstProviderRequestAtEpochMs: 1500,
      lastProviderResponseAtEpochMs: 1800,
      finishedAtEpochMs: 77000,
      timelineSummary: {
        available: true,
        spanTotals: {
          "agent.cleanup": { count: 1, totalDurationMs: 74000, maxDurationMs: 74000 }
        },
        keySpans: {}
      }
    });
    assertEqual(cleanupStall.breakdown.buckets.cleanupMs, 74000, "cleanup stall bucket");
    assertEqual(cleanupStall.breakdown.sourceSpans.categories.agentCleanup.totalDurationMs, 74000, "cleanup source span");

    const missingTimeline = syntheticTurn({
      startedAtEpochMs: 1000,
      firstProviderRequestAtEpochMs: 1500,
      lastProviderResponseAtEpochMs: 1800,
      finishedAtEpochMs: 1900,
      timelineSummary: { available: false, spanTotals: {}, keySpans: {} }
    });
    assertEqual(missingTimeline.breakdown.evidenceQuality, "outside-in-only", "missing timeline fallback quality");
    assertEqual(missingTimeline.breakdown.buckets.unknownMs, 500, "missing timeline unknown");

    const record = {
      scenario: "agent-cold-warm-message",
      title: "Agent cold/warm message",
      status: "PASS",
      cleanup: "done",
      phases: [{
        id: "cold-agent-turn",
        title: "Cold agent turn",
        intent: "Synthetic self-check",
        commands: [normal.result.command],
        evidence: [],
        results: [{
          ...normal.result,
          status: 0,
          timedOut: false,
          stdout: "{\"finalAssistantVisibleText\":\"KOVA_AGENT_OK\"}",
          stderr: ""
        }],
        metrics: {
          logs: zeroLogMetrics(),
          health: { ok: true },
          timeline: {
            available: true,
            eventCount: 3,
            parseErrorCount: 0,
            spanTotals: {
              "agent.prepare": { count: 1, totalDurationMs: 90, maxDurationMs: 90 },
              "models.catalog.gateway": { count: 1, totalDurationMs: 70, maxDurationMs: 70 }
            },
            keySpans: {}
          }
        }
      }],
      providerEvidence: {
        available: true,
        requestCount: 1,
        requests: [normal.request]
      },
      finalMetrics: {
        service: { gatewayState: "running" },
        logs: zeroLogMetrics()
      }
    };
    evaluateRecord(record, {
      id: "agent-cold-warm-message",
      agent: { expectedText: "KOVA_AGENT_OK" },
      thresholds: {}
    }, { surface: { thresholds: {} }, targetPlan: { kind: "local-build" } });
    const rendered = renderMarkdownReport({
      generatedAt: "2026-05-01T00:00:00.000Z",
      runId: "self-check-agent-turn-breakdown",
      mode: "self-check",
      target: "runtime:stable",
      platform: { os: "test", release: "test", arch: "test", node: "test" },
      records: [record],
      summary: { statuses: { PASS: 1 } }
    });
    assertEqual(rendered.includes("breakdown:"), true, "markdown includes agent turn breakdown");
    assertEqual(rendered.includes("models.catalog.* 70ms"), true, "markdown includes source span evidence");
    assertEqual(
      summarizeAgentTurnBreakdownForMarkdown(normal.breakdown).includes("unknown 15ms"),
      true,
      "breakdown markdown helper includes unknown bucket"
    );

    return {
      id: "agent-turn-breakdown",
      status: "PASS",
      command: "evaluate synthetic agent turn phase breakdowns",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "agent-turn-breakdown",
      status: "FAIL",
      command: "evaluate synthetic agent turn phase breakdowns",
      durationMs: 0,
      message: error.message
    };
  }
}

function syntheticTurn({
  startedAtEpochMs,
  firstProviderRequestAtEpochMs,
  firstByteLatencyMs = null,
  firstChunkLatencyMs = null,
  lastProviderResponseAtEpochMs,
  finishedAtEpochMs,
  timelineSummary
}) {
  const result = {
    command: "ocm @kova -- agent --local --agent main --session-id kova --message hi --json",
    startedAt: new Date(startedAtEpochMs).toISOString(),
    startedAtEpochMs,
    finishedAt: new Date(finishedAtEpochMs).toISOString(),
    finishedAtEpochMs,
    durationMs: finishedAtEpochMs - startedAtEpochMs,
    processSnapshots: {
      before: { capturedAt: new Date(startedAtEpochMs - 10).toISOString(), processCount: 2 },
      after: { capturedAt: new Date(finishedAtEpochMs + 10).toISOString(), processCount: 2 },
      leaks: { leakCount: 0, leaksByRole: {}, leakedProcesses: [] }
    }
  };
  const request = {
    requestId: "self-check-provider",
    receivedAt: new Date(firstProviderRequestAtEpochMs).toISOString(),
    receivedAtEpochMs: firstProviderRequestAtEpochMs,
    firstByteLatencyMs,
    firstChunkLatencyMs,
    respondedAt: new Date(lastProviderResponseAtEpochMs).toISOString(),
    respondedAtEpochMs: lastProviderResponseAtEpochMs,
    route: "/v1/responses",
    model: "gpt-5.5",
    stream: true,
    status: 200,
    statusClass: "2xx"
  };
  const attribution = computeProviderTurnAttribution(result, {
    available: true,
    requests: [request]
  });
  return {
    result,
    request,
    attribution,
    breakdown: buildAgentTurnBreakdown({ result, attribution, timelineSummary })
  };
}

async function mockProviderBehaviorCheck(tmp) {
  const dir = join(tmp, "mock-provider-behavior");
  await mkdir(dir, { recursive: true });
  const command = [
    `node support/mock-openai-server.mjs --port-file ${quoteShell(join(dir, "port"))} --request-log ${quoteShell(join(dir, "requests.jsonl"))} --mode error-then-recover --error-status 503 >${quoteShell(join(dir, "server.log"))} 2>&1 & echo $! >${quoteShell(join(dir, "pid"))}`,
    `for i in $(seq 1 50); do test -s ${quoteShell(join(dir, "port"))} && break; sleep 0.1; done`,
    `port=$(cat ${quoteShell(join(dir, "port"))})`,
    "node -e 'const port=process.argv[1]; const body=JSON.stringify({model:\"gpt-5.5\",stream:false}); const send=()=>fetch(`http://127.0.0.1:${port}/v1/responses`,{method:\"POST\",headers:{\"content-type\":\"application/json\"},body}).then(async r=>({status:r.status,text:await r.text()})); const first=await send(); const second=await send(); console.log(JSON.stringify({first:first.status,second:second.status}));' \"$port\"",
    `kill "$(cat ${quoteShell(join(dir, "pid"))})" 2>/dev/null || true`
  ].join("; ");
  const result = await runCommand(command, { timeoutMs: 10000 });
  try {
    if (result.status !== 0) {
      throw new Error(`mock provider behavior command failed: ${result.stderr || result.stdout}`);
    }
    const response = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
    assertEqual(response.first, 503, "first transient provider status");
    assertEqual(response.second, 200, "second recovered provider status");
    const evidence = parseProviderRequestLog(await readFile(join(dir, "requests.jsonl"), "utf8"));
    assertEqual(evidence.requestCount, 2, "behavior request count");
    assertEqual(evidence.requests[0]?.mode, "error-then-recover", "first request behavior");
    assertEqual(evidence.requests[0]?.errorClass, "provider-error", "first request error class");
    assertEqual(evidence.requests[1]?.mode, "normal", "second request behavior");
    return {
      id: "mock-provider-behavior",
      status: "PASS",
      command,
      durationMs: result.durationMs
    };
  } catch (error) {
    return {
      id: "mock-provider-behavior",
      status: "FAIL",
      command,
      durationMs: result.durationMs,
      message: error.message
    };
  }
}

function providerFailureEvaluationCheck() {
  try {
    const recoverCommand = "ocm @kova -- agent --local --agent main --session-id kova-agent-provider-recovery --message hi --json";
    const record = {
      scenario: "agent-provider-recovery",
      status: "PASS",
      auth: { mode: "mock", source: "mock", providerId: "openai" },
      phases: [
        {
          id: "transient-provider-failure-turn",
          results: [{
            command: recoverCommand,
            status: 0,
            timedOut: false,
            startedAt: "2026-04-30T10:00:01.000Z",
            startedAtEpochMs: 1777543201000,
            finishedAt: "2026-04-30T10:00:02.000Z",
            finishedAtEpochMs: 1777543202000,
            durationMs: 1000,
            stdout: "{\"finalAssistantVisibleText\":\"KOVA_AGENT_OK\"}",
            stderr: "",
            processSnapshots: {
              leaks: {
                schemaVersion: "kova.processLeakSummary.v1",
                leakCount: 0,
                leakedProcesses: [],
                leaksByRole: {}
              }
            }
          }],
          metrics: { logs: zeroLogMetrics(), health: { ok: true } }
        }
      ],
      providerEvidence: {
        available: true,
        requestCount: 2,
        requests: [
          {
            requestId: "provider-error",
            mode: "error-then-recover",
            outcome: "completed",
            errorClass: "provider-error",
            receivedAt: "2026-04-30T10:00:01.500Z",
            receivedAtEpochMs: 1777543201500,
            respondedAt: "2026-04-30T10:00:01.520Z",
            respondedAtEpochMs: 1777543201520,
            firstByteLatencyMs: 10,
            firstChunkLatencyMs: 10,
            route: "/v1/responses",
            model: "gpt-5.5",
            stream: true,
            status: 503,
            statusClass: "5xx"
          },
          {
            requestId: "provider-recover",
            mode: "normal",
            outcome: "completed",
            errorClass: null,
            receivedAt: "2026-04-30T10:00:01.600Z",
            receivedAtEpochMs: 1777543201600,
            respondedAt: "2026-04-30T10:00:01.700Z",
            respondedAtEpochMs: 1777543201700,
            firstByteLatencyMs: 20,
            firstChunkLatencyMs: 20,
            route: "/v1/responses",
            model: "gpt-5.5",
            stream: true,
            status: 200,
            statusClass: "2xx"
          }
        ]
      },
      finalMetrics: {
        service: { gatewayState: "running" },
        logs: zeroLogMetrics()
      }
    };

    evaluateRecord(record, {
      id: "agent-provider-recovery",
      mockProvider: { mode: "error-then-recover" },
      agent: { expectedText: "KOVA_AGENT_OK" },
      thresholds: {
        providerFinalMs: 10000,
        providerFailureHealthFailures: 0
      }
    }, { surface: { thresholds: {} }, targetPlan: { kind: "npm" } });

    assertEqual(record.status, "PASS", "provider recovery scenario status");
    assertEqual(record.measurements.agentProviderSimulation.mode, "error-then-recover", "provider simulation mode");
    assertEqual(record.measurements.agentProviderSimulation.recoveryOk, true, "provider recovery ok");
    assertEqual(record.measurements.agentProviderSimulation.containmentOk, true, "provider containment ok");
    assertEqual(record.measurements.agentFailureContainment.processLeaksOk, true, "agent process leaks ok");
    assertEqual(record.measurements.agentTurns[0].responseOk, true, "recovery response ok");
    assertEqual(record.measurements.agentLatencyDiagnosis.kind, "provider-error", "provider failure diagnosis");
    return {
      id: "provider-failure-evaluation",
      status: "PASS",
      command: "evaluate synthetic provider failure containment",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "provider-failure-evaluation",
      status: "FAIL",
      command: "evaluate synthetic provider failure containment",
      durationMs: 0,
      message: error.message
    };
  }
}

function agentColdWarmEvaluationCheck() {
  try {
    const coldCommand = "ocm @kova -- agent --local --agent main --session-id kova-agent-cold-warm --message hi --json";
    const warmCommand = "ocm @kova -- agent --local --agent main --session-id kova-agent-cold-warm --message hi --json";
    const record = {
      scenario: "agent-cold-warm-message",
      status: "PASS",
      auth: { mode: "mock", source: "mock", providerId: "openai" },
      phases: [
        {
          id: "cold-agent-turn",
          results: [{
            command: coldCommand,
            status: 0,
            timedOut: false,
            startedAt: "2026-04-30T10:00:01.000Z",
            startedAtEpochMs: 1777543201000,
            finishedAt: "2026-04-30T10:01:03.000Z",
            finishedAtEpochMs: 1777543263000,
            durationMs: 62000,
            stdout: "{\"finalAssistantVisibleText\":\"KOVA_AGENT_OK\"}",
            stderr: ""
          }],
          metrics: { logs: zeroLogMetrics(), health: { ok: true } }
        },
        {
          id: "warm-agent-turn",
          results: [{
            command: warmCommand,
            status: 0,
            timedOut: false,
            startedAt: "2026-04-30T10:01:10.000Z",
            startedAtEpochMs: 1777543270000,
            finishedAt: "2026-04-30T10:01:12.000Z",
            finishedAtEpochMs: 1777543272000,
            durationMs: 2000,
            stdout: "{\"finalAssistantVisibleText\":\"KOVA_AGENT_OK\"}",
            stderr: ""
          }],
          metrics: { logs: zeroLogMetrics(), health: { ok: true } }
        }
      ],
      providerEvidence: {
        available: true,
        requestCount: 2,
        requests: [
          {
            requestId: "cold-provider",
            receivedAt: "2026-04-30T10:01:02.000Z",
            receivedAtEpochMs: 1777543262000,
            respondedAt: "2026-04-30T10:01:02.800Z",
            respondedAtEpochMs: 1777543262800,
            firstByteLatencyMs: 50,
            firstChunkLatencyMs: 50,
            route: "/v1/responses",
            model: "gpt-5.5",
            stream: true,
            status: 200,
            statusClass: "2xx"
          },
          {
            requestId: "warm-provider",
            receivedAt: "2026-04-30T10:01:10.500Z",
            receivedAtEpochMs: 1777543270500,
            respondedAt: "2026-04-30T10:01:11.300Z",
            respondedAtEpochMs: 1777543271300,
            firstByteLatencyMs: 40,
            firstChunkLatencyMs: 40,
            route: "/v1/responses",
            model: "gpt-5.5",
            stream: true,
            status: 200,
            statusClass: "2xx"
          }
        ]
      },
      finalMetrics: {
        service: { gatewayState: "running" },
        logs: zeroLogMetrics()
      }
    };

    evaluateRecord(record, {
      id: "agent-cold-warm-message",
      agent: { expectedText: "KOVA_AGENT_OK" },
      thresholds: {
        preProviderMs: 10000,
        coldWarmDeltaMs: 30000,
        providerFinalMs: 3000,
        preProviderDominanceRatio: 0.8
      }
    }, { surface: { thresholds: {} }, targetPlan: { kind: "npm" } });

    assertEqual(record.status, "FAIL", "cold pre-provider stall should fail");
    assertEqual(record.measurements.agentTurnCount, 2, "agent turn count");
    assertEqual(record.measurements.coldAgentTurnMs, 62000, "cold turn duration");
    assertEqual(record.measurements.warmAgentTurnMs, 2000, "warm turn duration");
    assertEqual(record.measurements.agentColdWarmDeltaMs, 60000, "cold warm delta");
    assertEqual(record.measurements.coldPreProviderMs, 61000, "cold pre-provider latency");
    assertEqual(record.measurements.warmPreProviderMs, 500, "warm pre-provider latency");
    assertEqual(record.measurements.coldProviderFinalMs, 800, "cold provider final");
    assertEqual(record.measurements.agentLatencyDiagnosis.kind, "cold-pre-provider-stall", "latency diagnosis kind");
    assertEqual(record.measurements.agentTurns[0].responseOk, true, "cold response ok");
    assertEqual(record.measurements.agentTurns[1].providerRoutes[0].value, "/v1/responses", "warm provider route evidence");
    assertEqual(
      renderPasteSummary({
        runId: "self-check-cold-warm",
        target: "runtime:stable",
        mode: "self-check",
        platform: { os: "test", release: "test", arch: "test" },
        records: [record]
      }).includes("cold-warm delta 60000ms"),
      true,
      "paste summary includes cold/warm evidence"
    );

    return {
      id: "agent-cold-warm-evaluation",
      status: "PASS",
      command: "evaluate synthetic cold/warm agent provider attribution",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "agent-cold-warm-evaluation",
      status: "FAIL",
      command: "evaluate synthetic cold/warm agent provider attribution",
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

async function processSnapshotCheck(tmp) {
  const child = runCommand("node -e 'setTimeout(() => {}, 1200)'", {
    timeoutMs: 5000,
    resourceSample: null
  });
  await sleep(250);
  const before = captureProcessSnapshot({
    processRoles: await loadProcessRoles(),
    rootCommand: "ocm @kova -- agent --local --message hi"
  });
  const result = await child;
  const after = captureProcessSnapshot({
    processRoles: await loadProcessRoles(),
    rootCommand: "ocm @kova -- agent --local --message hi"
  });
  const leaks = diffProcessSnapshots(before, after, {
    roles: ["agent-cli", "agent-process", "mcp-runtime", "plugin-cli", "mock-provider", "browser-sidecar"]
  });
  const artifactPath = join(tmp, "process-snapshot-leaks.json");
  await writeFile(artifactPath, `${JSON.stringify(leaks, null, 2)}\n`, "utf8");

  try {
    assertEqual(result.status, 0, "snapshot command status");
    assertEqual(before.schemaVersion, "kova.processSnapshot.v1", "snapshot schema");
    assertEqual(leaks.schemaVersion, "kova.processLeakSummary.v1", "leak summary schema");
    assertEqual(typeof leaks.leakCount, "number", "leak count type");
    return {
      id: "process-snapshot-leak-contract",
      status: "PASS",
      command: "capture and diff role-aware process snapshots",
      durationMs: result.durationMs
    };
  } catch (error) {
    return {
      id: "process-snapshot-leak-contract",
      status: "FAIL",
      command: "capture and diff role-aware process snapshots",
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

async function anthropicApiKeyOpenClawConfigCheck(tmp) {
  const home = join(tmp, "anthropic-api-key-config-home");
  const command = [
    `OPENCLAW_HOME=${quoteShell(home)}`,
    "node support/configure-openclaw-live-auth.mjs --provider anthropic --env-var ANTHROPIC_API_KEY"
  ].join(" ");
  const result = await runCommand(command, { timeoutMs: 30000, maxOutputChars: 1000000 });
  try {
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`);
    }
    const config = JSON.parse(await readFile(join(home, ".openclaw", "openclaw.json"), "utf8"));
    assertEqual(config.models?.providers?.anthropic?.apiKey?.id, "ANTHROPIC_API_KEY", "anthropic env ref");
    assertEqual(config.agents?.defaults?.model?.primary, "anthropic/claude-sonnet-4-5", "anthropic default model");
    return {
      id: "anthropic-api-key-openclaw-config",
      status: "PASS",
      command,
      durationMs: result.durationMs
    };
  } catch (error) {
    return {
      id: "anthropic-api-key-openclaw-config",
      status: "FAIL",
      command,
      durationMs: result.durationMs,
      message: error.message
    };
  }
}

async function claudeCliOpenClawConfigCheck(tmp) {
  const home = join(tmp, "claude-cli-config-home");
  const command = [
    `OPENCLAW_HOME=${quoteShell(home)}`,
    "node support/configure-openclaw-live-auth.mjs --provider anthropic --auth-method external-cli --external-cli claude"
  ].join(" ");
  const result = await runCommand(command, { timeoutMs: 30000, maxOutputChars: 1000000 });
  try {
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`);
    }
    const config = JSON.parse(await readFile(join(home, ".openclaw", "openclaw.json"), "utf8"));
    assertEqual(config.agents?.defaults?.model?.primary, "anthropic/claude-sonnet-4-5", "claude cli model ref");
    assertEqual(config.agents?.defaults?.agentRuntime?.id, "claude-cli", "claude cli runtime id");
    assertEqual(config.agents?.defaults?.agentRuntime?.fallback, "none", "claude cli runtime fallback");
    if (config.models?.providers?.anthropic?.apiKey !== undefined) {
      throw new Error("Claude CLI config must not write env apiKey config");
    }
    return {
      id: "claude-cli-openclaw-config",
      status: "PASS",
      command,
      durationMs: result.durationMs
    };
  } catch (error) {
    return {
      id: "claude-cli-openclaw-config",
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
