import { runCommand } from "./commands.mjs";
import { materializeCommands } from "./scenarios.mjs";
import { quoteShell } from "./commands.mjs";
import { collectEnvMetrics } from "./metrics.mjs";
import { evaluateRecord } from "./evaluator.mjs";

export function createRunId() {
  const stamp = new Date().toISOString().replaceAll(":", "").replace(/\.\d+Z$/, "Z");
  return `kova-${stamp}`;
}

export function buildDryRunRecord(scenario, context) {
  const envName = envNameFor(scenario.id, context.runId);

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
    phases: scenario.phases.map((phase) => ({
      id: phase.id,
      title: phase.title,
      intent: phase.intent,
      commands: materializeCommands(phase.commands ?? [], commandValues(context, envName)),
      evidence: phase.evidence ?? []
    }))
  };
}

export async function executeScenario(scenario, context) {
  const envName = envNameFor(scenario.id, context.runId);
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

        const commands = materializeCommands(phase.commands ?? [], commandValues(context, envName));
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
          results,
          metrics: await collectEnvMetrics(envName, { timeoutMs: context.timeoutMs })
        });

        const statePhase = await executeStateSetupAfterPhase(context, envName, phase.id);
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
    record.finalMetrics = await collectEnvMetrics(envName, { timeoutMs: context.timeoutMs });
    evaluateRecord(record, scenario);

    const shouldRetain = context.keepEnv || (context.retainOnFailure && record.status !== "PASS");
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

async function executeStateSetupAfterPhase(context, envName, phaseId) {
  const steps = (context.state?.setup ?? []).filter((step) => step.afterPhase === phaseId);
  if (steps.length === 0) {
    return null;
  }

  const results = [];
  const commands = [];
  const evidence = [];

  for (const step of steps) {
    const stepCommands = materializeCommands(step.commands ?? [], commandValues(context, envName));
    commands.push(...stepCommands);
    evidence.push(...(step.evidence ?? []));

    for (const command of stepCommands) {
      results.push(await runCommand(command, { timeoutMs: context.timeoutMs }));
    }
  }

  return {
    id: `state-${phaseId}`,
    title: `State Setup After ${phaseId}`,
    intent: `Apply Kova state '${context.state.id}' setup after scenario phase '${phaseId}'.`,
    commands,
    evidence,
    results,
    metrics: await collectEnvMetrics(envName, { timeoutMs: context.timeoutMs })
  };
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

function commandValues(context, envName) {
  return {
    env: envName,
    target: context.target,
    from: context.from ?? "",
    sourceEnv: context.sourceEnv ?? "",
    startSelector: context.targetPlan.startSelector,
    upgradeSelector: context.targetPlan.upgradeSelector,
    fromUpgradeSelector: context.fromPlan?.upgradeSelector ?? ""
  };
}

function envNameFor(scenarioId, runId) {
  return `kova-${scenarioId}-${runId.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
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
