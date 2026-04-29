import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { bundleReport } from "./artifacts.mjs";
import { runCommand } from "./commands.mjs";
import { compareReports, renderCompareFixerSummary, renderCompareSummary } from "./compare.mjs";
import { parseFlags, printHelp, required, resolveFromCwd } from "./cli.mjs";
import { platformInfo } from "./platform.mjs";
import { loadProfile, loadProfiles } from "./profiles.mjs";
import { repoRoot, reportsDir } from "./paths.mjs";
import { renderMarkdownReport, renderPasteSummary, renderReportSummary, summarizeRecords } from "./report.mjs";
import { buildDryRunRecord, buildSkippedRecord, createRunId, executeScenario } from "./runner.mjs";
import { loadScenarios, validateScenarioRun } from "./scenarios.mjs";
import { runSelfCheck } from "./selfcheck.mjs";
import { runSetup } from "./setup.mjs";
import { loadState, loadStates } from "./states.mjs";
import { resolveTarget } from "./targets.mjs";

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

async function plan(flags) {
  const scenarios = await loadScenarios(flags.scenario);
  const states = await loadStates(flags.state);
  const profiles = flags.profile ? [await loadProfile(flags.profile)] : await loadProfiles();

  if (flags.json) {
    console.log(JSON.stringify({
      schemaVersion: "kova.plan.v1",
      generatedAt: new Date().toISOString(),
      platform: platformInfo(),
      scenarios,
      states,
      profiles: profiles.map(profileSummary)
    }, null, 2));
    return;
  }

  for (const scenario of scenarios) {
    console.log(`${scenario.id}: ${scenario.title}`);
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
    const profile = await loadProfile(required(flags.profile, "--profile"));
    const target = required(flags.target, "--target");
    const targetPlan = resolveTarget(target, "target");
    if (flags.from) {
      resolveTarget(flags.from, "from");
    }
    const platform = platformInfo();
    const entries = applyMatrixControls(await expandProfile(profile), flags, platform);
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

async function matrixRun(flags) {
  const profile = await loadProfile(required(flags.profile, "--profile"));
  const target = required(flags.target, "--target");
  const targetPlan = resolveTarget(target, "target");
  const fromPlan = flags.from ? resolveTarget(flags.from, "from") : null;
  const entries = applyMatrixControls(await expandProfile(profile), flags, platformInfo());
  for (const entry of entries.filter((item) => !item.skipReason)) {
    validateScenarioRun(entry.scenario, flags);
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
      from: flags.from,
      fromPlan,
      state: entry.state,
      sourceEnv: flags.source_env,
      runId,
      execute: flags.execute === true,
      keepEnv: flags.keep_env === true,
      retainOnFailure: flags.retain_on_failure === true,
      timeoutMs: resolveEntryTimeout(entry, flags),
      healthSamples: Number(flags.health_samples ?? 3),
      healthIntervalMs: Number(flags.health_interval_ms ?? 250),
      readinessIntervalMs: Number(flags.readiness_interval_ms ?? 250),
      heapSnapshot: flags.heap_snapshot === true,
      resourceSampleIntervalMs: Number(flags.resource_sample_interval_ms ?? 1000),
      targetSetup
    };

    if (entry.skipReason) {
      return buildSkippedRecord(entry.scenario, context, entry.skipReason);
    }

    if (context.execute) {
      return executeScenario(entry.scenario, context);
    }
    return buildDryRunRecord(entry.scenario, context);
  };

  const controls = matrixControlSummary(flags, targetPlan);
  const records = flags.execute === true
    ? await runMatrixEntries(entries, runEntry, controls)
    : await Promise.all(entries.map((entry) => runEntry(entry)));

  await mkdir(reportRoot, { recursive: true });
  const report = {
    schemaVersion: reportSchemaVersion,
    generatedAt: new Date().toISOString(),
    runId,
    mode: flags.execute === true ? "execution" : "dry-run",
    profile: profileSummary(profile),
    target,
    from: flags.from ?? null,
    controls,
    state: null,
    platform: platformInfo(),
    summary: summarizeRecords(records),
    records
  };
  await writeFile(reportPath, renderMarkdownReport(report), "utf8");
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const bundle = await bundleReport(jsonPath);

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
      summary: report.summary
    }, null, 2));
    return;
  }

  console.log(`Kova matrix ${report.mode} report written: ${relative(process.cwd(), reportPath)}`);
  console.log(`Kova matrix ${report.mode} data written: ${relative(process.cwd(), jsonPath)}`);
  console.log(`Kova matrix bundle written: ${relative(process.cwd(), bundle.outputPath)}`);
}

async function expandProfile(profile) {
  const entries = [];
  for (const entry of profile.entries) {
    const [scenario] = await loadScenarios(entry.scenario);
    const state = await loadState(entry.state);
    entries.push({
      scenario: {
        id: scenario.id,
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
  return Number(flags.timeout_ms ?? entry.timeoutMs ?? entry.scenario.timeoutMs ?? 120000);
}

function matrixControlSummary(flags, targetPlan) {
  const requestedParallel = Math.max(1, Number(flags.parallel ?? 1));
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
    bundle: true
  };
}

async function runMatrixEntries(entries, runEntry, controls) {
  if (controls.parallel <= 1) {
    const records = [];
    for (const entry of entries) {
      const record = await runEntry(entry);
      records.push(record);
      if (controls.failFast && (record.status === "FAIL" || record.status === "BLOCKED")) {
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
  return records.filter(Boolean);
}

function profileSummary(profile) {
  return {
    id: profile.id,
    title: profile.title,
    objective: profile.objective,
    entryCount: profile.entries.length
  };
}

async function cleanupCommand(flags) {
  const [subcommand] = flags._;
  if (subcommand !== "envs") {
    throw new Error(`unknown cleanup command: ${subcommand ?? ""}`);
  }

  const envList = await runCommand("ocm env list --json", { timeoutMs: 30000 });
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
      results.push(await runCommand(`ocm env destroy ${env} --yes`, { timeoutMs: 120000 }));
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
        timedOut: result.timedOut
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

async function run(flags) {
  const target = required(flags.target, "--target");
  if (flags.execute === true && !flags.scenario) {
    throw new Error("--execute requires --scenario so real runs stay deliberate");
  }

  const targetPlan = resolveTarget(target, "target");
  const fromPlan = flags.from ? resolveTarget(flags.from, "from") : null;
  const state = await loadState(flags.state ?? "fresh");
  const scenarios = await loadScenarios(flags.scenario);
  for (const scenario of scenarios) {
    validateScenarioRun(scenario, flags);
  }

  const reportRoot = flags.report_dir ? resolveFromCwd(flags.report_dir) : reportsDir;
  const runId = createRunId();
  const reportPath = join(reportRoot, `${runId}.md`);
  const jsonPath = join(reportRoot, `${runId}.json`);
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
    healthSamples: Number(flags.health_samples ?? 3),
    healthIntervalMs: Number(flags.health_interval_ms ?? 250),
    readinessIntervalMs: Number(flags.readiness_interval_ms ?? 250),
    heapSnapshot: flags.heap_snapshot === true,
    resourceSampleIntervalMs: Number(flags.resource_sample_interval_ms ?? 1000),
    targetSetup: { completed: false }
  };
  const records = [];

  for (const scenario of scenarios) {
    if (context.execute) {
      records.push(await executeScenario(scenario, context));
    } else {
      records.push(buildDryRunRecord(scenario, context));
    }
  }

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
    summary: summarizeRecords(records),
    records
  };
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
      summary: report.summary
    }, null, 2));
    return;
  }

  console.log(`Kova ${mode} report written: ${relative(process.cwd(), reportPath)}`);
  console.log(`Kova ${mode} data written: ${relative(process.cwd(), jsonPath)}`);
}

function resolveRunTimeout(scenarios, flags) {
  if (flags.timeout_ms) {
    return Number(flags.timeout_ms);
  }
  const scenarioTimeouts = scenarios
    .map((scenario) => scenario.timeoutMs)
    .filter((timeout) => typeof timeout === "number");
  return scenarioTimeouts.length === 0 ? 120000 : Math.max(...scenarioTimeouts);
}
