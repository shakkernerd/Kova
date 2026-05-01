import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { bundleReport, retainGateArtifacts } from "./artifacts.mjs";
import { authReportSummary, resolveRunAuthContext } from "./auth.mjs";
import { runCleanupCommand } from "./cleanup.mjs";
import { runCommand } from "./commands.mjs";
import { compareReports, renderCompareFixerSummary, renderCompareSummary } from "./compare.mjs";
import { parseFlags, printHelp, required, resolveFromCwd } from "./cli.mjs";
import { evaluateGate, preflightGateRun } from "./gate.mjs";
import { buildCoverage } from "./matrix/coverage.mjs";
import {
  comparePerformanceToBaseline,
  loadBaselineStore,
  resolveBaselinePath,
  reviewBaselineUpdate,
  saveBaselineStore,
  updateBaselineStore
} from "./performance/baselines.mjs";
import { buildPerformanceSummary } from "./performance/stats.mjs";
import { platformInfo } from "./platform.mjs";
import { artifactsDir, repoRoot, reportsDir } from "./paths.mjs";
import { loadProcessRoles } from "./registries/process-roles.mjs";
import { loadMetrics } from "./registries/metrics.mjs";
import { loadProfile, loadProfiles } from "./registries/profiles.mjs";
import { loadScenarios, validateScenarioRun } from "./registries/scenarios.mjs";
import { loadState, loadStates } from "./registries/states.mjs";
import { loadSurfaces } from "./registries/surfaces.mjs";
import { validateRegistryReferences } from "./registries/validate.mjs";
import { renderMarkdownReport, renderPasteSummary, renderReportSummary, summarizeRecords } from "./report.mjs";
import { buildDryRunRecord, buildSkippedRecord, createRunId, executeScenario } from "./runner.mjs";
import { runSelfCheck } from "./selfcheck.mjs";
import { runSetup } from "./setup.mjs";
import { resolveTarget } from "./targets.mjs";
import { ocmEnvDestroy, ocmEnvListJson, ocmRuntimeRemoveJson } from "./ocm/commands.mjs";

const reportSchemaVersion = "kova.report.v1";

export async function main(argv) {
  const [command = "help", ...rest] = argv;
  const flags = parseFlags(rest);

  if (command === "help" || flags.help) {
    printHelp();
    return;
  }

  if (command === "version" || command === "--version") {
    await versionCommand(flags);
    return;
  }

  if (command === "setup") {
    await runSetup(flags);
    return;
  }

  if (command === "self-check") {
    await runSelfCheck(flags);
    return;
  }

  if (command === "plan") {
    await plan(flags);
    return;
  }

  if (command === "matrix") {
    await matrixCommand(flags);
    return;
  }

  if (command === "run") {
    await run(flags);
    return;
  }

  if (command === "report") {
    await reportCommand(flags);
    return;
  }

  if (command === "cleanup") {
    await cleanupCommand(flags);
    return;
  }

  throw new Error(`unknown command: ${command}`);
}

async function versionCommand(flags = {}) {
  const packageJson = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
  if (flags.json) {
    console.log(JSON.stringify({
      schemaVersion: "kova.version.v1",
      name: packageJson.name,
      version: packageJson.version
    }, null, 2));
    return;
  }

  console.log(packageJson.version);
}

async function loadRegistryContext() {
  const [surfaces, processRoles, metrics, scenarios, states, profiles] = await Promise.all([
    loadSurfaces(),
    loadProcessRoles(),
    loadMetrics(),
    loadScenarios(),
    loadStates(),
    loadProfiles()
  ]);
  validateRegistryReferences({ scenarios, states, profiles, surfaces, processRoles, metrics });
  return { surfaces, processRoles, metrics, scenarios, states, profiles };
}

function filterRegistry(items, selectedId, kind) {
  if (!selectedId) {
    return items;
  }
  const filtered = items.filter((item) => item.id === selectedId);
  if (filtered.length === 0) {
    throw new Error(`no ${kind} found for ${selectedId}`);
  }
  return filtered;
}

async function plan(flags) {
  const registry = await loadRegistryContext();
  const scenarios = filterRegistry(registry.scenarios, flags.scenario, "scenario");
  const states = filterRegistry(registry.states, flags.state, "state");
  const profiles = flags.profile ? filterRegistry(registry.profiles, flags.profile, "profile") : registry.profiles;
  const platform = platformInfo();
  const coverage = buildCoverage({ ...registry, platform });

  if (flags.json) {
    console.log(JSON.stringify({
      schemaVersion: "kova.plan.v1",
      generatedAt: new Date().toISOString(),
      platform,
      surfaces: registry.surfaces,
      processRoles: registry.processRoles,
      metrics: registry.metrics,
      scenarios,
      states,
      profiles: profiles.map(profileSummary),
      coverage
    }, null, 2));
    return;
  }

  for (const scenario of scenarios) {
    console.log(`${scenario.id}: ${scenario.title}`);
    console.log(`  Surface: ${scenario.surface}`);
    console.log(`  Objective: ${scenario.objective}`);
    console.log(`  Tags: ${scenario.tags.join(", ")}`);
    console.log("  Phases:");
    for (const phase of scenario.phases) {
      console.log(`    - ${phase.id}: ${phase.title}`);
    }
    console.log("");
  }
}

async function matrixCommand(flags) {
  const [subcommand = "plan"] = flags._;

  if (subcommand === "plan") {
    await loadRegistryContext();
    const profile = await loadProfile(required(flags.profile, "--profile"));
    const target = required(flags.target, "--target");
    const targetPlan = resolveTarget(target, "target");
    validateProfileTarget(profile, targetPlan);
    const fromPlan = flags.from ? resolveTarget(flags.from, "from") : null;
    const platform = platformInfo();
    const entries = applyMatrixControls(await expandProfile(profile), flags, platform);
    for (const entry of entries.filter((item) => !item.skipReason)) {
      validateScenarioRun(entry.scenario, flags, { targetPlan, fromPlan });
    }
    const response = {
      schemaVersion: "kova.matrix.plan.v1",
      generatedAt: new Date().toISOString(),
      platform,
      profile: profileSummary(profile),
      target,
      from: flags.from ?? null,
      controls: matrixControlSummary(flags, targetPlan),
      entries: entries.map((entry) => entry.plan)
    };

    if (flags.json) {
      console.log(JSON.stringify(response, null, 2));
      return;
    }

    console.log(`${profile.id}: ${profile.title}`);
    console.log(`Target: ${target}`);
    if (flags.from) {
      console.log(`From: ${flags.from}`);
    }
    for (const entry of entries) {
      const suffix = entry.skipReason ? ` [SKIP: ${entry.skipReason}]` : "";
      console.log(`- ${entry.scenario.id} / ${entry.state.id}: ${entry.scenario.title}${suffix}`);
    }
    return;
  }

  if (subcommand === "run") {
    await matrixRun(flags);
    return;
  }

  throw new Error(`unknown matrix command: ${subcommand}`);
}

async function reportCommand(flags) {
  const [subcommand, firstPath, secondPath] = flags._;

  if (subcommand === "summarize") {
    const report = await readReport(required(firstPath, "report path"));
    if (flags.json) {
      console.log(JSON.stringify({
        schemaVersion: "kova.report.summary.v1",
        generatedAt: new Date().toISOString(),
        summary: renderReportSummary(report, { structured: true })
      }, null, 2));
      return;
    }

    console.log(renderReportSummary(report));
    return;
  }

  if (subcommand === "paste") {
    const report = await readReport(required(firstPath, "report path"));
    console.log(renderPasteSummary(report));
    return;
  }

  if (subcommand === "compare") {
    await compareReportsCommand(required(firstPath, "baseline report path"), required(secondPath, "current report path"), flags);
    return;
  }

  if (subcommand === "bundle") {
    const receipt = await bundleReport(required(firstPath, "report path"), {
      outputDir: flags.output_dir
    });

    if (flags.json) {
      console.log(JSON.stringify(receipt, null, 2));
      return;
    }

    console.log(`Bundle: ${relative(process.cwd(), receipt.outputPath)}`);
    console.log(`SHA256: ${relative(process.cwd(), receipt.checksumPath)}`);
    return;
  }

  throw new Error(`unknown report command: ${subcommand ?? ""}`);
}

async function compareReportsCommand(baselinePath, currentPath, flags) {
  const baseline = await readReport(baselinePath);
  const current = await readReport(currentPath);
  const thresholds = flags.thresholds ? await readReport(flags.thresholds) : null;
  const comparison = compareReports(baseline, current, { thresholds });

  if (flags.json) {
    console.log(JSON.stringify(comparison, null, 2));
    return;
  }

  console.log(flags.fixer ? renderCompareFixerSummary(comparison) : renderCompareSummary(comparison));
  if (!comparison.ok) {
    throw new Error("comparison found regressions");
  }
}

async function readReport(path) {
  return JSON.parse(await readFile(resolveFromCwd(path), "utf8"));
}

async function loadRegressionThresholds(flags) {
  if (!flags.regression_thresholds) {
    return null;
  }
  if (flags.regression_thresholds === true) {
    throw new Error("--regression-thresholds requires a JSON file path");
  }
  return JSON.parse(await readFile(resolveFromCwd(String(flags.regression_thresholds)), "utf8"));
}

async function matrixRun(flags) {
  const registry = await loadRegistryContext();
  const profile = await loadProfile(required(flags.profile, "--profile"));
  validateProfileExecutionFlags(profile, flags);
  const target = required(flags.target, "--target");
  validateBaselineExecutionFlags(flags);
  const targetPlan = resolveTarget(target, "target");
  validateProfileTarget(profile, targetPlan);
  const fromPlan = flags.from ? resolveTarget(flags.from, "from") : null;
  const entries = applyMatrixControls(await expandProfile(profile), flags, platformInfo());
  const controls = matrixControlSummary(flags, targetPlan);
  const auth = await resolveRunAuthContext(flags);
  const regressionThresholds = await loadRegressionThresholds(flags);
  const baselinePath = resolveBaselinePath(flags.baseline);
  const saveBaselinePath = resolveBaselinePath(flags.save_baseline);
  const baselineStore = baselinePath ? await loadBaselineStore(baselinePath) : null;
  preflightGateRun({ entries, flags });
  for (const entry of entries.filter((item) => !item.skipReason)) {
    validateScenarioRun(entry.scenario, flags, { targetPlan, fromPlan });
  }
  const reportRoot = flags.report_dir ? resolveFromCwd(flags.report_dir) : reportsDir;
  const runId = createRunId();
  const reportPath = join(reportRoot, `${runId}-${profile.id}.md`);
  const jsonPath = join(reportRoot, `${runId}-${profile.id}.json`);
  const targetSetup = { completed: false };
  const runEntry = async (entry) => {
    const context = {
      target,
      targetPlan,
      profile,
      from: flags.from,
      fromPlan,
      state: entry.state,
      sourceEnv: flags.source_env,
      runId,
      controls,
      execute: flags.execute === true,
      keepEnv: flags.keep_env === true,
      retainOnFailure: flags.retain_on_failure === true,
      timeoutMs: resolveEntryTimeout(entry, flags),
      healthSamples: profileIntegerFlag(flags, "health_samples", flags.deep_profile === true ? 10 : 3),
      healthIntervalMs: positiveIntegerFlag(flags, "health_interval_ms", 250),
      readinessIntervalMs: profileIntegerFlag(flags, "readiness_interval_ms", flags.deep_profile === true ? 100 : 250),
      heapSnapshot: flags.heap_snapshot === true || flags.deep_profile === true,
      diagnosticReport: flags.deep_profile === true,
      nodeProfile: flags.node_profile === true || flags.deep_profile === true,
      deepProfile: flags.deep_profile === true,
      profileOnFailure: flags.profile_on_failure === true,
      resourceSampleIntervalMs: profileIntegerFlag(flags, "resource_sample_interval_ms", flags.deep_profile === true ? 250 : 1000),
      processRoles: registry.processRoles,
      surfacesById: Object.fromEntries(registry.surfaces.map((surface) => [surface.id, surface])),
      targetSetup,
      auth
    };

    if (entry.skipReason) {
      return buildRepeatRecords(entry, context, (iterationContext) => buildSkippedRecord(entry.scenario, iterationContext, entry.skipReason));
    }

    return buildRepeatRecords(entry, context, async (iterationContext) =>
      iterationContext.execute
        ? executeScenario(entry.scenario, iterationContext)
        : buildDryRunRecord(entry.scenario, iterationContext)
    );
  };

  const records = flags.execute === true
    ? await runMatrixEntries(entries, runEntry, controls)
    : (await Promise.all(entries.map((entry) => runEntry(entry)))).flat();
  const targetCleanup = await cleanupTargetRuntimeIfNeeded(targetPlan, records, {
    execute: flags.execute === true,
    timeoutMs: positiveIntegerFlag(flags, "timeout_ms", 120000)
  });
  const performance = buildPerformanceSummary(records, {
    repeat: controls.repeat,
    regressionThresholds
  });
  const platform = platformInfo();
  const reportBase = {
    schemaVersion: reportSchemaVersion,
    generatedAt: new Date().toISOString(),
    runId,
    outputPaths: {
      markdown: reportPath,
      json: jsonPath
    },
    mode: flags.execute === true ? "execution" : "dry-run",
    profile: profileSummary(profile),
    target,
    from: flags.from ?? null,
    controls,
    auth: authReportSummary(auth),
    state: null,
    platform,
    targetCleanup,
    performance,
    baseline: null,
    gate: null,
    summary: summarizeRecords(records),
    records
  };
  const baselineComparison = comparePerformanceToBaseline(reportBase, baselineStore, { targetPlan, regressionThresholds });
  if (baselineComparison) {
    reportBase.baseline = {
      path: baselinePath,
      comparison: baselineComparison
    };
  }
  const gate = flags.gate === true
    ? evaluateGate({
      mode: flags.execute === true ? "execution" : "dry-run",
      controls,
      performance,
      baseline: reportBase.baseline,
      platform: reportBase.platform,
      records
    }, profile)
    : null;

  await mkdir(reportRoot, { recursive: true });
  const report = {
    ...reportBase,
    gate
  };
  if (saveBaselinePath) {
    const existingStore = await loadBaselineStore(saveBaselinePath);
    const review = reviewBaselineUpdate(report, { reviewedGood: flags.reviewed_good === true });
    const updatedStore = updateBaselineStore(existingStore, report, { targetPlan, reviewedGood: flags.reviewed_good === true });
    report.baseline = {
      ...(report.baseline ?? {}),
      review,
      saved: await saveBaselineStore(saveBaselinePath, updatedStore)
    };
  }
  await writeFile(reportPath, renderMarkdownReport(report), "utf8");
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const bundle = await bundleReport(jsonPath, { outputDir: reportRoot });
  const retainedGateArtifacts = gate && gate.verdict !== "SHIP"
    ? await retainFailedGateArtifacts(report, reportPath, jsonPath, bundle)
    : null;

  if (flags.json) {
    console.log(JSON.stringify({
      schemaVersion: "kova.matrix.run.receipt.v1",
      generatedAt: new Date().toISOString(),
      mode: report.mode,
      runId,
      profile: profileSummary(profile),
      reportPath,
      jsonPath,
      bundlePath: bundle.outputPath,
      checksumPath: bundle.checksumPath,
      retainedGateArtifacts,
      gate: summarizeGateReceipt(gate),
      performance: summarizePerformanceReceipt(report.performance, report.baseline),
      summary: report.summary
    }, null, 2));
    failGateIfNeeded(gate);
    return;
  }

  console.log(`Kova matrix ${report.mode} report written: ${relative(process.cwd(), reportPath)}`);
  console.log(`Kova matrix ${report.mode} data written: ${relative(process.cwd(), jsonPath)}`);
  console.log(`Kova matrix bundle written: ${relative(process.cwd(), bundle.outputPath)}`);
  if (retainedGateArtifacts) {
    console.log(`Kova failed gate artifacts retained: ${relative(process.cwd(), retainedGateArtifacts.outputDir)}`);
  }
  if (gate) {
    console.log(`Kova gate verdict: ${gate.verdict}`);
  }
  failGateIfNeeded(gate);
}

function validateProfileExecutionFlags(profile, flags) {
  if (flags.execute === true && profile.id === "exhaustive" && flags.allow_exhaustive !== true) {
    throw new Error("executing profile 'exhaustive' requires --allow-exhaustive");
  }
}

async function retainFailedGateArtifacts(report, reportPath, jsonPath, bundle) {
  report.retainedGateArtifacts = {
    status: "pending"
  };
  await writeFile(reportPath, renderMarkdownReport(report), "utf8");
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const retained = await retainGateArtifacts(jsonPath, bundle);
  report.retainedGateArtifacts = retained;
  await writeFile(reportPath, renderMarkdownReport(report), "utf8");
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await retainGateArtifacts(jsonPath, bundle, { outputDir: retained.outputDir });
  return retained;
}

async function expandProfile(profile) {
  const entries = [];
  for (const entry of profile.entries) {
    const [scenario] = await loadScenarios(entry.scenario);
    const state = await loadState(entry.state);
    entries.push({
      scenario: {
        id: scenario.id,
        surface: scenario.surface,
        title: scenario.title,
        objective: scenario.objective,
        tags: scenario.tags
      },
      state: {
        id: state.id,
        title: state.title,
        objective: state.objective,
        tags: state.tags
      },
      entry: {
        timeoutMs: entry.timeoutMs ?? null,
        platforms: entry.platforms ?? null
      },
      fullScenario: scenario,
      fullState: state
    });
  }

  return entries.map((entry) => ({
    scenario: entry.fullScenario,
    state: entry.fullState,
    timeoutMs: entry.entry.timeoutMs,
    platforms: entry.entry.platforms,
    plan: {
      scenario: entry.scenario,
      state: entry.state,
      surface: entry.fullScenario.surface,
      timeoutMs: entry.entry.timeoutMs ?? entry.fullScenario.timeoutMs ?? null,
      platforms: entry.entry.platforms ?? entry.fullScenario.platforms ?? null
    }
  }));
}

function applyMatrixControls(entries, flags, platform) {
  const included = parseFilterList(flags.include);
  const excluded = parseFilterList(flags.exclude);
  return entries
    .filter((entry) => included.length === 0 || included.some((filter) => entryMatchesFilter(entry, filter)))
    .filter((entry) => !excluded.some((filter) => entryMatchesFilter(entry, filter)))
    .map((entry) => {
      const skipReason = platformSkipReason(entry, platform);
      return {
        ...entry,
        skipReason,
        plan: {
          ...entry.plan,
          status: skipReason ? "SKIPPED" : "SELECTED",
          skipReason
        }
      };
    });
}

function parseFilterList(value) {
  if (!value) {
    return [];
  }
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function entryMatchesFilter(entry, filter) {
  const [kind, value] = filter.includes(":") ? filter.split(":", 2) : ["any", filter];
  if (kind === "scenario") {
    return entry.scenario.id === value;
  }
  if (kind === "state") {
    return entry.state.id === value;
  }
  if (kind === "tag") {
    return [...(entry.scenario.tags ?? []), ...(entry.state.tags ?? [])].includes(value);
  }
  return entry.scenario.id === value || entry.state.id === value ||
    (entry.scenario.tags ?? []).includes(value) || (entry.state.tags ?? []).includes(value);
}

function platformSkipReason(entry, platform) {
  for (const policy of [entry.scenario.platforms, entry.platforms]) {
    const reason = platformPolicySkipReason(policy, platform);
    if (reason) {
      return reason;
    }
  }
  return null;
}

function platformPolicySkipReason(policy, platform) {
  if (!policy) {
    return null;
  }
  const keys = platformKeys(platform);
  if (Array.isArray(policy.include) && policy.include.length > 0 && !policy.include.some((item) => keys.includes(item))) {
    return `platform ${platform.os}/${platform.arch} not included`;
  }
  if (Array.isArray(policy.exclude) && policy.exclude.some((item) => keys.includes(item))) {
    return `platform ${platform.os}/${platform.arch} excluded`;
  }
  return null;
}

function platformKeys(platform) {
  return [
    platform.os,
    platform.arch,
    `${platform.os}-${platform.arch}`,
    platform.release
  ].filter(Boolean);
}

function resolveEntryTimeout(entry, flags) {
  return positiveIntegerValue(flags.timeout_ms ?? entry.timeoutMs ?? entry.scenario.timeoutMs ?? 120000, "--timeout-ms");
}

function matrixControlSummary(flags, targetPlan) {
  const requestedParallel = positiveIntegerFlag(flags, "parallel", 1);
  const repeat = positiveIntegerFlag(flags, "repeat", 1);
  const failFast = flags.fail_fast === true;
  const parallel = failFast || targetPlan.kind === "local-build" ? 1 : requestedParallel;
  return {
    include: parseFilterList(flags.include),
    exclude: parseFilterList(flags.exclude),
    failFast,
    continueOnFailure: !failFast,
    requestedParallel,
    parallel,
    parallelAdjusted: parallel !== requestedParallel,
    repeat,
    baseline: flags.baseline ? resolveBaselinePath(flags.baseline) : null,
    saveBaseline: flags.save_baseline ? resolveBaselinePath(flags.save_baseline) : null,
    gate: flags.gate === true,
    reviewedGood: flags.reviewed_good === true,
    bundle: true
  };
}

async function buildRepeatRecords(entry, context, callback) {
  const total = positiveIntegerValue(context.controls?.repeat ?? 1, "repeat");
  const records = [];
  for (let index = 1; index <= total; index += 1) {
    records.push(await callback({
      ...context,
      repeat: {
        index,
        total
      }
    }));
  }
  return records;
}

function failGateIfNeeded(gate) {
  if (gate && gate.verdict !== "SHIP") {
    throw new Error(`release gate verdict: ${gate.verdict}`);
  }
}

function summarizeGateReceipt(gate) {
  if (!gate) {
    return null;
  }
  return {
    schemaVersion: gate.schemaVersion,
    enabled: gate.enabled,
    profileId: gate.profileId,
    policyId: gate.policyId,
    verdict: gate.verdict,
    ok: gate.ok,
    complete: gate.complete,
    partial: gate.partial,
    missingRequiredCount: gate.missingRequiredCount,
    blockingCount: gate.blockingCount,
    warningCount: gate.warningCount,
    infoCount: gate.infoCount,
    subsystemCount: gate.subsystems?.length ?? 0,
    fixerSummaryCount: gate.fixerSummaries?.length ?? 0,
    baselineRegressionCount: gate.baseline?.regressionCount ?? null,
    missingBaselineCount: gate.baseline?.missingBaselineCount ?? null
  };
}

function summarizePerformanceReceipt(performance, baseline) {
  if (!performance) {
    return null;
  }
  return {
    schemaVersion: performance.schemaVersion,
    repeat: performance.repeat,
    groupCount: performance.groupCount,
    unstableGroupCount: performance.unstableGroupCount,
    profiledRunCount: performance.profiledRunCount ?? 0,
    baselineRegressionCount: baseline?.comparison?.regressionCount ?? null,
    missingBaselineCount: baseline?.comparison?.missingBaselineCount ?? null,
    baselineReviewOk: baseline?.review?.ok ?? null,
    baselineReviewBlockerCount: baseline?.review?.blockerCount ?? null,
    savedBaselinePath: baseline?.saved?.path ?? null
  };
}

async function runMatrixEntries(entries, runEntry, controls) {
  if (controls.parallel <= 1) {
    const records = [];
    for (const entry of entries) {
      const entryRecords = await runEntry(entry);
      records.push(...entryRecords);
      if (controls.failFast && entryRecords.some((record) => record.status === "FAIL" || record.status === "BLOCKED")) {
        break;
      }
    }
    return records;
  }

  const records = new Array(entries.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < entries.length) {
      const index = nextIndex;
      nextIndex += 1;
      records[index] = await runEntry(entries[index]);
    }
  }

  await Promise.all(Array.from({ length: controls.parallel }, () => worker()));
  return records.filter(Boolean).flat();
}

function profileSummary(profile) {
  return {
    id: profile.id,
    title: profile.title,
    objective: profile.objective,
    entryCount: profile.entries.length,
    targetKinds: profile.targetKinds ?? null,
    diagnostics: profile.diagnostics ?? null,
    calibration: profile.calibration ? {
      surfaceCount: Object.keys(profile.calibration.surfaces ?? {}).length,
      roleCount: Object.keys(profile.calibration.roles ?? {}).length
    } : null,
    gate: profile.gate ? {
      id: profile.gate.id ?? `${profile.id}-gate`,
      blockingCount: Array.isArray(profile.gate.blocking) ? profile.gate.blocking.length : profile.entries.length,
      warningCount: Array.isArray(profile.gate.warning) ? profile.gate.warning.length : 0
    } : null
  };
}

function validateProfileTarget(profile, targetPlan) {
  const targetKinds = profile.targetKinds ?? [];
  if (targetKinds.length === 0) {
    return;
  }
  if (!targetKinds.includes(targetPlan.kind)) {
    throw new Error(`profile '${profile.id}' requires target kind ${targetKinds.join(", ")}, got ${targetPlan.kind}`);
  }
}

async function cleanupCommand(flags) {
  const [subcommand] = flags._;
  if (subcommand === "envs") {
    await cleanupEnvs(flags);
    return;
  }
  if (subcommand === "artifacts") {
    await cleanupArtifacts(flags);
    return;
  }

  throw new Error(`unknown cleanup command: ${subcommand ?? ""}`);
}

async function cleanupEnvs(flags) {
  const envList = await runCommand(ocmEnvListJson(), { timeoutMs: 30000 });
  if (envList.status !== 0) {
    throw new Error(`failed to list OCM envs: ${envList.stderr.trim() || envList.stdout.trim()}`);
  }

  const summaries = JSON.parse(envList.stdout);
  if (!Array.isArray(summaries)) {
    throw new Error("ocm env list --json returned unexpected data");
  }

  const envs = summaries
    .map((summary) => summary.name)
    .filter((name) => /^kova-[a-z0-9-]+$/.test(name));
  const results = [];

  if (flags.execute) {
    for (const env of envs) {
      results.push(await runCleanupCommand(ocmEnvDestroy(env), { timeoutMs: 120000 }));
    }
  }

  if (flags.json) {
    console.log(JSON.stringify({
      schemaVersion: "kova.cleanup.envs.v1",
      generatedAt: new Date().toISOString(),
      execute: flags.execute === true,
      envs,
      results: results.map((result) => ({
        command: result.command,
        status: result.status,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
        attempts: result.attempts ?? []
      }))
    }, null, 2));
    return;
  }

  if (envs.length === 0) {
    console.log("No stale Kova envs found.");
    return;
  }

  if (!flags.execute) {
    console.log("Stale Kova envs:");
    for (const env of envs) {
      console.log(`- ${env}`);
    }
    console.log("Run with --execute to destroy them.");
    return;
  }

  for (const result of results) {
    console.log(`${result.status === 0 ? "PASS" : "FAIL"} ${result.command}`);
  }
}

async function cleanupArtifacts(flags) {
  const olderThanDays = positiveIntegerFlag(flags, "older_than_days", 7);
  const cutoffMs = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
  const candidates = [];

  let entries = [];
  try {
    entries = await readdir(artifactsDir, { withFileTypes: true });
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !/^kova-\d{4}-\d{2}-\d{2}t/i.test(entry.name)) {
      continue;
    }
    const path = join(artifactsDir, entry.name);
    const info = await stat(path);
    if (info.mtimeMs > cutoffMs) {
      continue;
    }
    candidates.push({
      name: entry.name,
      path,
      mtime: info.mtime.toISOString(),
      ageDays: Math.max(0, Math.floor((Date.now() - info.mtimeMs) / (24 * 60 * 60 * 1000)))
    });
  }

  const results = [];
  if (flags.execute === true) {
    for (const candidate of candidates) {
      const started = Date.now();
      try {
        await rm(candidate.path, { recursive: true, force: true });
        results.push({
          path: candidate.path,
          status: 0,
          durationMs: Date.now() - started,
          error: null
        });
      } catch (error) {
        results.push({
          path: candidate.path,
          status: 1,
          durationMs: Date.now() - started,
          error: error.message
        });
      }
    }
  }

  if (flags.json) {
    console.log(JSON.stringify({
      schemaVersion: "kova.cleanup.artifacts.v1",
      generatedAt: new Date().toISOString(),
      execute: flags.execute === true,
      artifactsDir,
      olderThanDays,
      candidates,
      results
    }, null, 2));
    return;
  }

  if (candidates.length === 0) {
    console.log(`No Kova run artifact dirs older than ${olderThanDays} day(s) found.`);
    return;
  }

  if (flags.execute !== true) {
    console.log(`Kova run artifact dirs older than ${olderThanDays} day(s):`);
    for (const candidate of candidates) {
      console.log(`- ${candidate.path}`);
    }
    console.log("Run with --execute to remove them.");
    return;
  }

  for (const result of results) {
    console.log(`${result.status === 0 ? "PASS" : "FAIL"} ${result.path}`);
  }
}

async function run(flags) {
  const registry = await loadRegistryContext();
  const target = required(flags.target, "--target");
  if (flags.execute === true && !flags.scenario) {
    throw new Error("--execute requires --scenario so real runs stay deliberate");
  }
  validateBaselineExecutionFlags(flags);

  const targetPlan = resolveTarget(target, "target");
  const fromPlan = flags.from ? resolveTarget(flags.from, "from") : null;
  const state = await loadState(flags.state ?? "fresh");
  const scenarios = await loadScenarios(flags.scenario);
  for (const scenario of scenarios) {
    validateScenarioRun(scenario, flags, { targetPlan, fromPlan });
  }

  const reportRoot = flags.report_dir ? resolveFromCwd(flags.report_dir) : reportsDir;
  const runId = createRunId();
  const reportPath = join(reportRoot, `${runId}.md`);
  const jsonPath = join(reportRoot, `${runId}.json`);
  const repeat = positiveIntegerFlag(flags, "repeat", 1);
  const auth = await resolveRunAuthContext(flags);
  const regressionThresholds = await loadRegressionThresholds(flags);
  const baselinePath = resolveBaselinePath(flags.baseline);
  const saveBaselinePath = resolveBaselinePath(flags.save_baseline);
  const baselineStore = baselinePath ? await loadBaselineStore(baselinePath) : null;
  const context = {
    target,
    targetPlan,
    from: flags.from,
    fromPlan,
    state,
    sourceEnv: flags.source_env,
    runId,
    execute: flags.execute === true,
    keepEnv: flags.keep_env === true,
    retainOnFailure: flags.retain_on_failure === true,
    timeoutMs: resolveRunTimeout(scenarios, flags),
    healthSamples: profileIntegerFlag(flags, "health_samples", flags.deep_profile === true ? 10 : 3),
    healthIntervalMs: positiveIntegerFlag(flags, "health_interval_ms", 250),
    readinessIntervalMs: profileIntegerFlag(flags, "readiness_interval_ms", flags.deep_profile === true ? 100 : 250),
    heapSnapshot: flags.heap_snapshot === true || flags.deep_profile === true,
    diagnosticReport: flags.deep_profile === true,
    nodeProfile: flags.node_profile === true || flags.deep_profile === true,
    deepProfile: flags.deep_profile === true,
    profileOnFailure: flags.profile_on_failure === true,
    resourceSampleIntervalMs: profileIntegerFlag(flags, "resource_sample_interval_ms", flags.deep_profile === true ? 250 : 1000),
    processRoles: registry.processRoles,
    surfacesById: Object.fromEntries(registry.surfaces.map((surface) => [surface.id, surface])),
    targetSetup: { completed: false },
    auth
  };
  const records = [];

  for (const scenario of scenarios) {
    for (let index = 1; index <= repeat; index += 1) {
      const iterationContext = {
        ...context,
        repeat: {
          index,
          total: repeat
        }
      };
      if (iterationContext.execute) {
        records.push(await executeScenario(scenario, iterationContext));
      } else {
        records.push(buildDryRunRecord(scenario, iterationContext));
      }
    }
  }
  const targetCleanup = await cleanupTargetRuntimeIfNeeded(targetPlan, records, {
    execute: context.execute,
    timeoutMs: context.timeoutMs
  });
  const performance = buildPerformanceSummary(records, { repeat, regressionThresholds });

  await mkdir(reportRoot, { recursive: true });
  const report = {
    schemaVersion: reportSchemaVersion,
    generatedAt: new Date().toISOString(),
    runId,
    mode: context.execute ? "execution" : "dry-run",
    target,
    from: flags.from ?? null,
    state: {
      id: state.id,
      title: state.title,
      objective: state.objective
    },
    platform: platformInfo(),
    targetCleanup,
    auth: authReportSummary(auth),
    controls: {
      repeat,
      baseline: baselinePath,
      saveBaseline: saveBaselinePath,
      auth: auth.requestedMode
    },
    performance,
    baseline: null,
    summary: summarizeRecords(records),
    records
  };
  const baselineComparison = comparePerformanceToBaseline(report, baselineStore, { targetPlan, regressionThresholds });
  if (baselineComparison) {
    report.baseline = {
      path: baselinePath,
      comparison: baselineComparison
    };
  }
  if (saveBaselinePath) {
    const existingStore = await loadBaselineStore(saveBaselinePath);
    const review = reviewBaselineUpdate(report, { reviewedGood: flags.reviewed_good === true });
    const updatedStore = updateBaselineStore(existingStore, report, { targetPlan, reviewedGood: flags.reviewed_good === true });
    report.baseline = {
      ...(report.baseline ?? {}),
      review,
      saved: await saveBaselineStore(saveBaselinePath, updatedStore)
    };
  }
  await writeFile(reportPath, renderMarkdownReport(report), "utf8");
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  const mode = context.execute ? "execution" : "dry-run";
  if (flags.json) {
    console.log(JSON.stringify({
      schemaVersion: "kova.run.receipt.v1",
      generatedAt: new Date().toISOString(),
      mode,
      runId,
      reportPath,
      jsonPath,
      performance: summarizePerformanceReceipt(report.performance, report.baseline),
      summary: report.summary
    }, null, 2));
    return;
  }

  console.log(`Kova ${mode} report written: ${relative(process.cwd(), reportPath)}`);
  console.log(`Kova ${mode} data written: ${relative(process.cwd(), jsonPath)}`);
}

function resolveRunTimeout(scenarios, flags) {
  if (flags.timeout_ms !== undefined) {
    return positiveIntegerFlag(flags, "timeout_ms", 120000);
  }
  const scenarioTimeouts = scenarios
    .map((scenario) => scenario.timeoutMs)
    .filter((timeout) => typeof timeout === "number");
  return scenarioTimeouts.length === 0 ? 120000 : Math.max(...scenarioTimeouts);
}

function validateBaselineExecutionFlags(flags) {
  if ((flags.baseline || flags.save_baseline) && flags.execute !== true) {
    throw new Error("--baseline and --save-baseline require --execute so baseline evidence comes from real OpenClaw runs");
  }
  if (flags.save_baseline && flags.reviewed_good !== true) {
    throw new Error("--save-baseline requires --reviewed-good after reviewing a passing, stable execution report");
  }
}

async function cleanupTargetRuntimeIfNeeded(targetPlan, records, options) {
  if (targetPlan.kind !== "local-build") {
    return null;
  }

  const command = ocmRuntimeRemoveJson(targetPlan.runtimeName);
  if (!options.execute) {
    return {
      status: "planned",
      runtimeName: targetPlan.runtimeName,
      command
    };
  }

  if (records.some((record) => record.cleanup === "retained")) {
    return {
      status: "retained",
      runtimeName: targetPlan.runtimeName,
      command,
      reason: "one or more envs were retained"
    };
  }

  const result = await runCleanupCommand(command, { timeoutMs: options.timeoutMs });
  const cleanupStatus = classifyTargetRuntimeCleanup(result);
  return {
    status: cleanupStatus.status,
    runtimeName: targetPlan.runtimeName,
    command,
    reason: cleanupStatus.reason,
    result: {
      status: result.status,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      stdout: result.stdout,
      stderr: result.stderr,
      attempts: result.attempts ?? []
    }
  };
}

function classifyTargetRuntimeCleanup(result) {
  if (result.status === 0) {
    return { status: "removed" };
  }

  const output = `${result.stdout}\n${result.stderr}`;
  if (/\bruntime\b[\s\S]*\bdoes not exist\b/i.test(output) || /\bnot found\b/i.test(output)) {
    return {
      status: "already-absent",
      reason: "target runtime was not present when cleanup ran"
    };
  }

  return { status: "remove-failed" };
}

function positiveIntegerFlag(flags, key, defaultValue) {
  if (flags[key] === undefined) {
    return defaultValue;
  }
  return positiveIntegerValue(flags[key], `--${key.replaceAll("_", "-")}`);
}

function profileIntegerFlag(flags, key, defaultValue) {
  return positiveIntegerFlag(flags, key, defaultValue);
}

function positiveIntegerValue(raw, label) {
  if (raw === true) {
    throw new Error(`${label} requires a positive integer value`);
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}
