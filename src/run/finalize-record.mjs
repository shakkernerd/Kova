import { applyEvidenceLedgerGating, attachEvidenceLedger } from "../evidence-ledger.mjs";
import { attachEvidenceInvariants } from "../evidence/invariants.mjs";
import {
  attachCleanupEvidence,
  attachEvidenceArtifactBudget
} from "../evidence/record.mjs";
import { compactEvaluatedTimelineEvidence, evaluateRecord } from "../evaluator.mjs";
import { collectEnvMetrics, collectNodeProfileMetrics } from "../metrics.mjs";
import { runCommand } from "../commands.mjs";
import { ocmAt } from "../ocm/commands.mjs";
import { collectProviderEvidence } from "../collectors/provider.mjs";
import { collectStateFixtureAccounting } from "../collectors/state-fixtures.mjs";
import { metricOptions } from "./metric-options.mjs";

export async function collectPreCleanupEvidence(record, scenario, context, envName, artifactDir, authPolicy) {
  record.finishedAt = new Date().toISOString();
  record.finalMetrics = await collectEnvMetrics(envName, metricOptions(context, scenario, null, artifactDir, {
    kind: "final",
    redactValues: authPolicy.redactionValues
  }));
  record.targetRuntime = await collectTargetRuntime(
    envName,
    record.finalMetrics?.service?.childPid ?? null,
    record.finalMetrics?.service?.gatewayPort ?? null,
    context.timeoutMs
  );
  record.stateFixtureAccounting = await collectStateFixtureAccounting(context.state, envName, artifactDir);
  record.providerEvidence = await collectProviderEvidence(artifactDir, { authPolicy });
  evaluateRecord(record, scenario, evaluatorContext(context, scenario, record));

  if (shouldCaptureFailureDiagnostics(record, context)) {
    record.failureDiagnostics = await collectEnvMetrics(envName, {
      ...metricOptions(context, scenario, null, artifactDir, {
        kind: "failure-diagnostics",
        redactValues: authPolicy.redactionValues
      }),
      readinessTimeoutMs: 0,
      heapSnapshot: true,
      diagnosticReport: true
    });
  }
}

export async function attachPostCleanupEvidence(record, scenario, context, artifactDir) {
  if (context.nodeProfile === true || context.deepProfile === true) {
    record.postCleanupNodeProfiles = await collectNodeProfileMetrics(artifactDir);
    record.finalMetrics = record.finalMetrics ?? {};
    record.finalMetrics.nodeProfiles = record.postCleanupNodeProfiles;
    attachNodeProfileMeasurements(record);
  }

  evaluateRecord(record, scenario, evaluatorContext(context, scenario, record));
  attachEvidenceInvariants(record, scenario);
  attachCleanupEvidence(record);
  await attachEvidenceArtifactBudget(record, scenario);
  attachEvidenceLedger(record);
  applyEvidenceLedgerGating(record);
  compactEvaluatedTimelineEvidence(record);
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

function evaluatorContext(context, scenario, record) {
  return {
    requireCpuContract: true,
    surface: context.surfacesById?.[scenario.surface] ?? null,
    targetPlan: context.targetPlan ?? null,
    profile: context.profile ?? null,
    nodeVersion: record.targetRuntime?.nodeVersion ?? null,
    targetRuntime: record.targetRuntime ?? null
  };
}

export async function collectTargetRuntime(
  envName,
  expectedGatewayPid,
  expectedGatewayPort,
  timeoutMs,
  execute = runCommand
) {
  const evidence = {
    schemaVersion: "kova.targetRuntime.v1",
    nodeVersion: null,
    gatewayPid: null,
    gatewayPort: null,
    expectedGatewayPid: Number.isSafeInteger(expectedGatewayPid) && expectedGatewayPid > 0
      ? expectedGatewayPid
      : null,
    expectedGatewayPort: Number.isSafeInteger(expectedGatewayPort) && expectedGatewayPort > 0
      ? expectedGatewayPort
      : null,
    collectionStatus: "missing-service-identity",
    commandStatus: null,
    compatibilityCommandStatus: null
  };
  if (evidence.expectedGatewayPid === null || evidence.expectedGatewayPort === null) {
    return evidence;
  }

  // OCM supplies the env's connection settings; gateway call has no --port option.
  const result = await execute(
    ocmAt(envName, [
      "gateway",
      "call",
      "system.info",
      "--json"
    ]),
    { timeoutMs }
  );
  evidence.commandStatus = result.status;
  if (result.status !== 0) {
    if (isMissingSystemInfoMethod(result)) {
      return collectLegacyTargetRuntime(evidence, envName, timeoutMs, execute);
    }
    evidence.collectionStatus = "command-failed";
    return evidence;
  }

  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    evidence.collectionStatus = "invalid-json";
    return evidence;
  }
  const nodeVersion = typeof payload?.nodeVersion === "string" &&
    isNodeVersion(payload.nodeVersion)
    ? payload.nodeVersion
    : null;
  const gatewayPid = Number.isSafeInteger(payload?.pid) && payload.pid > 0
    ? payload.pid
    : null;
  const gatewayPort = Number.isSafeInteger(payload?.port) && payload.port > 0
    ? payload.port
    : null;
  evidence.gatewayPid = gatewayPid;
  evidence.gatewayPort = gatewayPort;
  if (nodeVersion === null || gatewayPid === null || gatewayPort === null) {
    evidence.collectionStatus = "invalid-payload";
    return evidence;
  }
  if (
    gatewayPid !== evidence.expectedGatewayPid ||
    gatewayPort !== evidence.expectedGatewayPort
  ) {
    evidence.collectionStatus = "identity-mismatch";
    return evidence;
  }

  evidence.nodeVersion = nodeVersion;
  evidence.collectionStatus = "ok";
  return evidence;
}

async function collectLegacyTargetRuntime(evidence, envName, timeoutMs, execute) {
  const result = await execute(ocmAt(envName, ["status"]), { timeoutMs });
  evidence.compatibilityCommandStatus = result.status;
  if (result.status !== 0) {
    evidence.collectionStatus = "compatibility-command-failed";
    return evidence;
  }
  const nodeVersion = /\bnode\s+(v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)/iu
    .exec(result.stdout)?.[1] ?? null;
  if (nodeVersion === null) {
    evidence.collectionStatus = "compatibility-invalid-payload";
    return evidence;
  }
  evidence.nodeVersion = nodeVersion;
  evidence.gatewayPid = evidence.expectedGatewayPid;
  evidence.gatewayPort = evidence.expectedGatewayPort;
  evidence.collectionStatus = "compatibility-fallback";
  return evidence;
}

function isMissingSystemInfoMethod(result) {
  return /unknown method:\s*system\.info/iu.test(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
}

function isNodeVersion(value) {
  return /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(value);
}
