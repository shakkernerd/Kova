import { runCommand } from "./commands.mjs";
import {
  buildAuthCleanupPhase,
  buildAuthPreparePhase,
  buildAuthSetupPhase,
  scenarioAuthPolicy
} from "./auth.mjs";
import { materializeCommands } from "./registries/scenarios.mjs";
import { quoteShell } from "./commands.mjs";
import { captureProcessSnapshot, diffProcessSnapshots } from "./collectors/resources.mjs";
import { collectEnvMetrics, collectNodeProfileMetrics } from "./metrics.mjs";
import { collectorArtifactDirs, prepareCollectorArtifactDirs } from "./collectors/artifacts.mjs";
import { collectProviderEvidence } from "./collectors/provider.mjs";
import { evaluateRecord } from "./evaluator.mjs";
import { artifactsDir } from "./paths.mjs";
import { repoRoot } from "./paths.mjs";
import { assertKovaEnvName, assertSafeScenarioCommand } from "./safety.mjs";
import { dirname, join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

export function createRunId() {
  const stamp = new Date().toISOString().replaceAll(":", "").replace(/\.\d+Z$/, "Z");
  return `kova-${stamp}`;
}

export function buildDryRunRecord(scenario, context) {
  const envName = envNameFor(scenario.id, context.state?.id, context.runId, context.repeat);
  const artifactDir = join(artifactsDir, context.runId, envName);
  const authPolicy = scenarioAuthPolicy(context, scenario, context.state);

  return {
    scenario: scenario.id,
    surface: scenario.surface,
    title: scenario.title,
    status: "DRY-RUN",
    target: context.target,
    from: context.from ?? null,
    state: stateSummary(context.state),
    repeat: repeatSummary(context.repeat),
    envName,
    likelyOwner: "OpenClaw",
    objective: scenario.objective,
    thresholds: scenario.thresholds,
    cleanup: context.keepEnv ? "retained" : "planned",
    auth: authPolicy.summary,
    profiling: profilingSummary(context),
    collectorArtifactDirs: collectorArtifactDirs(artifactDir),
    phases: buildPlannedPhases(scenario, context, envName, artifactDir, authPolicy)
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
  const envName = envNameFor(scenario.id, context.state?.id, context.runId, context.repeat);
  assertKovaEnvName(envName, "generated env");
  const artifactDir = join(artifactsDir, context.runId, envName);
  const record = buildDryRunRecord(scenario, context);
  const authPolicy = scenarioAuthPolicy(context, scenario, context.state);
  record.status = "PASS";
  record.startedAt = new Date().toISOString();
  record.artifactDir = artifactDir;
  record.collectorArtifactDirs = collectorArtifactDirs(artifactDir);
  record.phases = [];

  let scenarioFailed = false;

  try {
    record.collectorArtifactDirs = await prepareCollectorArtifactDirs(artifactDir, context);
    const setupResults = await executeTargetSetup(context, envName, artifactDir);
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
      const authPreparePhase = await executeAuthPhase(
        buildAuthPreparePhase(authPolicy, artifactDir),
        context,
        envName,
        artifactDir,
        authPolicy
      );
      if (authPreparePhase) {
        record.phases.push(authPreparePhase);
        if (authPreparePhase.results.some((result) => result.status !== 0)) {
          record.status = "BLOCKED";
          scenarioFailed = true;
        }
      }
    }

    if (!scenarioFailed) {
      const preparePhase = await executeStateLifecycleSteps(context, envName, scenario, "prepare", context.state?.prepare ?? [], artifactDir, null, authPolicy);
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
          const result = await runScenarioCommand(command, context, envName, artifactDir, phase.id, commandIndex, authPolicy);
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
          expectedAgentFailure: phase.expectedAgentFailure === true,
          commands,
          evidence: phase.evidence ?? [],
          results,
          metrics: await collectEnvMetrics(envName, metricOptions(context, scenario, phase, artifactDir))
        });

        const authSetupPhase = shouldApplyAuthAfterPhase(phase, authPolicy, record)
          ? await executeAuthPhase(buildAuthSetupPhase(authPolicy, envName, artifactDir), context, envName, artifactDir, authPolicy)
          : null;
        if (authSetupPhase) {
          record.phases.push(authSetupPhase);
          record.auth = authPolicy.summary;
          record.auth.applied = authSetupPhase.results.every((result) => result.status === 0);
          if (authSetupPhase.results.some((result) => result.status !== 0)) {
            scenarioFailed = true;
            record.status = "BLOCKED";
          }
        }
        if (scenarioFailed) {
          break;
        }

        const statePhase = await executeStateSetupAfterPhase(context, envName, phase.id, scenario, artifactDir, authPolicy);
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
    record.providerEvidence = await collectProviderEvidence(artifactDir, { authPolicy });
    evaluateRecord(record, scenario, evaluatorContext(context, scenario));

    if (shouldCaptureFailureDiagnostics(record, context)) {
      record.failureDiagnostics = await collectEnvMetrics(envName, {
        ...metricOptions(context, scenario, null, artifactDir),
        readinessTimeoutMs: 0,
        heapSnapshot: true,
        diagnosticReport: true
      });
    }

    const shouldRetain = context.keepEnv || (context.retainOnFailure && record.status !== "PASS");
    if (!shouldRetain) {
      const authCleanupPhase = await executeAuthPhase(
        buildAuthCleanupPhase(authPolicy, artifactDir),
        context,
        envName,
        artifactDir,
        authPolicy
      );
      if (authCleanupPhase) {
        record.phases.push(authCleanupPhase);
        if (authCleanupPhase.results.some((result) => result.status !== 0) && record.status === "PASS") {
          record.status = "BLOCKED";
        }
      }
      const cleanupPhase = await executeStateLifecycleSteps(context, envName, scenario, "cleanup", context.state?.cleanup ?? [], artifactDir, null, authPolicy);
      if (cleanupPhase) {
        record.phases.push(cleanupPhase);
        if (cleanupPhase.results.some((result) => result.status !== 0) && record.status === "PASS") {
          record.status = "BLOCKED";
        }
      }
    }
    if (!shouldRetain) {
      const cleanup = await runCleanupCommand(`ocm env destroy ${quoteShell(envName)} --yes`, { timeoutMs: context.timeoutMs });
      record.cleanup = classifyEnvDestroyCleanup(cleanup);
      record.cleanupResult = cleanup;
      if (record.cleanup === "destroy-failed" && record.status === "PASS") {
        record.status = "BLOCKED";
      }
    } else {
      record.cleanup = "retained";
      record.retainedReason = context.keepEnv ? "keep-env" : "failure";
    }

    if (context.nodeProfile === true || context.deepProfile === true) {
      record.postCleanupNodeProfiles = await collectNodeProfileMetrics(artifactDir);
      record.finalMetrics = record.finalMetrics ?? {};
      record.finalMetrics.nodeProfiles = record.postCleanupNodeProfiles;
      attachNodeProfileMeasurements(record);
    }

    evaluateRecord(record, scenario, evaluatorContext(context, scenario));
  }

  return record;
}

function shouldCaptureFailureDiagnostics(record, context) {
  if (!(context.deepProfile === true || context.profileOnFailure === true)) {
    return false;
  }
  if (record.status === "PASS") {
    return false;
  }
  return record.cleanup !== "retained";
}

function attachNodeProfileMeasurements(record) {
  if (!record.measurements) {
    record.measurements = {};
  }
  const profiles = record.postCleanupNodeProfiles;
  if (!profiles) {
    return;
  }
  const topCpu = profiles.cpuProfileSummary?.topFunctions?.[0];
  const topHeap = profiles.heapProfileSummary?.topFunctions?.[0];
  record.measurements.nodeCpuProfileCount = profiles.cpuProfileCount ?? record.measurements.nodeCpuProfileCount ?? 0;
  record.measurements.nodeHeapProfileCount = profiles.heapProfileCount ?? record.measurements.nodeHeapProfileCount ?? 0;
  record.measurements.nodeTraceEventCount = profiles.traceEventCount ?? record.measurements.nodeTraceEventCount ?? 0;
  record.measurements.nodeProfileArtifactBytes = profiles.artifactBytes ?? record.measurements.nodeProfileArtifactBytes ?? 0;
  record.measurements.nodeProfileTopFunction = topCpu?.functionName ?? record.measurements.nodeProfileTopFunction ?? null;
  record.measurements.nodeProfileTopFunctionMs = topCpu?.selfMs ?? record.measurements.nodeProfileTopFunctionMs ?? null;
  record.measurements.nodeProfileTopFunctionUrl = topCpu?.url ?? record.measurements.nodeProfileTopFunctionUrl ?? null;
  record.measurements.nodeHeapTopFunction = topHeap?.functionName ?? record.measurements.nodeHeapTopFunction ?? null;
  record.measurements.nodeHeapTopFunctionMb = topHeap?.selfSizeMb ?? record.measurements.nodeHeapTopFunctionMb ?? null;
  record.measurements.nodeHeapTopFunctionUrl = topHeap?.url ?? record.measurements.nodeHeapTopFunctionUrl ?? null;
}

function profilingSummary(context) {
  const enabled = context.nodeProfile === true ||
    context.deepProfile === true ||
    context.heapSnapshot === true ||
    context.diagnosticReport === true ||
    context.profileOnFailure === true;
  return {
    schemaVersion: "kova.profiling.v1",
    enabled,
    deepProfile: context.deepProfile === true,
    nodeProfile: context.nodeProfile === true,
    heapSnapshot: context.heapSnapshot === true,
    diagnosticReport: context.diagnosticReport === true,
    profileOnFailure: context.profileOnFailure === true,
    affectsResourceMeasurements: enabled,
    baselineEligible: !enabled,
    interpretation: enabled
      ? "instrumented run; CPU/RSS can include profiler and diagnostic overhead"
      : "normal user-path resource measurements"
  };
}

function classifyEnvDestroyCleanup(result) {
  if (result.status === 0) {
    return "destroyed";
  }

  const output = `${result.stdout}\n${result.stderr}`;
  if (/\benvironment\b[\s\S]*\bdoes not exist\b/i.test(output) || /\bnot found\b/i.test(output)) {
    return "already-absent";
  }

  return "destroy-failed";
}

async function runCleanupCommand(command, options) {
  const attempts = [];
  const delays = [0, 1000, 2000];
  for (const [index, delayMs] of delays.entries()) {
    if (delayMs > 0) {
      await sleep(delayMs);
    }
    const result = await runCommand(command, options);
    attempts.push(result);
    if (result.status === 0 || !isRetryableCleanupFailure(result) || index === delays.length - 1) {
      return {
        ...result,
        attempts: attempts.map(summarizeAttempt)
      };
    }
  }
}

function isRetryableCleanupFailure(result) {
  if (result.timedOut) {
    return true;
  }
  const output = `${result.stdout}\n${result.stderr}`;
  return /busy|running|shutting down|in use|resource temporarily unavailable|timed out|timeout|econnrefused|connection refused/i.test(output);
}

function summarizeAttempt(result) {
  return {
    status: result.status,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function executeStateSetupAfterPhase(context, envName, phaseId, scenario, artifactDir, authPolicy) {
  const steps = (context.state?.setup ?? []).filter((step) => stateStepMatchesPhase(step, phaseId));
  if (steps.length === 0) {
    return null;
  }

  return executeStateLifecycleSteps(context, envName, scenario, `state-${phaseId}`, steps, artifactDir, phaseId, authPolicy);
}

function buildPlannedPhases(scenario, context, envName, artifactDir, authPolicy) {
  const phases = [];
  const targetSetupPhase = buildTargetSetupPhase(context, envName);
  if (targetSetupPhase) {
    phases.push(targetSetupPhase);
  }

  const authPreparePhase = buildAuthPreparePhase(authPolicy, artifactDir);
  if (authPreparePhase) {
    phases.push(authPreparePhase);
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
      expectedAgentFailure: phase.expectedAgentFailure === true,
      commands: materializeCommands(phase.commands ?? [], commandValues(context, envName, artifactDir)),
      evidence: phase.evidence ?? []
    });

    if (phaseSupportsAuthSetup(phase, authPolicy) && !phases.some((planned) => planned.id === "auth-setup")) {
      const authSetupPhase = buildAuthSetupPhase(authPolicy, envName, artifactDir);
      if (authSetupPhase) {
        phases.push(authSetupPhase);
      }
    }

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
    const authCleanupPhase = buildAuthCleanupPhase(authPolicy, artifactDir);
    if (authCleanupPhase) {
      phases.push(authCleanupPhase);
    }
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

async function executeStateLifecycleSteps(context, envName, scenario, kind, steps, artifactDir, phaseId = null, authPolicy = null) {
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
      results.push(await runScenarioCommand(command, context, envName, artifactDir, kind, commandIndex, authPolicy));
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

async function executeAuthPhase(phase, context, envName, artifactDir, authPolicy) {
  if (!phase) {
    return null;
  }
  const results = [];
  for (const [commandIndex, command] of phase.commands.entries()) {
    results.push(await runScenarioCommand(command, context, envName, artifactDir, phase.id, commandIndex, authPolicy));
  }
  return {
    ...phase,
    results,
    metrics: await collectEnvMetrics(envName, metricOptions(context, null, { id: phase.id }, artifactDir))
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
  const readinessThresholdMs = readinessThresholdForPhase(scenario, phase);
  return {
    timeoutMs: context.timeoutMs,
    healthSamples: context.healthSamples,
    healthIntervalMs: context.healthIntervalMs,
    readinessThresholdMs,
    readinessTimeoutMs: readinessHardTimeoutForPhase(scenario, phase, readinessThresholdMs),
    readinessIntervalMs: context.readinessIntervalMs,
    heapSnapshot: context.heapSnapshot === true && context.deepProfile !== true,
    diagnosticReport: false,
    artifactDir,
    collectorArtifactDirs: collectorArtifactDirs(artifactDir)
  };
}

function readinessThresholdForPhase(scenario, phase) {
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

function readinessHardTimeoutForPhase(scenario, phase, thresholdMs) {
  if (!phase || thresholdMs <= 0) {
    return 0;
  }
  const thresholds = scenario?.thresholds ?? {};
  const explicit = thresholds.gatewayReadyHardTimeoutMs ?? thresholds.readinessHardTimeoutMs;
  if (typeof explicit === "number") {
    return Math.max(explicit, thresholdMs);
  }
  return Math.max(thresholdMs * 3, thresholdMs + 30000);
}

async function executeTargetSetup(context, envName, artifactDir) {
  if (context.targetPlan.kind !== "local-build") {
    return [];
  }
  if (context.targetSetup?.completed) {
    return [];
  }

  const results = [
    await runCommand(targetSetupCommand(context.targetPlan), {
      timeoutMs: context.timeoutMs,
      env: { KOVA_ENV_NAME: envName },
      resourceSample: context.resourceSampling === false ? null : {
        envName,
        intervalMs: context.resourceSampleIntervalMs,
        processRoles: context.processRoles ?? [],
        artifactPath: join(collectorArtifactDirs(artifactDir).resourceSamples, "target-setup-1.jsonl")
      }
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

async function runScenarioCommand(command, context, envName, artifactDir, phaseId, commandIndex, authPolicy = null) {
  assertSafeScenarioCommand(command, context, envName);
  const agentCommand = isAgentMessageCommand(command);
  const snapshotOptions = {
    envName,
    processRoles: context.processRoles ?? [],
    rootCommand: command
  };
  const snapshotBase = join(collectorArtifactDirs(artifactDir).processSnapshots, `${safeSegment(phaseId)}-${commandIndex + 1}`);
  const beforeSnapshot = agentCommand ? captureProcessSnapshot(snapshotOptions) : null;
  if (beforeSnapshot) {
    await writeJsonArtifact(`${snapshotBase}-before.json`, beforeSnapshot);
  }
  const result = await runCommand(command, {
    timeoutMs: context.timeoutMs,
    env: {
      ...diagnosticsEnv(context, envName, artifactDir),
      ...(authPolicy?.commandEnv ?? {})
    },
    redactValues: authPolicy?.redactionValues ?? context.auth?.redactionValues ?? [],
    resourceSample: context.resourceSampling === false ? null : {
      envName,
      intervalMs: context.resourceSampleIntervalMs,
      processRoles: context.processRoles ?? [],
      artifactPath: join(collectorArtifactDirs(artifactDir).resourceSamples, `${safeSegment(phaseId)}-${commandIndex + 1}.jsonl`)
    }
  });
  if (agentCommand) {
    await sleep(1000);
    const afterSnapshot = captureProcessSnapshot(snapshotOptions);
    const processLeaks = diffProcessSnapshots(beforeSnapshot, afterSnapshot, {
      roles: agentLeakRoles()
    });
    await writeJsonArtifact(`${snapshotBase}-after.json`, afterSnapshot);
    await writeJsonArtifact(`${snapshotBase}-leaks.json`, processLeaks);
    result.processSnapshots = {
      schemaVersion: "kova.agentProcessSnapshots.v1",
      beforePath: `${snapshotBase}-before.json`,
      afterPath: `${snapshotBase}-after.json`,
      leaksPath: `${snapshotBase}-leaks.json`,
      before: compactSnapshot(beforeSnapshot),
      after: compactSnapshot(afterSnapshot),
      leaks: processLeaks
    };
  }
  return result;
}

function isAgentMessageCommand(command) {
  return (command.includes(" -- agent ") && command.includes("--message")) ||
    command.includes("run-concurrent-agent-turns.mjs");
}

function agentLeakRoles() {
  return ["agent-cli", "agent-process", "mcp-runtime", "plugin-cli", "mock-provider", "browser-sidecar"];
}

function compactSnapshot(snapshot) {
  return {
    schemaVersion: snapshot.schemaVersion,
    capturedAt: snapshot.capturedAt,
    envName: snapshot.envName,
    gatewayPid: snapshot.gatewayPid,
    processCount: snapshot.processCount,
    roleCounts: snapshot.roleCounts
  };
}

async function writeJsonArtifact(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function shouldApplyAuthAfterPhase(phase, authPolicy, record) {
  if (!phaseSupportsAuthSetup(phase, authPolicy)) {
    return false;
  }
  return !record.phases.some((planned) => planned.id === "auth-setup");
}

function phaseSupportsAuthSetup(phase, authPolicy) {
  if (!authPolicy?.setup) {
    return false;
  }
  const commands = phase.commands ?? [];
  return commands.some((command) => /\bocm\s+(start|env clone)\b/.test(command));
}

function evaluatorContext(context, scenario) {
  return {
    surface: context.surfacesById?.[scenario.surface] ?? null,
    targetPlan: context.targetPlan ?? null,
    profile: context.profile ?? null
  };
}

function diagnosticsEnv(context, envName, artifactDir) {
  if (context.openclawDiagnostics === false) {
    return {};
  }
  const artifactDirs = collectorArtifactDirs(artifactDir);

  const env = {
    OPENCLAW_DIAGNOSTICS: "timeline",
    OPENCLAW_DIAGNOSTICS_RUN_ID: context.runId,
    OPENCLAW_DIAGNOSTICS_ENV: envName,
    OPENCLAW_DIAGNOSTICS_TIMELINE_PATH: join(artifactDirs.openclaw, "timeline.jsonl"),
    OPENCLAW_DIAGNOSTICS_EVENT_LOOP: "1"
  };

  if (context.nodeProfile === true) {
    const profileDir = artifactDirs.nodeProfiles;
    env.KOVA_NODE_PROFILE_DIR = profileDir;
    env.NODE_OPTIONS = mergeNodeOptions(process.env.NODE_OPTIONS, [
      "--cpu-prof",
      `--cpu-prof-dir=${quoteNodeOptionValue(profileDir)}`,
      "--heap-prof",
      `--heap-prof-dir=${quoteNodeOptionValue(profileDir)}`,
      "--heapsnapshot-signal=SIGUSR2",
      "--report-on-signal",
      "--report-signal=SIGUSR2",
      `--report-directory=${quoteNodeOptionValue(profileDir)}`,
      "--trace-events-enabled",
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
    kovaRoot: quoteShell(repoRoot),
    startSelector: context.targetPlan.startSelector,
    upgradeSelector: context.targetPlan.upgradeSelector,
    fromUpgradeSelector: context.fromPlan?.upgradeSelector ?? ""
  };
}

function safeSegment(value) {
  return String(value ?? "phase").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "phase";
}

function envNameFor(scenarioId, stateId, runId, repeat = null) {
  const stateSegment = stateId ? `${stateId}-` : "";
  const repeatSegment = repeat?.total > 1 ? `r${repeat.index}-` : "";
  return `kova-${scenarioId}-${stateSegment}${repeatSegment}${runId.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

function repeatSummary(repeat) {
  if (!repeat) {
    return {
      index: 1,
      total: 1
    };
  }
  return {
    index: repeat.index,
    total: repeat.total
  };
}

function stateSummary(state) {
  if (!state) {
    return null;
  }

  return {
    id: state.id,
    title: state.title,
    objective: state.objective,
    traits: state.traits ?? [],
    riskArea: state.riskArea ?? null,
    ownerArea: state.ownerArea ?? null
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
