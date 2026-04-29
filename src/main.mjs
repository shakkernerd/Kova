import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { checkCommand } from "./commands.mjs";
import { parseFlags, printHelp, required, resolveFromCwd } from "./cli.mjs";
import { platformInfo } from "./platform.mjs";
import { reportsDir } from "./paths.mjs";
import { renderMarkdownReport, renderPasteSummary, renderReportSummary, summarizeRecords } from "./report.mjs";
import { buildDryRunRecord, createRunId, executeScenario } from "./runner.mjs";
import { loadScenarios, validateScenarioRun } from "./scenarios.mjs";
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

  if (command === "doctor") {
    await doctor(flags);
    return;
  }

  if (command === "plan") {
    await plan(flags);
    return;
  }

  if (command === "scenarios") {
    await scenariosCommand(flags);
    return;
  }

  if (command === "states") {
    await statesCommand(flags);
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

  throw new Error(`unknown command: ${command}`);
}

async function doctor(flags = {}) {
  const checks = [checkCommand("node", ["--version"]), checkCommand("ocm", ["--version"])];
  const ok = checks.every((check) => check.status === 0);

  if (flags.json) {
    console.log(JSON.stringify({
      schemaVersion: "kova.doctor.v1",
      generatedAt: new Date().toISOString(),
      platform: platformInfo(),
      ok,
      checks
    }, null, 2));
    if (!ok) {
      throw new Error("doctor found missing prerequisites");
    }
    return;
  }

  for (const check of checks) {
    if (check.status === 0) {
      console.log(`PASS ${check.command}: ${check.stdout.trim()}`);
    } else {
      console.log(`FAIL ${check.command}: ${check.stderr.trim() || "not available"}`);
    }
  }

  if (!ok) {
    throw new Error("doctor found missing prerequisites");
  }
}

async function plan(flags) {
  const scenarios = await loadScenarios(flags.scenario);

  if (flags.json) {
    console.log(JSON.stringify({
      schemaVersion: "kova.plan.v1",
      generatedAt: new Date().toISOString(),
      platform: platformInfo(),
      scenarios
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

async function scenariosCommand(flags) {
  const [subcommand = "list", id] = flags._;

  if (subcommand === "list") {
    const scenarios = await loadScenarios();
    if (flags.json) {
      console.log(JSON.stringify({
        schemaVersion: "kova.scenarios.list.v1",
        generatedAt: new Date().toISOString(),
        scenarios: scenarios.map((scenario) => ({
          id: scenario.id,
          title: scenario.title,
          objective: scenario.objective,
          tags: scenario.tags,
          phaseCount: scenario.phases.length
        }))
      }, null, 2));
      return;
    }

    for (const scenario of scenarios) {
      console.log(`${scenario.id}: ${scenario.title}`);
    }
    return;
  }

  if (subcommand === "show") {
    const scenarioId = required(id, "scenario id");
    const [scenario] = await loadScenarios(scenarioId);
    if (flags.json) {
      console.log(JSON.stringify({
        schemaVersion: "kova.scenarios.show.v1",
        generatedAt: new Date().toISOString(),
        scenario
      }, null, 2));
      return;
    }

    console.log(`${scenario.id}: ${scenario.title}`);
    console.log(`Objective: ${scenario.objective}`);
    console.log(`Tags: ${scenario.tags.join(", ")}`);
    console.log("Phases:");
    for (const phase of scenario.phases) {
      console.log(`- ${phase.id}: ${phase.title}`);
    }
    return;
  }

  throw new Error(`unknown scenarios command: ${subcommand}`);
}

async function statesCommand(flags) {
  const [subcommand = "list", id] = flags._;

  if (subcommand === "list") {
    const states = await loadStates();
    if (flags.json) {
      console.log(JSON.stringify({
        schemaVersion: "kova.states.list.v1",
        generatedAt: new Date().toISOString(),
        states: states.map((state) => ({
          id: state.id,
          title: state.title,
          objective: state.objective,
          tags: state.tags,
          setupStepCount: state.setup.length
        }))
      }, null, 2));
      return;
    }

    for (const state of states) {
      console.log(`${state.id}: ${state.title}`);
    }
    return;
  }

  if (subcommand === "show") {
    const stateId = required(id, "state id");
    const [state] = await loadStates(stateId);
    if (flags.json) {
      console.log(JSON.stringify({
        schemaVersion: "kova.states.show.v1",
        generatedAt: new Date().toISOString(),
        state
      }, null, 2));
      return;
    }

    console.log(`${state.id}: ${state.title}`);
    console.log(`Objective: ${state.objective}`);
    console.log(`Tags: ${state.tags.join(", ")}`);
    console.log("Setup:");
    if (state.setup.length === 0) {
      console.log("- none");
    } else {
      for (const step of state.setup) {
        console.log(`- ${step.id}: ${step.title} after ${step.afterPhase}`);
      }
    }
    return;
  }

  throw new Error(`unknown states command: ${subcommand}`);
}

async function reportCommand(flags) {
  const [subcommand, reportPath] = flags._;
  const path = required(reportPath, "report path");
  const report = JSON.parse(await readFile(resolveFromCwd(path), "utf8"));

  if (subcommand === "summarize") {
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
    console.log(renderPasteSummary(report));
    return;
  }

  throw new Error(`unknown report command: ${subcommand ?? ""}`);
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
    timeoutMs: Number(flags.timeout_ms ?? 120000)
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
