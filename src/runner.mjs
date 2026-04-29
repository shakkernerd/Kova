import { runCommand } from "./commands.mjs";
import { materializeCommands } from "./scenarios.mjs";
import { quoteShell } from "./commands.mjs";
import { collectEnvMetrics } from "./metrics.mjs";
import { evaluateRecord } from "./evaluator.mjs";
import { artifactsDir } from "./paths.mjs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export function createRunId() {
  const stamp = new Date().toISOString().replaceAll(":", "").replace(/\.\d+Z$/, "Z");
  return `kova-${stamp}`;
}

export function buildDryRunRecord(scenario, context) {
  const envName = envNameFor(scenario.id, context.state?.id, context.runId);
  const artifactDir = join(artifactsDir, context.runId, envName);

  return {
    scenario: scenario.id,
    title: scenario.title,
    status: "DRY-RUN",
    target: context.target,
    from: context.from ?? null,
    state: stateSummary(context.state),
    envName,
    likelyOwner: "OpenClaw",
    objective: scenario.objective,
    thresholds: scenario.thresholds,
    cleanup: context.keepEnv ? "retained" : "planned",
    phases: buildPlannedPhases(scenario, context, envName, artifactDir)
  };
}

export function buildSkippedRecord(scenario, context, reason) {
  const record = buildDryRunRecord(scenario, context);
  record.status = "SKIPPED";
  record.skipReason = reason;
  record.cleanup = "not-needed";
  record.phases = [];
  return record;
}

export async function executeScenario(scenario, context) {
  const envName = envNameFor(scenario.id, context.state?.id, context.runId);
  const artifactDir = join(artifactsDir, context.runId, envName);
  const record = buildDryRunRecord(scenario, context);
  record.status = "PASS";
  record.startedAt = new Date().toISOString();
  record.artifactDir = artifactDir;
  record.phases = [];

  let scenarioFailed = false;

  try {
    await mkdir(artifactDir, { recursive: true });
    await mkdir(join(artifactDir, "openclaw"), { recursive: true });
    if (context.nodeProfile === true) {
      await mkdir(join(artifactDir, "node-profiles"), { recursive: true });
    }
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
      const preparePhase = await executeStateLifecycleSteps(context, envName, scenario, "prepare", context.state?.prepare ?? [], artifactDir);
      if (preparePhase) {
        record.phases.push(preparePhase);
        if (preparePhase.results.some((result) => result.status !== 0)) {
          scenarioFailed = true;
          record.status = "FAIL";
        }
      }
    }

    if (!scenarioFailed) {
      for (const phase of scenario.phases) {
        if (phase.id === "cleanup") {
          continue;
        }

        const commands = materializeCommands(phase.commands ?? [], commandValues(context, envName));
        const results = [];
        for (const [commandIndex, command] of commands.entries()) {
          const result = await runScenarioCommand(command, context, envName, artifactDir, phase.id, commandIndex);
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
          results,
          metrics: await collectEnvMetrics(envName, metricOptions(context, scenario, phase, artifactDir))
        });

        const statePhase = await executeStateSetupAfterPhase(context, envName, phase.id, scenario, artifactDir);
        if (statePhase) {
          record.phases.push(statePhase);
          if (statePhase.results.some((result) => result.status !== 0)) {
            scenarioFailed = true;
            record.status = "FAIL";
          }
        }

        if (scenarioFailed) {
          break;
        }
      }
    }
  } finally {
    record.finishedAt = new Date().toISOString();
    record.finalMetrics = await collectEnvMetrics(envName, metricOptions(context, scenario, null, artifactDir));
    evaluateRecord(record, scenario);

    const shouldRetain = context.keepEnv || (context.retainOnFailure && record.status !== "PASS");
    if (!shouldRetain) {
      const cleanupPhase = await executeStateLifecycleSteps(context, envName, scenario, "cleanup", context.state?.cleanup ?? [], artifactDir);
      if (cleanupPhase) {
        record.phases.push(cleanupPhase);
        if (cleanupPhase.results.some((result) => result.status !== 0) && record.status === "PASS") {
          record.status = "BLOCKED";
        }
      }
    }
    if (!shouldRetain) {
      const cleanup = await runCommand(`ocm env destroy ${envName} --yes`, { timeoutMs: context.timeoutMs });
      record.cleanup = cleanup.status === 0 ? "destroyed" : "destroy-failed";
      record.cleanupResult = cleanup;
      if (cleanup.status !== 0 && record.status === "PASS") {
        record.status = "BLOCKED";
      }
    } else {
      record.cleanup = "retained";
      record.retainedReason = context.keepEnv ? "keep-env" : "failure";
    }
  }

  return record;
}

async function executeStateSetupAfterPhase(context, envName, phaseId, scenario, artifactDir) {
  const steps = (context.state?.setup ?? []).filter((step) => stateStepMatchesPhase(step, phaseId));
  if (steps.length === 0) {
    return null;
  }

  return executeStateLifecycleSteps(context, envName, scenario, `state-${phaseId}`, steps, artifactDir, phaseId);
}

function buildPlannedPhases(scenario, context, envName, artifactDir) {
  const phases = [];
  const targetSetupPhase = buildTargetSetupPhase(context, envName);
  if (targetSetupPhase) {
    phases.push(targetSetupPhase);
  }

  const preparePhase = buildStateLifecyclePhase(context, envName, scenario, "prepare", context.state?.prepare ?? [], artifactDir);
  if (preparePhase) {
    phases.push(preparePhase);
  }

  for (const phase of scenario.phases) {
    if (phase.id === "cleanup") {
      continue;
    }
    phases.push({
      id: phase.id,
      title: phase.title,
      intent: phase.intent,
      commands: materializeCommands(phase.commands ?? [], commandValues(context, envName, artifactDir)),
      evidence: phase.evidence ?? []
    });

    const statePhase = buildStateLifecyclePhase(
      context,
      envName,
      scenario,
      `state-${phase.id}`,
      (context.state?.setup ?? []).filter((step) => stateStepMatchesPhase(step, phase.id)),
      artifactDir,
      phase.id
    );
    if (statePhase) {
      phases.push(statePhase);
    }
  }

  if (!context.keepEnv) {
    const cleanupPhase = buildStateLifecyclePhase(context, envName, scenario, "cleanup", context.state?.cleanup ?? [], artifactDir);
    if (cleanupPhase) {
      phases.push(cleanupPhase);
    }
    phases.push({
      id: "env-cleanup",
      title: "Environment Cleanup",
      intent: "Destroy the disposable Kova env after the scenario finishes.",
      commands: [`ocm env destroy ${quoteShell(envName)} --yes`],
      evidence: ["temporary env destroyed"]
    });
  }

  return phases;
}

function buildTargetSetupPhase(context, envName) {
  if (context.targetPlan.kind !== "local-build") {
    return null;
  }

  return {
    id: "target-setup",
    title: "Target Runtime Setup",
    intent: "Prepare the target OpenClaw runtime selector for the scenario.",
    commands: [targetSetupCommand(context.targetPlan)],
    evidence: [`local-build runtime ${context.targetPlan.runtimeName}`, `kova env ${envName}`]
  };
}

function buildStateLifecyclePhase(context, envName, scenario, kind, steps, artifactDir, phaseId = null) {
  if (!Array.isArray(steps) || steps.length === 0) {
    return null;
  }

  const commands = [];
  const evidence = [];
  for (const step of steps) {
    commands.push(...materializeCommands(step.commands ?? [], commandValues(context, envName, artifactDir)));
    evidence.push(...(step.evidence ?? []));
  }

  return {
    id: kind,
    title: stateLifecycleTitle(context.state?.id, kind, phaseId),
    intent: stateLifecycleIntent(context.state?.id, kind, phaseId),
    commands,
    evidence,
    scenario: scenario.id
  };
}

async function executeStateLifecycleSteps(context, envName, scenario, kind, steps, artifactDir, phaseId = null) {
  if (!Array.isArray(steps) || steps.length === 0) {
    return null;
  }

  const results = [];
  const commands = [];
  const evidence = [];

  for (const step of steps) {
    const stepCommands = materializeCommands(step.commands ?? [], commandValues(context, envName, artifactDir));
    commands.push(...stepCommands);
    evidence.push(...(step.evidence ?? []));

    for (const [commandIndex, command] of stepCommands.entries()) {
      results.push(await runScenarioCommand(command, context, envName, artifactDir, kind, commandIndex));
    }
  }

  return {
    id: kind,
    title: stateLifecycleTitle(context.state?.id, kind, phaseId),
    intent: stateLifecycleIntent(context.state?.id, kind, phaseId),
    commands,
    evidence,
    results,
    metrics: await collectEnvMetrics(envName, metricOptions(context, scenario, { id: phaseId }, artifactDir))
  };
}

function stateLifecycleTitle(stateId, kind, phaseId) {
  if (kind === "prepare") {
    return `State Prepare (${stateId})`;
  }
  if (kind === "cleanup") {
    return `State Cleanup (${stateId})`;
  }
  return `State Setup After ${phaseId}`;
}

function stateLifecycleIntent(stateId, kind, phaseId) {
  if (kind === "prepare") {
    return `Prepare Kova state '${stateId}' before scenario phases.`;
  }
  if (kind === "cleanup") {
    return `Clean up Kova state '${stateId}' fixture artifacts before env destruction.`;
  }
  return `Apply Kova state '${stateId}' setup after scenario phase '${phaseId}'.`;
}

function stateStepMatchesPhase(step, phaseId) {
  if (Array.isArray(step.afterPhases)) {
    return step.afterPhases.includes(phaseId);
  }
  return step.afterPhase === phaseId;
}

function metricOptions(context, scenario, phase, artifactDir) {
  return {
    timeoutMs: context.timeoutMs,
    healthSamples: context.healthSamples,
    healthIntervalMs: context.healthIntervalMs,
    readinessTimeoutMs: readinessTimeoutForPhase(scenario, phase),
    readinessIntervalMs: context.readinessIntervalMs,
    heapSnapshot: context.heapSnapshot,
    artifactDir
  };
}

function readinessTimeoutForPhase(scenario, phase) {
  const thresholds = scenario?.thresholds ?? {};
  const defaultMs = thresholds.gatewayReadyMs ?? 30000;
  if (!phase) {
    return 0;
  }
  if (phase.id === "cold-start" || phase.id === "provision" || phase.id === "baseline" || phase.id === "gateway" || phase.id === "start") {
    return thresholds.coldReadyMs ?? thresholds.gatewayReadyMs ?? defaultMs;
  }
  if (phase.id === "warm-restart" || phase.id === "restart") {
    return thresholds.warmReadyMs ?? thresholds.restartReadyMs ?? thresholds.gatewayReadyMs ?? defaultMs;
  }
  if (phase.id === "upgrade" || phase.id === "post-upgrade" || phase.id === "source-runtime") {
    return thresholds.gatewayReadyMs ?? defaultMs;
  }
  return 0;
}

async function executeTargetSetup(context, envName) {
  if (context.targetPlan.kind !== "local-build") {
    return [];
  }
  if (context.targetSetup?.completed) {
    return [];
  }

  const results = [
    await runCommand(targetSetupCommand(context.targetPlan), {
      timeoutMs: context.timeoutMs,
      env: { KOVA_ENV_NAME: envName }
    })
  ];
  if (results.every((result) => result.status === 0) && context.targetSetup) {
    context.targetSetup.completed = true;
  }
  return results;
}

function targetSetupCommand(targetPlan) {
  return `ocm runtime build-local ${quoteShell(targetPlan.runtimeName)} --repo ${quoteShell(targetPlan.repoPath)} --force`;
}

function runScenarioCommand(command, context, envName, artifactDir, phaseId, commandIndex) {
  return runCommand(command, {
    timeoutMs: context.timeoutMs,
    env: diagnosticsEnv(context, envName, artifactDir),
    resourceSample: context.resourceSampling === false ? null : {
      envName,
      intervalMs: context.resourceSampleIntervalMs,
      artifactPath: join(artifactDir, "resource-samples", `${safeSegment(phaseId)}-${commandIndex + 1}.jsonl`)
    }
  });
}

function diagnosticsEnv(context, envName, artifactDir) {
  if (context.openclawDiagnostics === false) {
    return {};
  }

  const env = {
    OPENCLAW_DIAGNOSTICS: "1",
    OPENCLAW_DIAGNOSTICS_RUN_ID: context.runId,
    OPENCLAW_DIAGNOSTICS_ENV: envName,
    OPENCLAW_DIAGNOSTICS_TIMELINE_PATH: join(artifactDir, "openclaw", "timeline.jsonl"),
    OPENCLAW_DIAGNOSTICS_EVENT_LOOP: "1"
  };

  if (context.nodeProfile === true) {
    const profileDir = join(artifactDir, "node-profiles");
    env.KOVA_NODE_PROFILE_DIR = profileDir;
    env.NODE_OPTIONS = mergeNodeOptions(process.env.NODE_OPTIONS, [
      "--cpu-prof",
      `--cpu-prof-dir=${quoteNodeOptionValue(profileDir)}`,
      "--heap-prof",
      `--heap-prof-dir=${quoteNodeOptionValue(profileDir)}`,
      "--trace-event-categories=node.perf,node.async_hooks,v8",
      `--trace-event-file-pattern=${quoteNodeOptionValue(join(profileDir, "node-trace-${pid}.json"))}`
    ]);
  }

  return env;
}

function mergeNodeOptions(existing, additions) {
  return [existing, ...additions].filter(Boolean).join(" ");
}

function quoteNodeOptionValue(value) {
  const string = String(value);
  if (!/\s|"/.test(string)) {
    return string;
  }
  return `"${string.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function commandValues(context, envName, artifactDir = "") {
  return {
    env: quoteShell(envName),
    target: context.target,
    from: context.from ?? "",
    sourceEnv: quoteShell(context.sourceEnv ?? ""),
    artifactDir,
    startSelector: context.targetPlan.startSelector,
    upgradeSelector: context.targetPlan.upgradeSelector,
    fromUpgradeSelector: context.fromPlan?.upgradeSelector ?? ""
  };
}

function safeSegment(value) {
  return String(value ?? "phase").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "phase";
}

function envNameFor(scenarioId, stateId, runId) {
  const stateSegment = stateId ? `${stateId}-` : "";
  return `kova-${scenarioId}-${stateSegment}${runId.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

function stateSummary(state) {
  if (!state) {
    return null;
  }

  return {
    id: state.id,
    title: state.title,
    objective: state.objective
  };
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
