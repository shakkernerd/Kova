import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { arch, platform, release } from "node:os";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const scenariosDir = join(repoRoot, "scenarios");
const reportsDir = join(repoRoot, "reports");
const schemaVersion = "kova.report.v1";

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

  if (command === "run") {
    await run(flags);
    return;
  }

  throw new Error(`unknown command: ${command}`);
}

function parseFlags(argv) {
  const flags = { _: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith("--")) {
      flags._.push(token);
      continue;
    }

    const [rawKey, inlineValue] = token.slice(2).split("=", 2);
    const key = rawKey.replaceAll("-", "_");

    if (inlineValue !== undefined) {
      flags[key] = inlineValue;
      continue;
    }

    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = true;
    }
  }

  return flags;
}

function printHelp() {
  console.log(`Kova - OpenClaw runtime validation lab

Usage:
  kova doctor
  kova plan [--scenario <id>] [--json]
  kova run --target <selector> [--from <selector>] [--scenario <id>] [--report-dir <path>] [--execute] [--keep-env]

Selectors:
  npm:<version>              Published OpenClaw release
  channel:<name>             Published channel such as stable or beta
  runtime:<name>             Existing OCM runtime name
  local-build:<repo-path>    OpenClaw checkout to build as a release-shaped runtime

Notes:
  Kova uses OCM to create isolated OpenClaw envs and runtimes.
  Kova reports on OpenClaw behavior, not OCM behavior.
  run is dry-run/report-only unless --execute is passed.
`);
}

async function doctor(flags = {}) {
  const checks = [];
  checks.push(checkCommand("node", ["--version"]));
  checks.push(checkCommand("ocm", ["--version"]));

  let ok = true;
  for (const check of checks) {
    if (check.status !== 0) {
      ok = false;
    }
  }

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

function checkCommand(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });

  return {
    command: [command, ...args].join(" "),
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
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
    console.log(`  Phases:`);
    for (const phase of scenario.phases) {
      console.log(`    - ${phase.id}: ${phase.title}`);
    }
    console.log("");
  }
}

async function run(flags) {
  const target = required(flags.target, "--target");
  if (flags.execute === true && !flags.scenario) {
    throw new Error("--execute requires --scenario so real runs stay deliberate");
  }
  const targetPlan = resolveTarget(target, "target");
  const fromPlan = flags.from ? resolveTarget(flags.from, "from") : null;
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
    sourceEnv: flags.source_env,
    runId,
    execute: flags.execute === true,
    keepEnv: flags.keep_env === true,
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
    schemaVersion,
    generatedAt: new Date().toISOString(),
    runId,
    mode: context.execute ? "execution" : "dry-run",
    target,
    from: flags.from ?? null,
    platform: platformInfo(),
    summary: summarizeRecords(records),
    records
  };
  await writeFile(reportPath, renderMarkdownReport(report), "utf8");
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  const mode = context.execute ? "execution" : "dry-run";
  console.log(`Kova ${mode} report written: ${relative(process.cwd(), reportPath)}`);
  console.log(`Kova ${mode} data written: ${relative(process.cwd(), jsonPath)}`);
}

function platformInfo() {
  return {
    os: platform(),
    arch: arch(),
    release: release(),
    node: process.version
  };
}

function summarizeRecords(records) {
  const statuses = {};
  for (const record of records) {
    statuses[record.status] = (statuses[record.status] ?? 0) + 1;
  }

  return {
    total: records.length,
    statuses
  };
}

function validateScenarioRun(scenario, flags) {
  if (scenario.id === "upgrade-existing-user" && flags.execute === true && !flags.source_env) {
    throw new Error("upgrade-existing-user execution requires --source-env <env>");
  }
}

function required(value, name) {
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function resolveFromCwd(path) {
  if (path.startsWith("/")) {
    return path;
  }
  return join(process.cwd(), path);
}

function createRunId() {
  const stamp = new Date().toISOString().replaceAll(":", "").replace(/\.\d+Z$/, "Z");
  return `kova-${stamp}`;
}

function buildDryRunRecord(scenario, context) {
  const envName = `kova-${scenario.id}-${context.runId.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

  return {
    scenario: scenario.id,
    title: scenario.title,
    status: "DRY-RUN",
    target: context.target,
    from: context.from ?? null,
    envName,
    likelyOwner: "OpenClaw",
    objective: scenario.objective,
    thresholds: scenario.thresholds,
    cleanup: context.keepEnv ? "retained" : "planned",
    phases: scenario.phases.map((phase) => ({
      id: phase.id,
      title: phase.title,
      intent: phase.intent,
      commands: materializeCommands(phase.commands ?? [], {
        env: envName,
        target: context.target,
        from: context.from ?? "",
        sourceEnv: context.sourceEnv ?? "",
        startSelector: context.targetPlan.startSelector,
        upgradeSelector: context.targetPlan.upgradeSelector,
        fromUpgradeSelector: context.fromPlan?.upgradeSelector ?? ""
      }),
      evidence: phase.evidence ?? []
    }))
  };
}

async function executeScenario(scenario, context) {
  const envName = `kova-${scenario.id}-${context.runId.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  const record = buildDryRunRecord(scenario, context);
  record.status = "PASS";
  record.startedAt = new Date().toISOString();
  record.phases = [];

  let scenarioFailed = false;

  try {
    const setupResults = await executeTargetSetup(context, envName);
    if (setupResults.length > 0) {
      record.phases.push({
        id: "target-setup",
        title: "Target Runtime Setup",
        intent: "Prepare the target OpenClaw runtime selector for the scenario.",
        commands: setupResults.map((result) => result.command),
        evidence: [],
        results: setupResults
      });
      if (setupResults.some((result) => result.status !== 0)) {
        record.status = "BLOCKED";
        scenarioFailed = true;
      }
    }

    if (!scenarioFailed) {
      for (const phase of scenario.phases) {
        if (phase.id === "cleanup") {
          continue;
        }

        const commands = materializeCommands(phase.commands ?? [], {
          env: envName,
          target: context.target,
          from: context.from ?? "",
          sourceEnv: context.sourceEnv ?? "",
          startSelector: context.targetPlan.startSelector,
          upgradeSelector: context.targetPlan.upgradeSelector,
          fromUpgradeSelector: context.fromPlan?.upgradeSelector ?? ""
        });

        const results = [];
        for (const command of commands) {
          const result = await runCommand(command, { timeoutMs: context.timeoutMs });
          results.push(result);
          if (result.status !== 0) {
            scenarioFailed = true;
            record.status = classifyCommandFailure(result);
            break;
          }
        }

        record.phases.push({
          id: phase.id,
          title: phase.title,
          intent: phase.intent,
          commands,
          evidence: phase.evidence ?? [],
          results
        });

        if (scenarioFailed) {
          break;
        }
      }
    }
  } finally {
    record.finishedAt = new Date().toISOString();
    if (!context.keepEnv) {
      const cleanup = await runCommand(`ocm env destroy ${envName} --yes`, { timeoutMs: context.timeoutMs });
      record.cleanup = cleanup.status === 0 ? "destroyed" : "destroy-failed";
      record.cleanupResult = cleanup;
      if (cleanup.status !== 0 && record.status === "PASS") {
        record.status = "BLOCKED";
      }
    } else {
      record.cleanup = "retained";
    }
  }

  return record;
}

async function executeTargetSetup(context, envName) {
  if (context.targetPlan.kind !== "local-build") {
    return [];
  }

  return [
    await runCommand(`ocm runtime build-local ${context.targetPlan.runtimeName} --repo ${quoteShell(context.targetPlan.repoPath)} --force`, {
      timeoutMs: context.timeoutMs,
      env: { KOVA_ENV_NAME: envName }
    })
  ];
}

function classifyCommandFailure(result) {
  if (result.timedOut) {
    return "FAIL";
  }

  if (result.command.startsWith("ocm start") || result.command.startsWith("ocm runtime build-local")) {
    return "BLOCKED";
  }

  return "FAIL";
}

function runCommand(command, options) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn("zsh", ["-lc", command], {
      cwd: repoRoot,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3000).unref();
    }, options.timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolve({
        command,
        status: timedOut ? 124 : (status ?? 1),
        signal,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout: truncate(stdout),
        stderr: truncate(stderr)
      });
    });
  });
}

function truncate(value, limit = 20000) {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit)}\n[truncated ${value.length - limit} chars]`;
}

function materializeCommands(commands, values) {
  return commands.map((command) =>
    command
      .replaceAll("{env}", values.env)
      .replaceAll("{target}", values.target)
      .replaceAll("{from}", values.from)
      .replaceAll("{sourceEnv}", values.sourceEnv)
      .replaceAll("{startSelector}", values.startSelector)
      .replaceAll("{upgradeSelector}", values.upgradeSelector)
      .replaceAll("{fromUpgradeSelector}", values.fromUpgradeSelector)
  );
}

function resolveTarget(selector, role) {
  const [kind, ...rest] = selector.split(":");
  const value = rest.join(":");

  if (!value) {
    throw new Error(`${role} selector must use kind:value, got ${selector}`);
  }

  if (kind === "npm") {
    return {
      kind,
      value,
      startSelector: `--version ${quoteShell(value)}`,
      upgradeSelector: `--version ${quoteShell(value)}`
    };
  }

  if (kind === "channel") {
    return {
      kind,
      value,
      startSelector: `--channel ${quoteShell(value)}`,
      upgradeSelector: `--channel ${quoteShell(value)}`
    };
  }

  if (kind === "runtime") {
    return {
      kind,
      value,
      startSelector: `--runtime ${quoteShell(value)}`,
      upgradeSelector: `--runtime ${quoteShell(value)}`
    };
  }

  if (kind === "local-build") {
    const runtimeName = `kova-local-${Date.now()}`;
    return {
      kind,
      value,
      repoPath: value,
      runtimeName,
      startSelector: `--runtime ${quoteShell(runtimeName)}`,
      upgradeSelector: `--runtime ${quoteShell(runtimeName)}`
    };
  }

  throw new Error(`unsupported ${role} selector kind: ${kind}`);
}

function quoteShell(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function renderMarkdownReport(report) {
  const lines = [
    "# Kova OpenClaw Runtime Report",
    "",
    `Generated: ${report.generatedAt}`,
    `Run ID: \`${report.runId}\``,
    `Mode: ${report.mode}`,
    `Platform: ${report.platform.os} ${report.platform.release} (${report.platform.arch}) · ${report.platform.node}`,
    "",
    "## Summary",
    "",
    `- Total scenarios: ${report.summary.total}`,
    ...Object.entries(report.summary.statuses).map(([status, count]) => `- ${status}: ${count}`),
    ""
  ];

  for (const record of report.records) {
    lines.push(`## ${record.title}`);
    lines.push("");
    lines.push(`- Scenario: \`${record.scenario}\``);
    lines.push(`- Result: ${record.status}`);
    lines.push(`- OpenClaw target: \`${record.target}\``);
    if (record.from) {
      lines.push(`- OpenClaw source: \`${record.from}\``);
    }
    lines.push(`- Harness env: \`${record.envName}\``);
    lines.push(`- Likely owner on failure: ${record.likelyOwner}`);
    lines.push(`- Objective: ${record.objective}`);
    lines.push("");
    lines.push("### Phases");
    lines.push("");

    for (const phase of record.phases) {
      lines.push(`#### ${phase.title}`);
      lines.push("");
      lines.push(phase.intent);
      lines.push("");
      if (phase.commands.length > 0) {
        lines.push("Commands:");
        lines.push("");
        for (const command of phase.commands) {
          lines.push(`- \`${command}\``);
        }
        lines.push("");
      }
      if (phase.evidence.length > 0) {
        lines.push("Evidence to capture:");
        lines.push("");
        for (const item of phase.evidence) {
          lines.push(`- ${item}`);
        }
        lines.push("");
      }
      if (phase.results?.length > 0) {
        lines.push("Results:");
        lines.push("");
        for (const result of phase.results) {
          lines.push(`- \`${result.command}\``);
          lines.push(`  - status: ${result.status}${result.timedOut ? " (timeout)" : ""}`);
          lines.push(`  - duration: ${result.durationMs}ms`);
          const includeOutput = result.status !== 0 || result.timedOut;
          if (includeOutput && result.stdout.trim()) {
            lines.push("  - stdout:");
            lines.push("");
            lines.push(indentFence(result.stdout));
            lines.push("");
          }
          if (includeOutput && result.stderr.trim()) {
            lines.push("  - stderr:");
            lines.push("");
            lines.push(indentFence(result.stderr));
            lines.push("");
          }
        }
        lines.push("");
      }
    }

    lines.push("### Cleanup");
    lines.push("");
    lines.push(`- ${record.cleanup ?? "not-run"}`);
    if (record.cleanupResult) {
      lines.push(`- cleanup command: \`${record.cleanupResult.command}\``);
      lines.push(`- cleanup status: ${record.cleanupResult.status}`);
      lines.push(`- cleanup duration: ${record.cleanupResult.durationMs}ms`);
      if (record.cleanupResult.stderr.trim()) {
        lines.push("");
        lines.push("Cleanup stderr:");
        lines.push("");
        lines.push(indentFence(record.cleanupResult.stderr));
      }
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function indentFence(value) {
  return ["  ```text", ...value.trim().split("\n").slice(0, 80).map((line) => `  ${line}`), "  ```"].join("\n");
}

async function loadScenarios(selectedId) {
  const names = await readdir(scenariosDir);
  const paths = names.filter((name) => name.endsWith(".json")).sort();
  const scenarios = [];

  for (const name of paths) {
    const raw = await readFile(join(scenariosDir, name), "utf8");
    scenarios.push(JSON.parse(raw));
  }

  const filtered = selectedId ? scenarios.filter((scenario) => scenario.id === selectedId) : scenarios;
  if (filtered.length === 0) {
    throw new Error(`no scenario found for ${selectedId}`);
  }
  return filtered;
}
