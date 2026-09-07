import { buildAgentTurnBreakdown } from "./collectors/agent-turns.mjs";
import {
  buildAgentCliPreProviderAttribution,
  summarizeAgentCliPreProviderAttributions
} from "./collectors/agent-cli-attribution.mjs";
import {
  buildGatewaySessionPreProviderAttribution,
  summarizeGatewaySessionPreProviderAttributions
} from "./collectors/gateway-session-turn-attribution.mjs";
import { computeProviderTurnAttribution } from "./collectors/provider.mjs";
import { summarizeChannelWorkflowResources } from "./collectors/channel-workflow-resources.mjs";
import {
  countProviderTimeoutMentions,
  summarizeRuntimeDepsLogs
} from "./collectors/logs.mjs";
import {
  buildHealthMeasurement,
  healthReadinessClassification,
  measurementMetricValue
} from "./health.mjs";
import { resolveThresholdPolicy } from "./evaluation/thresholds.mjs";
import {
  isAgentCliMessageCommand,
  isAgentMessageCommand,
  commandResultPassed,
  measuredProductPhase,
  measurementScopeForPhase
} from "./measurement-contract.mjs";
import {
  RESOURCE_HEADLINE_CONTRACT,
  RESOURCE_MEASUREMENT_SCOPE
} from "./performance/stats.mjs";
import {
  commandMatchesPerformanceMetric,
  INSTRUMENTED_PERFORMANCE_REASON,
  instrumentedPerformanceThresholdAffected,
  isInstrumentedPerformanceMetric,
  measurementMetricForThreshold,
  profilingAffectsPerformance
} from "./performance/instrumentation.mjs";
import {
  checkAggregateThreshold,
  checkBooleanThreshold,
  checkDuration,
  checkEvidenceThreshold,
  checkRoleThresholds,
  checkCpuThreshold,
  checkTurnThreshold
} from "./evaluation/violations.mjs";

const DIRTY_PLUGIN_METRICS = [
  "dirtyPluginDetected",
  "dirtyPluginReported",
  "dirtyPluginChecksumPreserved",
  "doctorDestructiveChangeCount",
  "pluginsUsableWithDirtyState",
  "gatewaySurvivedDirtyPlugin"
];

const RELEASE_RECOVERY_METRICS = [
  "doctorFixSucceeded",
  "doctorUnrepairedFindingCount",
  "updateRetryVersionDrift",
  "rollbackAvailable",
  "rollbackSucceeded",
  "pluginsUsableAfterUpgrade",
  "pluginsUsableAfterRollback",
  "rollbackPreservedPluginData"
];

const CRON_RUNTIME_METRICS = [
  "cronRegisterMs",
  "cronRunMs",
  "cronRunCompleted",
  "cronTriggerAttributed"
];

const EXEC_TOOL_METRICS = [
  "execSafeCommandMs",
  "execSafeCommandSucceeded",
  "execDangerousCommandBlocked",
  "execOutputTruncated",
  "execTimeoutMs",
  "execProcessLeaks"
];

const MCP_LIFECYCLE_METRICS = [
  "mcpInitializeMs",
  "mcpToolsListMs",
  "mcpShutdownMs",
  "mcpToolCountMin",
  "mcpProcessLeaks"
];

const MCP_TOOL_CALL_METRICS = [
  "mcpToolsCallMs",
  "mcpToolCallSucceeded",
  "mcpToolCallErrorAttributed"
];

const PROVIDER_RECOVERY_MODES = new Set(["error-then-recover", "disconnect-then-recover"]);

export function evaluateRecord(record, scenario, options = {}) {
  const originalStatus = record.status;
  const thresholdPolicy = resolveThresholdPolicy({
    profile: options.profile,
    surface: options.surface,
    scenario,
    nodeVersion: options.targetRuntime === undefined
      ? options.nodeVersion
      : options.targetRuntime?.nodeVersion ?? null
  });
  const thresholds = thresholdPolicy.thresholds;
  const roleThresholds = thresholdPolicy.roleThresholds;
  const violations = [];
  const targetRuntimeIssue = targetRuntimeEvidenceIssue(
    thresholdPolicy.report.runtimeCalibration,
    options.targetRuntime
  );
  if (targetRuntimeIssue !== null) {
    violations.push({
      kind: "evidence",
      metric: "targetRuntime.nodeVersion",
      expected: "Gateway runtime identity with matching OCM service PID and port",
      actual: targetRuntimeIssue,
      failureDomain: "kova-harness",
      message: `Gateway runtime identity was not trusted: ${targetRuntimeIssue}`
    });
  }
  const allResults = collectResults(record);
  const measurementScopeSummary = summarizeMeasurementScopes(record);
  const measuredResults = collectResults(record, { productOnly: true });
  const intervalCpu = measuredResults.some((result) => result.resourceSamples?.cpuMeasurementContract === "linux-process-interval-v1");
  const requireCpuContract = options.requireCpuContract === true || intervalCpu ||
    record.measurements?.resourceHeadlineContract !== undefined;
  const expectedCpuContract = process.platform === "linux" ? "linux-process-interval-v1" : "ps-process-cpu-v1";
  for (const result of measuredResults) {
    const samples = result.resourceSamples;
    if (samples?.cpuCoverageComplete === false || (requireCpuContract && (options.requireCpuContract === true || samples || result.resourceSampleExpected) &&
      (samples?.cpuCoverageComplete !== true || samples?.cpuMeasurementContract !== expectedCpuContract))) {
      violations.push({ kind: "evidence", metric: "resourceCpuCoverage", expected: "complete CPU interval evidence",
        actual: samples?.errors ?? "missing CPU measurement contract or coverage", failureDomain: "kova-harness",
        message: "Product CPU interval evidence is incomplete" });
    }
  }
  const gatewayProcessResources = collectGatewayProcessResources(record, { productOnly: true, intervalCpu });
  const resourceSummary = collectResourceSummary(measuredResults, { gatewayProcessResources });
  const channelWorkflowResources = summarizeChannelWorkflowResources(measuredResults);
  const peakTrackedRssMb = maxNullable(gatewayProcessResources?.peakRssMb, resourceSummary.peakTotalRssMb);
  const cpuPercentMaxTracked = maxNullable(gatewayProcessResources?.maxCpuPercent, resourceSummary.maxTotalCpuPercent);
  const resourceGate = resolveResourceGate(resourceSummary, options.surface, {
    peakTrackedRssMb,
    cpuPercentMaxTracked
  });
  const primaryResourceRole = resourceGate.primaryRole;
  const resourceGateKind = resourceGate.kind;
  const peakRssMb = resourceGate.peakRssMb;
  const cpuPercentMax = resourceGate.cpuPercentMax;
  const primaryRoleOwnsResourceGate =
    resourceGateKind === "role" && resourceGate.role === primaryResourceRole;
  const primaryRoleThresholds = primaryRoleOwnsResourceGate
    ? roleThresholds[primaryResourceRole] ?? {}
    : {};
  const peakRssThreshold = strictestPrimaryThreshold(
    thresholds.peakRssMb,
    primaryRoleThresholds.peakRssMb
  );
  const cpuPercentThreshold = strictestPrimaryThreshold(
    thresholds.cpuPercentMax,
    primaryRoleThresholds.maxCpuPercent
  );
  const commandMissingDependencyErrors = countMissingDependencyErrors(allResults);
  const missingDependencyErrors = combineCommandAndLogCount(
    commandMissingDependencyErrors,
    countLogMetric(record, "missingDependencyErrors", allResults),
    hasSuccessfulLogCommandResult(allResults)
  );
  const pluginLoadFailures = countLogMetric(record, "pluginLoadFailures", allResults, {
    ignoreLine: expectedPluginFailureLineIgnorer(scenario)
  });
  const metadataScanMentions = countLogMetric(record, "metadataScanMentions", allResults);
  const configNormalizationMentions = countLogMetric(record, "configNormalizationMentions", allResults);
  const gatewayRestartCount = countGatewayRestarts(record, allResults);
  const intentionalRestartSourcePids = collectIntentionalRestartSourcePids(record);
  const providerLoadMentions = countLogMetric(record, "providerLoadMentions", allResults);
  const modelCatalogMentions = countLogMetric(record, "modelCatalogMentions", allResults);
  const providerTimeoutMentions = countLogMetric(record, "providerTimeoutMentions", allResults);
  const eventLoopDelayMentions = countLogMetric(record, "eventLoopDelayMentions", allResults);
  const v8DiagnosticMentions = countLogMetric(record, "v8DiagnosticMentions", allResults);
  const v8ReportCount = countDiagnosticMetric(record, "v8ReportCount");
  const heapSnapshotCount = countDiagnosticMetric(record, "heapSnapshotCount");
  const diagnosticArtifactBytes = countDiagnosticMetric(record, "artifactBytes");
  const nodeCpuProfileCount = countNodeProfileMetric(record, "cpuProfileCount");
  const nodeHeapProfileCount = countNodeProfileMetric(record, "heapProfileCount");
  const nodeTraceEventCount = countNodeProfileMetric(record, "traceEventCount");
  const nodeProfileArtifactBytes = countNodeProfileMetric(record, "artifactBytes");
  const nodeProfileTopFunction = collectNodeProfileTopFunction(record);
  const nodeHeapTopFunction = collectNodeHeapTopFunction(record);
  const heapSnapshotBytes = countHeapSnapshotBytes(record);
  const diagnosticReportCount = countDiagnosticReportMetric(record, "fileCount");
  const diagnosticReportBytes = countDiagnosticReportMetric(record, "artifactBytes");
  const gatewayExpected = recordExpectsGateway(record);
  const openclawDiagnostics = collectOpenClawDiagnostics(record);
  const timelineSummary = collectTimelineSummary(record, { intentionalRestartSourcePids });
  const logSummary = collectLogSummary(record);
  const runtimeDepsLogEvidence = collectRuntimeDepsLogEvidence(record);
  const timelineRequirement = timelineRequirementFor(options);
  const requiredOpenSpans = requiredTimelineSpans(options);
  const openRequiredSpans = timelineSummary.openSpansAll.filter((span) => requiredOpenSpans.has(span.name));
  const missingRequiredSpans = missingTimelineSpans(timelineSummary, requiredOpenSpans);
  const diagnosticContract = diagnosticSpanContractFor(options);
  const runtimeDepsStagingMs = maxNullable(
    openclawDiagnostics.runtimeDepsStagingMs,
    timelineSummary.runtimeDepsStageMaxMs,
    runtimeDepsLogEvidence.installMaxMs,
    runtimeDepsLogEvidence.postbuildMaxMs
  );
  const eventLoopDelayMs = maxNullable(
    openclawDiagnostics.eventLoopDelayMs,
    timelineSummary.eventLoopMaxMs,
    logSummary.livenessWarnings.maxEventLoopDelayMaxMs
  );
  const providerModelTimingMs = maxNullable(openclawDiagnostics.providerModelTimingMs, timelineSummary.providerRequestMaxMs);
  const agentTurns = collectAgentTurns(record, record.providerEvidence, scenario, timelineSummary, logSummary);
  const coldAgentTurn = selectAgentTurn(agentTurns, "cold") ?? agentTurns[0] ?? null;
  const warmAgentTurn = selectAgentTurn(agentTurns, "warm") ?? agentTurns[1] ?? null;
  const providerTurn = collectSlowestProviderTurn(agentTurns);
  const agentTurnStats = summarizeAgentTurnStats(agentTurns);
  const agentTurnDiagnostics = summarizeAgentTurnDiagnostics(agentTurns);
  const gatewaySessionPreProviderAttribution = summarizeGatewaySessionPreProviderAttributions(agentTurns);
  const agentCliPreProviderAttribution = summarizeAgentCliPreProviderAttributions(agentTurns);
  const turnPreProviderAttribution = preferredPreProviderAttributionSummary(
    gatewaySessionPreProviderAttribution,
    agentCliPreProviderAttribution
  );
  const agentTurnMs = maxTurnDuration(agentTurns);
  const agentResponseOk = agentTurns.length === 0 ? null : agentTurns.every((turn) => turn.responseOk === true);
  const health = buildHealthMeasurement(record, scenario);
  const agentProviderSimulation = evaluateProviderSimulation({ turns: agentTurns, scenario, record, thresholds, health });
  const agentFailureContainment = evaluateAgentFailureContainment({ turns: agentTurns, record, thresholds, gatewayExpected, health });
  const agentCleanupDiagnosis = diagnoseAgentCleanup(agentTurns, agentTurnStats, thresholds);
  const agentLatencyDiagnosis = diagnoseAgentLatency({
    coldAgentTurn,
    warmAgentTurn,
    providerTurn,
    thresholds,
    timelineSummary,
    authMode: record.auth?.mode ?? null,
    expectedProviderMode: scenario.mockProvider?.mode ?? "normal",
    providerSimulation: agentProviderSimulation
  });
  const finalGatewayState = record.finalMetrics?.service?.gatewayState ?? null;
  const startupHealthP95Ms = health.startupSamples?.p95Ms ?? null;
  const postReadyHealthP95Ms = health.postReadySamples?.p95Ms ?? null;
  const startupHealthFailures = health.startupSamples?.failureCount ?? 0;
  const postReadyHealthFailures = health.postReadySamples?.failureCount ?? 0;
  const finalHealthFailures = health.final?.failureCount ?? null;
  const soakEvidence = collectSoakEvidence(allResults);
  const mcpBridgeEvidence = collectMcpBridgeEvidence(allResults);
  const cronRuntimeEvidence = collectCronRuntimeEvidence(allResults);
  const execToolEvidence = collectExecToolEvidence(allResults);
  const mcpToolCallEvidence = collectMcpToolCallEvidence(allResults);
  const mcpLifecycleEvidence = combineMcpLifecycleEvidence(mcpBridgeEvidence, mcpToolCallEvidence);
  const dirtyPluginEvidence = collectDirtyPluginEvidence(record);
  const releaseRecoveryEvidence = collectReleaseRecoveryEvidence(record);
  const browserAutomationEvidence = collectBrowserAutomationEvidence(allResults);
  const mediaUnderstandingEvidence = collectMediaUnderstandingEvidence(allResults);
  const networkOfflineEvidence = collectNetworkOfflineEvidence(allResults);
  const officialPluginEvidence = collectOfficialPluginEvidence(allResults);
  const listeningFailures = countListeningFailures(record);
  const tcpConnectMaxMs = collectTcpConnectMax(record);
  const readinessHealthReadyMs = health.readiness?.healthReadyAtMs ?? null;
  const readinessFailures = countReadinessFailures(record);
  const readinessClassification = healthReadinessClassification(health);
  const coldReadyMs = maxDurationWhere(allResults, isColdReadyCommand);
  const warmReadyMs = maxDurationWhere(allResults, isWarmReadyCommand);
  const upgradeMs = maxDurationWhere(allResults, isUpgradeCommand);
  const statusMs = maxDurationWhere(allResults, isStatusCommand);
  const pluginsListMs = maxDurationWhere(allResults, isPluginsListCommand);
  const pluginInstallMs = maxDurationWhere(allResults, (command) => command.includes("run-official-plugin-install.mjs") || command.includes(" -- plugins install"));
  const modelsListMs = maxDurationWhere(allResults, isModelsListCommand);
  const doctorFixMs = maxDurationWhere(allResults, isDoctorFixCommand);
  const rssGrowthMb = maxNullable(resourceSummary.maxTotalRssGrowthMb);
  const gatewayRssGrowthMb = maxNullable(resourceSummary.maxGatewayRssGrowthMb);

  checkDuration(violations, allResults, "statusMs", thresholds.statusMs, isStatusCommand);
  checkDuration(violations, allResults, "pluginsListMs", thresholds.pluginsListMs, isPluginsListCommand);
  checkDuration(violations, allResults, "pluginUpdateDryRunMs", thresholds.pluginUpdateDryRunMs, isPluginUpdateDryRunCommand);
  checkDuration(violations, allResults, "modelsListMs", thresholds.modelsListMs, isModelsListCommand);
  checkDuration(
    violations,
    allResults,
    "coldReadyMs",
    thresholds.coldReadyMs ?? thresholds.gatewayReadyMs,
    isColdReadyCommand
  );
  checkDuration(violations, allResults, "warmReadyMs", thresholds.warmReadyMs ?? thresholds.restartReadyMs, isWarmReadyCommand);
  checkDuration(violations, allResults, "upgradeMs", thresholds.upgradeMs, isUpgradeCommand);
  checkDuration(violations, allResults, "doctorFixMs", thresholds.doctorFixMs, isDoctorFixCommand);

  if (resourceGateKind === "role-missing" && hasActivePrimaryResourceThreshold(thresholds, roleThresholds, primaryResourceRole)) {
    violations.push({
      kind: "resource",
      metric: `resourceByRole.${primaryResourceRole}.missing`,
      role: primaryResourceRole,
      resourceGateKind,
      expected: "configured primary resource role observed in product samples",
      actual: "missing",
      attribution: resourceGate.attribution,
      message: `${primaryResourceRole} resource evidence was not captured; configured primary resource role has active resource thresholds${resourceBreakdownSuffix(resourceSummary, resourceGate)}`
    });
  }

  if (peakRssThreshold !== null && peakRssMb !== null && peakRssMb > peakRssThreshold) {
    violations.push({
      kind: "threshold",
      metric: "peakRssMb",
      role: resourceGate.role ?? null,
      resourceGateKind,
      attribution: resourceGate.attribution,
      expected: `<= ${peakRssThreshold}`,
      actual: peakRssMb,
      message: `${resourceRssLabel(primaryResourceRole, resourceGateKind)} ${peakRssMb} MB exceeded threshold ${peakRssThreshold} MB${resourceBreakdownSuffix(resourceSummary, resourceGate)}`
    });
  }

  checkCpuThreshold(violations, {
    kind: "threshold", metric: "cpuPercentMax", label: "max CPU", value: cpuPercentMax,
    lower: resourceGate.role ? resourceSummary.byRole[resourceGate.role]?.maxCpuPercentLower : resourceSummary.maxTotalCpuPercentLower,
    threshold: cpuPercentThreshold ?? undefined
  });
  checkRoleThresholds(violations, resourceSummary.byRole, roleThresholds, {
    skipPeakRssRoles:
      primaryRoleOwnsResourceGate && typeof thresholds.peakRssMb === "number"
        ? [primaryResourceRole]
        : [],
    skipMaxCpuRoles:
      primaryRoleOwnsResourceGate && typeof thresholds.cpuPercentMax === "number"
        ? [primaryResourceRole]
        : []
  });

  const allowedMissingDependencyErrors =
    typeof thresholds.missingDependencyErrors === "number" ? thresholds.missingDependencyErrors : 0;
  if (missingDependencyErrors > allowedMissingDependencyErrors) {
    violations.push({
      kind: "log",
      metric: "missingDependencyErrors",
      expected: `<= ${allowedMissingDependencyErrors}`,
      actual: missingDependencyErrors,
      message: `${missingDependencyErrors} missing dependency/plugin load error patterns found`
    });
  }

  if (typeof thresholds.pluginLoadFailures === "number" && pluginLoadFailures > thresholds.pluginLoadFailures) {
    violations.push({
      kind: "log",
      metric: "pluginLoadFailures",
      expected: `<= ${thresholds.pluginLoadFailures}`,
      actual: pluginLoadFailures,
      message: `${pluginLoadFailures} plugin load failure patterns found`
    });
  }

  if (gatewayExpected && finalGatewayState && finalGatewayState !== "running") {
    violations.push({
      kind: "gateway",
      metric: "finalGatewayState",
      expected: "running",
      actual: finalGatewayState,
      message: `final gateway state was ${finalGatewayState}`
    });
  }

  if (typeof thresholds.startupHealthFailures === "number" && startupHealthFailures > thresholds.startupHealthFailures) {
    violations.push({
      kind: "health",
      metric: "startupHealthFailures",
      expected: `<= ${thresholds.startupHealthFailures}`,
      actual: startupHealthFailures,
      message: `${startupHealthFailures} startup health check(s) failed, over threshold ${thresholds.startupHealthFailures}`
    });
  }

  if (typeof thresholds.postReadyHealthFailures === "number" && postReadyHealthFailures > thresholds.postReadyHealthFailures) {
    violations.push({
      kind: "health",
      metric: "postReadyHealthFailures",
      expected: `<= ${thresholds.postReadyHealthFailures}`,
      actual: postReadyHealthFailures,
      message: `${postReadyHealthFailures} post-ready liveness check(s) failed, over threshold ${thresholds.postReadyHealthFailures}`
    });
  }

  if (
    typeof thresholds.finalHealthFailures === "number" &&
    typeof finalHealthFailures === "number" &&
    finalHealthFailures > thresholds.finalHealthFailures
  ) {
    violations.push({
      kind: "health",
      metric: "finalHealthFailures",
      expected: `<= ${thresholds.finalHealthFailures}`,
      actual: finalHealthFailures,
      message: `${finalHealthFailures} final health check(s) failed, over threshold ${thresholds.finalHealthFailures}`
    });
  }

  if (typeof thresholds.startupHealthP95Ms === "number" && startupHealthP95Ms !== null && startupHealthP95Ms > thresholds.startupHealthP95Ms) {
    violations.push({
      kind: "health",
      metric: "startupHealthP95Ms",
      expected: `<= ${thresholds.startupHealthP95Ms}`,
      actual: startupHealthP95Ms,
      message: `startup health sample p95 ${startupHealthP95Ms}ms exceeded threshold ${thresholds.startupHealthP95Ms}ms`
    });
  }

  if (typeof thresholds.postReadyHealthP95Ms === "number" && postReadyHealthP95Ms !== null && postReadyHealthP95Ms > thresholds.postReadyHealthP95Ms) {
    violations.push({
      kind: "health",
      metric: "postReadyHealthP95Ms",
      expected: `<= ${thresholds.postReadyHealthP95Ms}`,
      actual: postReadyHealthP95Ms,
      message: `post-ready liveness p95 ${postReadyHealthP95Ms}ms exceeded threshold ${thresholds.postReadyHealthP95Ms}ms`
    });
  }

  if (typeof thresholds.soakMinDurationMs === "number" && soakEvidence.durationMs !== null && soakEvidence.durationMs < thresholds.soakMinDurationMs) {
    violations.push({
      kind: "soak",
      metric: "soakDurationMs",
      expected: `>= ${thresholds.soakMinDurationMs}`,
      actual: soakEvidence.durationMs,
      message: `soak loop ran for ${soakEvidence.durationMs}ms, below required duration ${thresholds.soakMinDurationMs}ms`
    });
  }

  if (typeof thresholds.soakCommandP95Ms === "number" && soakEvidence.commandP95Ms !== null && soakEvidence.commandP95Ms > thresholds.soakCommandP95Ms) {
    violations.push({
      kind: "soak",
      metric: "soakCommandP95Ms",
      expected: `<= ${thresholds.soakCommandP95Ms}`,
      actual: soakEvidence.commandP95Ms,
      message: `soak command p95 ${soakEvidence.commandP95Ms}ms exceeded threshold ${thresholds.soakCommandP95Ms}ms`
    });
  }

  if (typeof thresholds.soakCommandFailures === "number" && soakEvidence.commandFailures !== null && soakEvidence.commandFailures > thresholds.soakCommandFailures) {
    violations.push({
      kind: "soak",
      metric: "soakCommandFailures",
      expected: `<= ${thresholds.soakCommandFailures}`,
      actual: soakEvidence.commandFailures,
      message: `${soakEvidence.commandFailures} soak command(s) failed during repeated OpenClaw usage`
    });
  }

  if (typeof thresholds.soakHealthP95Ms === "number" && soakEvidence.healthP95Ms !== null && soakEvidence.healthP95Ms > thresholds.soakHealthP95Ms) {
    violations.push({
      kind: "soak",
      metric: "soakHealthP95Ms",
      expected: `<= ${thresholds.soakHealthP95Ms}`,
      actual: soakEvidence.healthP95Ms,
      message: `soak health p95 ${soakEvidence.healthP95Ms}ms exceeded threshold ${thresholds.soakHealthP95Ms}ms`
    });
  }

  if (typeof thresholds.soakHealthFailures === "number" && soakEvidence.healthFailures !== null && soakEvidence.healthFailures > thresholds.soakHealthFailures) {
    violations.push({
      kind: "soak",
      metric: "soakHealthFailures",
      expected: `<= ${thresholds.soakHealthFailures}`,
      actual: soakEvidence.healthFailures,
      message: `${soakEvidence.healthFailures} soak health check(s) failed during repeated OpenClaw usage`
    });
  }

  if (mcpLifecycleEvidence.available || hasAnyThreshold(thresholds, MCP_LIFECYCLE_METRICS)) {
    checkRequiredMaxGate(violations, "mcp", "mcpInitializeMs", mcpLifecycleEvidence.initializeMs, thresholds.mcpInitializeMs, "MCP initialize");
    checkRequiredMaxGate(violations, "mcp", "mcpToolsListMs", mcpLifecycleEvidence.toolsListMs, thresholds.mcpToolsListMs, "MCP tools/list");
    checkRequiredMaxGate(violations, "mcp", "mcpShutdownMs", mcpLifecycleEvidence.shutdownMs, thresholds.mcpShutdownMs, "MCP shutdown");
    checkRequiredMinGate(violations, "mcp", "mcpToolCountMin", mcpLifecycleEvidence.toolCount, thresholds.mcpToolCountMin, "MCP tool count");
    checkRequiredMaxGate(violations, "mcp", "mcpProcessLeaks", mcpLifecycleEvidence.processLeaks, thresholds.mcpProcessLeaks, "MCP bridge process leak count");
  }

  if (mcpBridgeEvidence.available) {
    if (mcpBridgeEvidence.errors.length > 0) {
      violations.push({
        kind: "mcp",
        metric: "mcpBridgeErrors",
        expected: "0",
        actual: mcpBridgeEvidence.errors.length,
        message: `MCP bridge smoke reported ${mcpBridgeEvidence.errors.length} error(s): ${mcpBridgeEvidence.errors[0]}`
      });
    }
  }

  if (cronRuntimeEvidence.available || hasAnyThreshold(thresholds, CRON_RUNTIME_METRICS)) {
    checkRequiredMaxGate(violations, "cron", "cronRegisterMs", cronRuntimeEvidence.cronRegisterMs, thresholds.cronRegisterMs, "Cron registration");
    checkRequiredMaxGate(violations, "cron", "cronRunMs", cronRuntimeEvidence.cronRunMs, thresholds.cronRunMs, "Cron run");
    checkRequiredBooleanGate(violations, "cron", "cronRunCompleted", cronRuntimeEvidence.cronRunCompleted, thresholds.cronRunCompleted, "Cron run did not complete");
    checkRequiredBooleanGate(violations, "cron", "cronTriggerAttributed", cronRuntimeEvidence.cronTriggerAttributed, thresholds.cronTriggerAttributed, "Cron run was not attributed to a cron trigger");
    if (cronRuntimeEvidence.errors.length > 0) {
      violations.push({
        kind: "cron",
        metric: "cronRuntimeErrors",
        expected: "0",
        actual: cronRuntimeEvidence.errors.length,
        message: `cron runtime smoke reported ${cronRuntimeEvidence.errors.length} error(s): ${cronRuntimeEvidence.errors[0]}`
      });
    }
  }

  if (execToolEvidence.available || hasAnyThreshold(thresholds, EXEC_TOOL_METRICS)) {
    checkRequiredMaxGate(violations, "exec", "execSafeCommandMs", execToolEvidence.safeCommandMs, thresholds.execSafeCommandMs, "Exec safe command");
    checkRequiredMaxGate(violations, "exec", "execTimeoutMs", execToolEvidence.timeoutMs, thresholds.execTimeoutMs, "Exec timeout containment");
    checkRequiredBooleanGate(violations, "exec", "execSafeCommandSucceeded", execToolEvidence.safeCommandSucceeded, thresholds.execSafeCommandSucceeded, "OpenClaw exec safe command did not succeed");
    checkRequiredBooleanGate(violations, "exec", "execDangerousCommandBlocked", execToolEvidence.dangerousCommandBlocked, thresholds.execDangerousCommandBlocked, "OpenClaw exec dangerous command was not blocked");
    checkRequiredBooleanGate(violations, "exec", "execOutputTruncated", execToolEvidence.outputTruncated, thresholds.execOutputTruncated, "Exec output was not bounded");
    checkRequiredMaxGate(violations, "exec", "execProcessLeaks", execToolEvidence.processLeaks, thresholds.execProcessLeaks, "Exec process leak count");
    if (execToolEvidence.dangerousPayloadExecuted === true) {
      violations.push({
        kind: "exec",
        metric: "execDangerousPayloadExecuted",
        expected: false,
        actual: true,
        message: "dangerous exec sentinel was removed; OpenClaw executed the blocked payload"
      });
    }
    if (execToolEvidence.errors.length > 0) {
      violations.push({
        kind: "exec",
        metric: "execToolErrors",
        expected: "0",
        actual: execToolEvidence.errors.length,
        message: `exec tool smoke reported ${execToolEvidence.errors.length} error(s): ${execToolEvidence.errors[0]}`
      });
    }
  }

  if (mcpToolCallEvidence.available || hasAnyThreshold(thresholds, MCP_TOOL_CALL_METRICS)) {
    checkRequiredMaxGate(violations, "mcp", "mcpToolsCallMs", mcpToolCallEvidence.toolsCallMs, thresholds.mcpToolsCallMs, "MCP tools/call");
    checkRequiredBooleanGate(violations, "mcp", "mcpToolCallSucceeded", mcpToolCallEvidence.safeToolSucceeded, thresholds.mcpToolCallSucceeded, "MCP tools/call did not return a successful safe tool result");
    checkRequiredBooleanGate(violations, "mcp", "mcpToolCallErrorAttributed", mcpToolCallEvidence.invalidToolErrorAttributed, thresholds.mcpToolCallErrorAttributed, "MCP invalid tool call was not attributed as a tool error");
    if (mcpToolCallEvidence.errors.length > 0) {
      violations.push({
        kind: "mcp",
        metric: "mcpToolCallErrors",
        expected: "0",
        actual: mcpToolCallEvidence.errors.length,
        message: `MCP tool-call smoke reported ${mcpToolCallEvidence.errors.length} error(s): ${mcpToolCallEvidence.errors[0]}`
      });
    }
  }

  if (dirtyPluginEvidence.available || hasAnyThreshold(thresholds, DIRTY_PLUGIN_METRICS)) {
    checkRequiredBooleanGate(violations, "plugins", "dirtyPluginDetected", dirtyPluginEvidence.dirtyPluginDetected, thresholds.dirtyPluginDetected, "Dirty plugin state was not detected");
    checkRequiredBooleanGate(violations, "plugins", "dirtyPluginReported", dirtyPluginEvidence.dirtyPluginReported, thresholds.dirtyPluginReported, "Dirty plugin state was not reported in plugin command evidence");
    checkRequiredBooleanGate(violations, "plugins", "dirtyPluginChecksumPreserved", dirtyPluginEvidence.dirtyPluginChecksumPreserved, thresholds.dirtyPluginChecksumPreserved, "Dirty plugin checksum evidence was not preserved");
    checkRequiredMaxGate(violations, "plugins", "doctorDestructiveChangeCount", dirtyPluginEvidence.doctorDestructiveChangeCount, thresholds.doctorDestructiveChangeCount, "Doctor destructive dirty-plugin change count");
    checkRequiredBooleanGate(violations, "plugins", "pluginsUsableWithDirtyState", dirtyPluginEvidence.pluginsUsableWithDirtyState, thresholds.pluginsUsableWithDirtyState, "Plugin commands were not usable with dirty plugin state");
    checkRequiredBooleanGate(violations, "plugins", "gatewaySurvivedDirtyPlugin", dirtyPluginEvidence.gatewaySurvivedDirtyPlugin, thresholds.gatewaySurvivedDirtyPlugin, "Gateway did not survive dirty plugin handling");
    if (dirtyPluginEvidence.errors.length > 0) {
      violations.push({
        kind: "plugins",
        metric: "dirtyPluginErrors",
        expected: "0",
        actual: dirtyPluginEvidence.errors.length,
        message: `dirty plugin verifier reported ${dirtyPluginEvidence.errors.length} error(s): ${dirtyPluginEvidence.errors[0]}`
      });
    }
  }

  if (releaseRecoveryEvidence.available || hasAnyThreshold(thresholds, RELEASE_RECOVERY_METRICS)) {
    checkRequiredBooleanGate(violations, "upgrade", "doctorFixSucceeded", releaseRecoveryEvidence.doctorFixSucceeded, thresholds.doctorFixSucceeded, "Doctor repair did not complete successfully");
    checkRequiredMaxGate(violations, "upgrade", "doctorUnrepairedFindingCount", releaseRecoveryEvidence.doctorUnrepairedFindingCount, thresholds.doctorUnrepairedFindingCount, "Doctor unrepaired finding count");
    checkRequiredMaxGate(violations, "upgrade", "updateRetryVersionDrift", releaseRecoveryEvidence.updateRetryVersionDrift, thresholds.updateRetryVersionDrift, "Update retry version drift");
    checkRequiredBooleanGate(violations, "upgrade", "rollbackAvailable", releaseRecoveryEvidence.rollbackAvailable, thresholds.rollbackAvailable, "Rollback snapshot was not available");
    checkRequiredBooleanGate(violations, "upgrade", "rollbackSucceeded", releaseRecoveryEvidence.rollbackSucceeded, thresholds.rollbackSucceeded, "Rollback did not succeed");
    checkRequiredBooleanGate(violations, "upgrade", "pluginsUsableAfterUpgrade", releaseRecoveryEvidence.pluginsUsableAfterUpgrade, thresholds.pluginsUsableAfterUpgrade, "Plugin commands were not usable after upgrade");
    checkRequiredBooleanGate(violations, "upgrade", "pluginsUsableAfterRollback", releaseRecoveryEvidence.pluginsUsableAfterRollback, thresholds.pluginsUsableAfterRollback, "Plugin commands were not usable after rollback");
    checkRequiredBooleanGate(violations, "upgrade", "rollbackPreservedPluginData", releaseRecoveryEvidence.rollbackPreservedPluginData, thresholds.rollbackPreservedPluginData, "Rollback did not preserve plugin fixture data");
    if (releaseRecoveryEvidence.errors.length > 0) {
      violations.push({
        kind: "upgrade",
        metric: "releaseRecoveryErrors",
        expected: "0",
        actual: releaseRecoveryEvidence.errors.length,
        message: `release recovery evidence reported ${releaseRecoveryEvidence.errors.length} error(s): ${releaseRecoveryEvidence.errors[0]}`
      });
    }
  }

  if (browserAutomationEvidence.available) {
    checkEvidenceThreshold(violations, "browser", "browserDoctorMs", browserAutomationEvidence.browserDoctorMs, thresholds.browserDoctorMs, "Browser doctor");
    checkEvidenceThreshold(violations, "browser", "browserStartMs", browserAutomationEvidence.browserStartMs, thresholds.browserStartMs, "Browser start");
    checkEvidenceThreshold(violations, "browser", "browserTabsMs", browserAutomationEvidence.browserTabsMs, thresholds.browserTabsMs, "Browser tabs");
    checkEvidenceThreshold(violations, "browser", "browserOpenMs", browserAutomationEvidence.browserOpenMs, thresholds.browserOpenMs, "Browser open");
    checkEvidenceThreshold(violations, "browser", "browserSnapshotMs", browserAutomationEvidence.browserSnapshotMs, thresholds.browserSnapshotMs, "Browser snapshot");
    checkEvidenceThreshold(violations, "browser", "browserStopMs", browserAutomationEvidence.browserStopMs, thresholds.browserStopMs, "Browser stop");

    if (typeof thresholds.browserTabCountMin === "number" && browserAutomationEvidence.browserTabCount !== null && browserAutomationEvidence.browserTabCount < thresholds.browserTabCountMin) {
      violations.push({
        kind: "browser",
        metric: "browserTabCountMin",
        expected: `>= ${thresholds.browserTabCountMin}`,
        actual: browserAutomationEvidence.browserTabCount,
        message: `Browser automation saw ${browserAutomationEvidence.browserTabCount} tab(s), below required ${thresholds.browserTabCountMin}`
      });
    }

    if (browserAutomationEvidence.browserSnapshotOk === false) {
      violations.push({
        kind: "browser",
        metric: "browserSnapshotOk",
        expected: true,
        actual: false,
        message: "Browser snapshot command did not complete successfully"
      });
    }

    const leakCount = browserAutomationEvidence.browserStopped === false ? 1 : 0;
    if (typeof thresholds.browserProcessLeaks === "number" && leakCount > thresholds.browserProcessLeaks) {
      violations.push({
        kind: "browser",
        metric: "browserProcessLeaks",
        expected: `<= ${thresholds.browserProcessLeaks}`,
        actual: leakCount,
        message: "Browser automation did not stop the managed browser profile cleanly"
      });
    }

    if (browserAutomationEvidence.errors.length > 0) {
      violations.push({
        kind: "browser",
        metric: "browserSmokeErrors",
        expected: "0",
        actual: browserAutomationEvidence.errors.length,
        message: `Browser automation smoke reported ${browserAutomationEvidence.errors.length} error(s): ${browserAutomationEvidence.errors[0]}`
      });
    }
  }

  if (mediaUnderstandingEvidence.available) {
    checkEvidenceThreshold(violations, "media-understanding", "mediaDescribeMs", mediaUnderstandingEvidence.mediaDescribeMs, thresholds.mediaDescribeMs, "Media understanding image describe");
    checkEvidenceThreshold(violations, "media-understanding", "mediaStatusAfterTimeoutMs", mediaUnderstandingEvidence.mediaStatusAfterTimeoutMs, thresholds.mediaStatusAfterTimeoutMs, "Post-media status");

    if (typeof thresholds.mediaTimeoutObserved === "number" && mediaUnderstandingEvidence.mediaTimeoutObserved !== true) {
      violations.push({
        kind: "media-understanding",
        metric: "mediaTimeoutObserved",
        expected: true,
        actual: mediaUnderstandingEvidence.mediaTimeoutObserved,
        message: "Media understanding provider timeout was not observed as a bounded command failure"
      });
    }

    if (mediaUnderstandingEvidence.mediaCommandTimedOut === true) {
      violations.push({
        kind: "media-understanding",
        metric: "mediaCommandTimedOut",
        expected: false,
        actual: true,
        message: "Media understanding command hit Kova's outer timeout instead of OpenClaw's provider timeout"
      });
    }

    if (mediaUnderstandingEvidence.gatewayStatusWorks === false) {
      violations.push({
        kind: "media-understanding",
        metric: "mediaGatewayStatusWorks",
        expected: true,
        actual: false,
        message: "Gateway status did not work after media understanding timeout"
      });
    }

    if (mediaUnderstandingEvidence.errors.length > 0) {
      violations.push({
        kind: "media-understanding",
        metric: "mediaUnderstandingErrors",
        expected: "0",
        actual: mediaUnderstandingEvidence.errors.length,
        message: `Media understanding timeout smoke reported ${mediaUnderstandingEvidence.errors.length} error(s): ${mediaUnderstandingEvidence.errors[0]}`
      });
    }
  }

  if (networkOfflineEvidence.available) {
    checkEvidenceThreshold(violations, "network-offline", "networkTurnMs", networkOfflineEvidence.networkTurnMs, thresholds.networkTurnMs, "Network offline agent turn");
    checkEvidenceThreshold(violations, "network-offline", "networkStatusAfterFailureMs", networkOfflineEvidence.networkStatusAfterFailureMs, thresholds.networkStatusAfterFailureMs, "Post-network status");

    if (typeof thresholds.networkFailureObserved === "number" && networkOfflineEvidence.networkFailureObserved !== true) {
      violations.push({
        kind: "network-offline",
        metric: "networkFailureObserved",
        expected: true,
        actual: networkOfflineEvidence.networkFailureObserved,
        message: "Network/provider failure was not observed as a bounded command failure"
      });
    }

    if (networkOfflineEvidence.networkCommandTimedOut === true) {
      violations.push({
        kind: "network-offline",
        metric: "networkCommandTimedOut",
        expected: false,
        actual: true,
        message: "Network offline command hit Kova's outer timeout instead of OpenClaw surfacing the provider failure"
      });
    }

    if (networkOfflineEvidence.gatewayStatusWorks === false) {
      violations.push({
        kind: "network-offline",
        metric: "networkGatewayStatusWorks",
        expected: true,
        actual: false,
        message: "Gateway status did not work after network/provider failure"
      });
    }

    if (networkOfflineEvidence.errors.length > 0) {
      violations.push({
        kind: "network-offline",
        metric: "networkOfflineErrors",
        expected: "0",
        actual: networkOfflineEvidence.errors.length,
        message: `Network offline smoke reported ${networkOfflineEvidence.errors.length} error(s): ${networkOfflineEvidence.errors[0]}`
      });
    }
  }

  if (officialPluginEvidence.available) {
    checkEvidenceThreshold(violations, "plugins", "pluginInstallMs", officialPluginEvidence.durationMs, thresholds.pluginInstallMs, "Official plugin install");
    if (typeof thresholds.officialPluginInstallOk === "number" && officialPluginEvidence.ok !== true) {
      violations.push({
        kind: "plugins",
        metric: "officialPluginInstallOk",
        expected: true,
        actual: false,
        message: officialPluginInstallFailureMessage(officialPluginEvidence)
      });
    }
    const securityBlockLimit = typeof thresholds.officialPluginSecurityBlocks === "number" ? thresholds.officialPluginSecurityBlocks : 0;
    const securityBlockExceeded = officialPluginEvidence.securityBlockCount > securityBlockLimit;
    if (securityBlockExceeded) {
      violations.push({
        kind: "plugins",
        metric: "officialPluginSecurityBlocks",
        expected: `<= ${securityBlockLimit}`,
        actual: officialPluginEvidence.securityBlockCount,
        message: `official plugin security scanner signal observed: ${officialPluginEvidence.securityEvidence ?? "unknown plugin"}`
      });
    }
  }

  if (typeof thresholds.providerRequestCountMin === "number") {
    const requestCount = record.providerEvidence?.requestCount ?? 0;
    if (requestCount < thresholds.providerRequestCountMin) {
      violations.push({
        kind: "provider",
        metric: "providerRequestCountMin",
        expected: `>= ${thresholds.providerRequestCountMin}`,
        actual: requestCount,
        message: `Provider saw ${requestCount} request(s), below required ${thresholds.providerRequestCountMin}`
      });
    }
  }

  if (typeof thresholds.rssGrowthMb === "number" && rssGrowthMb !== null && rssGrowthMb > thresholds.rssGrowthMb) {
    violations.push({
      kind: "soak",
      metric: "rssGrowthMb",
      expected: `<= ${thresholds.rssGrowthMb}`,
      actual: rssGrowthMb,
      message: `resource-sampled RSS grew by ${rssGrowthMb} MB, over threshold ${thresholds.rssGrowthMb} MB`
    });
  }

  if (typeof thresholds.gatewayRssGrowthMb === "number" && gatewayRssGrowthMb !== null && gatewayRssGrowthMb > thresholds.gatewayRssGrowthMb) {
    violations.push({
      kind: "soak",
      metric: "gatewayRssGrowthMb",
      expected: `<= ${thresholds.gatewayRssGrowthMb}`,
      actual: gatewayRssGrowthMb,
      message: `gateway RSS grew by ${gatewayRssGrowthMb} MB during sampled execution, over threshold ${thresholds.gatewayRssGrowthMb} MB`
    });
  }

  if (readinessClassification?.state === "hard-failure") {
    violations.push({
      kind: "gateway",
      metric: "readiness.classification",
      expected: "ready",
      actual: readinessClassification.state,
      message: `gateway hard failure: ${readinessClassification.reason}`
    });
  }

  if (readinessClassification?.state === "unhealthy") {
    violations.push({
      kind: "gateway",
      metric: "readiness.classification",
      expected: "ready",
      actual: readinessClassification.state,
      message: `gateway unhealthy: ${readinessClassification.reason}`
    });
  }

  if (readinessClassification?.state === "slow-startup") {
    violations.push({
      kind: "gateway",
      metric: "readiness.classification",
      expected: "ready within threshold",
      actual: readinessClassification.state,
      message: `gateway slow startup: ${readinessClassification.reason}`
    });
  }

  const gatewayReadyThreshold = thresholds.gatewayReadyMs ?? thresholds.coldReadyMs;
  if (
    readinessClassification?.state !== "slow-startup" &&
    typeof gatewayReadyThreshold === "number" &&
    readinessHealthReadyMs !== null &&
    readinessHealthReadyMs > gatewayReadyThreshold
  ) {
    violations.push({
      kind: "gateway",
      metric: "readinessHealthReadyMs",
      expected: `<= ${gatewayReadyThreshold}`,
      actual: readinessHealthReadyMs,
      message: `gateway health ready took ${readinessHealthReadyMs}ms, over threshold ${gatewayReadyThreshold}ms`
    });
  }

  if (typeof thresholds.gatewayRestarts === "number" && gatewayRestartCount > thresholds.gatewayRestarts) {
    violations.push({
      kind: "gateway",
      metric: "gatewayRestartCount",
      expected: `<= ${thresholds.gatewayRestarts}`,
      actual: gatewayRestartCount,
      message: `${gatewayRestartCount} gateway restart signals found`
    });
  }

  const allowedProviderTimeouts = typeof thresholds.providerTimeoutMentions === "number" ? thresholds.providerTimeoutMentions : 0;
  if (providerTimeoutMentions > allowedProviderTimeouts) {
    violations.push({
      kind: "provider",
      metric: "providerTimeoutMentions",
      expected: `<= ${allowedProviderTimeouts}`,
      actual: providerTimeoutMentions,
      message: `${providerTimeoutMentions} provider/model timeout signals found`
    });
  }

  const allowedEventLoopMentions = typeof thresholds.eventLoopDelayMentions === "number" ? thresholds.eventLoopDelayMentions : 0;
  if (eventLoopDelayMentions > allowedEventLoopMentions) {
    violations.push({
      kind: "performance",
      metric: "eventLoopDelayMentions",
      expected: `<= ${allowedEventLoopMentions}`,
      actual: eventLoopDelayMentions,
      message: `${eventLoopDelayMentions} event-loop delay signals found`
    });
  }

  if (typeof thresholds.eventLoopDelayMs === "number" && eventLoopDelayMs !== null && eventLoopDelayMs > thresholds.eventLoopDelayMs) {
    violations.push({
      kind: "performance",
      metric: "eventLoopDelayMs",
      expected: `<= ${thresholds.eventLoopDelayMs}`,
      actual: eventLoopDelayMs,
      message: `structured event-loop delay ${eventLoopDelayMs}ms exceeded threshold ${thresholds.eventLoopDelayMs}ms`
    });
  }

  if (typeof thresholds.runtimeDepsStagingMs === "number" && runtimeDepsStagingMs !== null && runtimeDepsStagingMs > thresholds.runtimeDepsStagingMs) {
    violations.push({
      kind: "plugins",
      metric: "runtimeDepsStagingMs",
      expected: `<= ${thresholds.runtimeDepsStagingMs}`,
      actual: runtimeDepsStagingMs,
      message: `runtime dependency staging took ${runtimeDepsStagingMs}ms, over threshold ${thresholds.runtimeDepsStagingMs}ms`
    });
  }

  if (
    typeof thresholds.warmRuntimeDepsRestageCount === "number" &&
    runtimeDepsLogEvidence.warmRestart.installCount !== null &&
    runtimeDepsLogEvidence.warmRestart.installCount > thresholds.warmRuntimeDepsRestageCount
  ) {
    violations.push({
      kind: "plugins",
      metric: "warmRuntimeDepsRestageCount",
      expected: `<= ${thresholds.warmRuntimeDepsRestageCount}`,
      actual: runtimeDepsLogEvidence.warmRestart.installCount,
      message: `warm restart reinstalled bundled runtime deps ${runtimeDepsLogEvidence.warmRestart.installCount} time(s); expected staged deps to be reused`
    });
  }

  if (
    typeof thresholds.warmRuntimeDepsStagingMs === "number" &&
    runtimeDepsLogEvidence.warmRestart.installMaxMs !== null &&
    runtimeDepsLogEvidence.warmRestart.installMaxMs > thresholds.warmRuntimeDepsStagingMs
  ) {
    violations.push({
      kind: "plugins",
      metric: "warmRuntimeDepsStagingMs",
      expected: `<= ${thresholds.warmRuntimeDepsStagingMs}`,
      actual: runtimeDepsLogEvidence.warmRestart.installMaxMs,
      message: `warm restart bundled runtime deps install took ${runtimeDepsLogEvidence.warmRestart.installMaxMs}ms, over threshold ${thresholds.warmRuntimeDepsStagingMs}ms`
    });
  }

  const allowedTimelineParseErrors = typeof thresholds.openclawTimelineParseErrors === "number" ? thresholds.openclawTimelineParseErrors : 0;
  if (timelineRequirement.required && !timelineSummary.available) {
    violations.push({
      kind: "diagnostics",
      metric: "openclawTimelineAvailable",
      expected: "available",
      actual: false,
      message: `OpenClaw diagnostics timeline was required for ${timelineRequirement.reason} but was not emitted`
    });
  }

  if (timelineSummary.available && timelineSummary.parseErrorCount > allowedTimelineParseErrors) {
    violations.push({
      kind: "diagnostics",
      metric: "openclawTimelineParseErrors",
      expected: `<= ${allowedTimelineParseErrors}`,
      actual: timelineSummary.parseErrorCount,
      message: `${timelineSummary.parseErrorCount} OpenClaw diagnostics timeline parse errors found`
    });
  }

  if (openRequiredSpans.length > 0) {
    const slowestOpen = openRequiredSpans[0];
    violations.push({
      kind: "diagnostics",
      metric: "openclawOpenRequiredSpanCount",
      expected: "0",
      actual: openRequiredSpans.length,
      message: `${openRequiredSpans.length} required OpenClaw diagnostics span(s) were left open; slowest ${slowestOpen.name}${slowestOpen.ageMs !== null ? ` age ${slowestOpen.ageMs}ms` : ""}`
    });
  }

  if (timelineSummary.available && missingRequiredSpans.length > 0 && diagnosticContract.enforceMissingSpans) {
    violations.push({
      kind: "diagnostics",
      metric: "openclawMissingRequiredSpanCount",
      expected: "0",
      actual: missingRequiredSpans.length,
      message: `${missingRequiredSpans.length} required OpenClaw diagnostics span(s) were not observed: ${missingRequiredSpans.slice(0, 5).join(", ")}`
    });
  }

  checkGatewaySessionTransport(violations, agentTurns, scenario);
  checkChannelModelTurnCases(violations, agentTurns);

  if (agentResponseOk === false) {
    violations.push({
      kind: "agent",
      metric: "agentResponseOk",
      expected: "true",
      actual: false,
      message: "agent message command finished without a usable assistant response"
    });
  }
  checkAgentTurnCorrectness(violations, agentTurns, scenario.agent?.expectedText ?? null);
  checkAgentTurnThresholds(violations, agentTurns, { coldAgentTurn, warmAgentTurn, providerTurn, agentLatencyDiagnosis }, thresholds, record);
  checkAgentTurnAggregateThresholds(violations, agentTurnStats, thresholds);
  checkProviderSimulation(violations, agentProviderSimulation);
  checkAgentFailureContainment(violations, agentFailureContainment);

  record.measurements = {
    peakRssMb,
    cpuPercentMax,
    measurementScopeSummary,
    resourceMeasurementScope: RESOURCE_MEASUREMENT_SCOPE,
    resourceHeadlineContract: RESOURCE_HEADLINE_CONTRACT,
    resourcePrimaryRole: primaryResourceRole,
    resourceGateKind,
    resourceGateReason: resourceGate.reason,
    resourceGateAttribution: resourceGate.attribution,
    resourcePeakTrackedRssMb: peakTrackedRssMb,
    resourceCpuPercentMaxTracked: cpuPercentMaxTracked,
    coldReadyMs,
    warmReadyMs,
    upgradeMs,
    statusMs,
    doctorFixMs,
    pluginsListMs,
    pluginInstallMs,
    modelsListMs,
    agentTurnMs,
    agentResponseOk,
    agentTurnCount: agentTurns.length,
    agentTurns,
    agentTurnStats,
    agentTurnMedianMs: agentTurnStats.totalTurnMs.median,
    agentTurnP95Ms: agentTurnStats.totalTurnMs.p95,
    agentTurnMaxMs: agentTurnStats.totalTurnMs.max,
    agentPreProviderMedianMs: agentTurnStats.preProviderMs.median,
    agentPreProviderP95Ms: agentTurnStats.preProviderMs.p95,
    agentPreProviderMaxMs: agentTurnStats.preProviderMs.max,
    agentProviderFinalMedianMs: agentTurnStats.providerFinalMs.median,
    agentProviderFinalP95Ms: agentTurnStats.providerFinalMs.p95,
    agentProviderFinalMaxMs: agentTurnStats.providerFinalMs.max,
    agentCleanupMedianMs: agentTurnStats.cleanupMs.median,
    agentCleanupP95Ms: agentTurnStats.cleanupMs.p95,
    agentCleanupMaxMs: agentTurnStats.cleanupMs.max,
    agentMetadataScanCount: agentTurnDiagnostics.metadataScanCount,
    agentMetadataScanTotalMs: agentTurnDiagnostics.metadataScanTotalMs,
    agentMetadataScanMaxMs: agentTurnDiagnostics.metadataScanMaxMs,
    agentEventLoopMaxMs: agentTurnDiagnostics.eventLoopMaxMs,
    agentEventLoopSampleCount: agentTurnDiagnostics.eventLoopSampleCount,
    agentSessionPollCount: agentTurnDiagnostics.sessionPollCount,
    agentSessionPollErrorCount: agentTurnDiagnostics.sessionPollErrorCount,
    gatewaySessionPreProviderAttribution,
    agentCliPreProviderAttribution,
    coldPreProviderAttributedMs: turnPreProviderAttribution.cold.knownAttributedMs.median,
    warmPreProviderAttributedMs: turnPreProviderAttribution.warm.knownAttributedMs.median,
    coldPreProviderUnattributedMs: turnPreProviderAttribution.cold.unattributedMs.median,
    warmPreProviderUnattributedMs: turnPreProviderAttribution.warm.unattributedMs.median,
    coldPreProviderAttributionCoverage: turnPreProviderAttribution.cold.coverageRatio.median,
    warmPreProviderAttributionCoverage: turnPreProviderAttribution.warm.coverageRatio.median,
    coldAgentTurnMs: coldAgentTurn?.totalTurnMs ?? null,
    warmAgentTurnMs: warmAgentTurn?.totalTurnMs ?? null,
    agentColdWarmDeltaMs: delta(coldAgentTurn?.totalTurnMs, warmAgentTurn?.totalTurnMs),
    coldPreProviderMs: coldAgentTurn?.preProviderMs ?? null,
    warmPreProviderMs: warmAgentTurn?.preProviderMs ?? null,
    agentColdWarmPreProviderDeltaMs: delta(coldAgentTurn?.preProviderMs, warmAgentTurn?.preProviderMs),
    coldProviderFinalMs: coldAgentTurn?.providerFinalMs ?? null,
    warmProviderFinalMs: warmAgentTurn?.providerFinalMs ?? null,
    coldFirstByteLatencyMs: coldAgentTurn?.firstByteLatencyMs ?? null,
    warmFirstByteLatencyMs: warmAgentTurn?.firstByteLatencyMs ?? null,
    agentLatencyDiagnosis,
    agentCleanupDiagnosis,
    agentProviderSimulation,
    agentFailureContainment,
    agentProcessLeakCount: agentFailureContainment.processLeakCount,
    agentLeakedProcesses: agentFailureContainment.leakedProcesses,
    agentFailureFixerSummary: buildAgentFailureFixerSummary(agentLatencyDiagnosis, agentCleanupDiagnosis, agentProviderSimulation, agentFailureContainment),
    agentProviderMode: agentProviderSimulation.mode,
    agentProviderIssue: agentProviderSimulation.observedIssue,
    agentProviderContainmentOk: agentProviderSimulation.containmentOk,
    agentProviderRecoveryOk: agentProviderSimulation.recoveryOk,
    providerRequestCount: record.providerEvidence?.requestCount ?? null,
    providerFirstRequestAt: record.providerEvidence?.firstRequestStartAt ?? null,
    providerLastResponseAt: record.providerEvidence?.lastResponseEndAt ?? null,
    providerDurationMs: record.providerEvidence?.providerDurationMs ?? null,
    providerFirstByteLatencyMs: record.providerEvidence?.firstByteLatencyMs ?? null,
    providerFirstChunkLatencyMs: record.providerEvidence?.firstChunkLatencyMs ?? null,
    agentPreProviderMs: providerTurn?.preProviderMs ?? null,
    agentProviderFinalMs: providerTurn?.providerFinalMs ?? null,
    agentPostProviderMs: providerTurn?.postProviderMs ?? null,
    agentPreProviderDominance: providerTurn?.preProviderDominates ?? null,
    agentProviderRequestCount: providerTurn?.requestCount ?? null,
    agentProviderRequestMissing: providerTurn?.missingProviderRequest ?? null,
    agentProviderAttribution: providerTurn,
    health,
    tcpConnectMaxMs,
    missingDependencyErrors,
    finalGatewayState,
    soakEvidence,
    mcpBridgeEvidence,
    mcpLifecycleEvidence,
    cronRuntimeEvidence,
    execToolEvidence,
    mcpToolCallEvidence,
    dirtyPluginEvidence,
    releaseRecoveryEvidence,
    cronStatusMs: cronRuntimeEvidence.cronStatusMs,
    cronRegisterMs: cronRuntimeEvidence.cronRegisterMs,
    cronRunMs: cronRuntimeEvidence.cronRunMs,
    cronRunCompleted: cronRuntimeEvidence.cronRunCompleted,
    cronTriggerAttributed: cronRuntimeEvidence.cronTriggerAttributed,
    execSafeCommandMs: execToolEvidence.safeCommandMs,
    execSafeCommandSucceeded: execToolEvidence.safeCommandSucceeded,
    execDangerousCommandBlocked: execToolEvidence.dangerousCommandBlocked,
    execDangerousPayloadExecuted: execToolEvidence.dangerousPayloadExecuted,
    execOutputTruncated: execToolEvidence.outputTruncated,
    execTimeoutMs: execToolEvidence.timeoutMs,
    execProcessLeaks: execToolEvidence.processLeaks,
    mcpToolsCallMs: mcpToolCallEvidence.toolsCallMs,
    mcpInvalidToolsCallMs: mcpToolCallEvidence.invalidToolsCallMs,
    mcpToolCallSucceeded: mcpToolCallEvidence.safeToolSucceeded,
    mcpSafeToolName: mcpToolCallEvidence.safeToolName,
    mcpToolCallErrorAttributed: mcpToolCallEvidence.invalidToolErrorAttributed,
    dirtyPluginDetected: dirtyPluginEvidence.dirtyPluginDetected,
    dirtyPluginReported: dirtyPluginEvidence.dirtyPluginReported,
    dirtyPluginChecksumPreserved: dirtyPluginEvidence.dirtyPluginChecksumPreserved,
    doctorDestructiveChangeCount: dirtyPluginEvidence.doctorDestructiveChangeCount,
    pluginsUsableWithDirtyState: dirtyPluginEvidence.pluginsUsableWithDirtyState,
    gatewaySurvivedDirtyPlugin: dirtyPluginEvidence.gatewaySurvivedDirtyPlugin,
    doctorFixSucceeded: releaseRecoveryEvidence.doctorFixSucceeded,
    doctorUnrepairedFindingCount: releaseRecoveryEvidence.doctorUnrepairedFindingCount,
    updateRetryVersionDrift: releaseRecoveryEvidence.updateRetryVersionDrift,
    rollbackAvailable: releaseRecoveryEvidence.rollbackAvailable,
    rollbackSucceeded: releaseRecoveryEvidence.rollbackSucceeded,
    pluginsUsableAfterUpgrade: releaseRecoveryEvidence.pluginsUsableAfterUpgrade,
    pluginsUsableAfterRollback: releaseRecoveryEvidence.pluginsUsableAfterRollback,
    rollbackPreservedPluginData: releaseRecoveryEvidence.rollbackPreservedPluginData,
    mcpInitializeMs: mcpLifecycleEvidence.initializeMs,
    mcpToolsListMs: mcpLifecycleEvidence.toolsListMs,
    mcpShutdownMs: mcpLifecycleEvidence.shutdownMs,
    mcpToolCount: mcpLifecycleEvidence.toolCount,
    mcpToolNames: mcpLifecycleEvidence.toolNames,
    mcpProcessExited: mcpLifecycleEvidence.processExited,
    mcpProcessLeaks: mcpLifecycleEvidence.processLeaks,
    mcpErrors: [...mcpBridgeEvidence.errors, ...mcpToolCallEvidence.errors],
    browserAutomationEvidence,
    browserDoctorMs: browserAutomationEvidence.browserDoctorMs,
    browserStartMs: browserAutomationEvidence.browserStartMs,
    browserTabsMs: browserAutomationEvidence.browserTabsMs,
    browserOpenMs: browserAutomationEvidence.browserOpenMs,
    browserSnapshotMs: browserAutomationEvidence.browserSnapshotMs,
    browserStopMs: browserAutomationEvidence.browserStopMs,
    browserTabCount: browserAutomationEvidence.browserTabCount,
    browserSnapshotOk: browserAutomationEvidence.browserSnapshotOk,
    browserStopped: browserAutomationEvidence.browserStopped,
    browserProcessLeaks: browserAutomationEvidence.available ? (browserAutomationEvidence.browserStopped === false ? 1 : 0) : null,
    browserErrors: browserAutomationEvidence.errors,
    mediaUnderstandingEvidence,
    mediaDescribeMs: mediaUnderstandingEvidence.mediaDescribeMs,
    mediaTimeoutObserved: mediaUnderstandingEvidence.mediaTimeoutObserved,
    mediaCommandTimedOut: mediaUnderstandingEvidence.mediaCommandTimedOut,
    mediaStatusAfterTimeoutMs: mediaUnderstandingEvidence.mediaStatusAfterTimeoutMs,
    mediaGatewayStatusWorks: mediaUnderstandingEvidence.gatewayStatusWorks,
    mediaErrors: mediaUnderstandingEvidence.errors,
    networkOfflineEvidence,
    officialPluginEvidence,
    officialPluginInstallOk: officialPluginEvidence.available ? officialPluginEvidence.ok : null,
    officialPluginSecurityBlocks: officialPluginEvidence.available ? officialPluginEvidence.securityBlockCount : null,
    officialPluginInstallMs: officialPluginEvidence.available ? officialPluginEvidence.durationMs : null,
    networkTurnMs: networkOfflineEvidence.networkTurnMs,
    networkFailureObserved: networkOfflineEvidence.networkFailureObserved,
    networkCommandTimedOut: networkOfflineEvidence.networkCommandTimedOut,
    networkStatusAfterFailureMs: networkOfflineEvidence.networkStatusAfterFailureMs,
    networkGatewayStatusWorks: networkOfflineEvidence.gatewayStatusWorks,
    networkErrors: networkOfflineEvidence.errors,
    soakDurationMs: soakEvidence.durationMs,
    soakIterations: soakEvidence.iterations,
    soakCommandP95Ms: soakEvidence.commandP95Ms,
    soakCommandMaxMs: soakEvidence.commandMaxMs,
    soakHealthP95Ms: soakEvidence.healthP95Ms,
    soakHealthMaxMs: soakEvidence.healthMaxMs,
    soakHealthFailures: soakEvidence.healthFailures,
    soakCommandFailures: soakEvidence.commandFailures,
    rssGrowthMb,
    gatewayRssGrowthMb,
    listeningFailures,
    readinessFailures,
    gatewayRestartCount,
    pluginLoadFailures,
    metadataScanMentions,
    configNormalizationMentions,
    providerLoadMentions,
    modelCatalogMentions,
    providerTimeoutMentions,
    eventLoopDelayMentions,
    v8DiagnosticMentions,
    v8ReportCount,
    heapSnapshotCount,
    diagnosticArtifactBytes,
    nodeCpuProfileCount,
    nodeHeapProfileCount,
    nodeTraceEventCount,
    nodeProfileArtifactBytes,
    nodeProfileTopFunction: nodeProfileTopFunction?.functionName ?? null,
    nodeProfileTopFunctionMs: nodeProfileTopFunction?.selfMs ?? null,
    nodeProfileTopFunctionUrl: nodeProfileTopFunction?.url ?? null,
    nodeHeapTopFunction: nodeHeapTopFunction?.functionName ?? null,
    nodeHeapTopFunctionMb: nodeHeapTopFunction?.selfSizeMb ?? null,
    nodeHeapTopFunctionUrl: nodeHeapTopFunction?.url ?? null,
    heapSnapshotBytes,
    diagnosticReportCount,
    diagnosticReportBytes,
    profilingEnabled: record.profiling?.enabled === true,
    profilingResourceInterpretation: record.profiling?.interpretation ?? null,
    profilingBaselineEligible: record.profiling?.baselineEligible ?? null,
    profilingAffectsPerformanceMeasurements: profilingAffectsPerformance(record.profiling),
    profilingAffectsResourceMeasurements: record.profiling?.affectsResourceMeasurements === true,
    resourceSampleCount: resourceSummary.sampleCount,
    resourceSampleArtifacts: resourceSummary.artifacts,
    resourcePeakCommandTreeRssMb: resourceSummary.peakCommandTreeRssMb,
    resourcePeakGatewayRssMb: resourceSummary.peakGatewayRssMb,
    resourceByRole: resourceSummary.byRole,
    resourceTopRolesByRss: resourceSummary.topRolesByRss,
    resourceTopRolesByCpu: resourceSummary.topRolesByCpu,
    resourcePeakRssAtMs: resourceSummary.peakRssSample?.elapsedMs ?? null,
    resourcePeakCpuAtMs: resourceSummary.peakCpuSample?.elapsedMs ?? null,
    resourcePeakRssProcess: compactSampleProcess(resourceSummary.peakRssSample?.topProcess),
    resourcePeakCpuProcess: compactSampleProcess(resourceSummary.peakCpuSample?.topProcess),
    resourceTrend: resourceSummary.trend,
    resourceTopByRss: resourceSummary.topByRss,
    resourceTopByCpu: resourceSummary.topByCpu,
    channelWorkflowResources,
    channelWorkflowResourceTopByGatewayRss: channelWorkflowResources.topByGatewayRss,
    channelWorkflowResourceTopByTrackedRss: channelWorkflowResources.topByTrackedRss,
    openclawTimelineAvailable: timelineSummary.available,
    openclawTimelineArtifacts: timelineSummary.timelineArtifacts,
    openclawTimelineEventCount: timelineSummary.eventCount,
    openclawTimelineParseErrors: timelineSummary.parseErrorCount,
    openclawSlowestSpanName: timelineSummary.slowestSpanName,
    openclawSlowestSpanMs: timelineSummary.slowestSpanMs,
    openclawRepeatedSpanCount: timelineSummary.repeatedSpanCount,
    openclawOpenSpanCount: timelineSummary.openSpanCount,
    openclawOpenRequiredSpanCount: openRequiredSpans.length,
    openclawMissingRequiredSpanCount: missingRequiredSpans.length,
    openclawMissingRequiredSpans: missingRequiredSpans,
    openclawMissingRequiredSpanSeverity: diagnosticContract.missingSpanSeverity,
    openclawDiagnosticsContract: diagnosticContract,
    openclawOpenSpans: timelineSummary.openSpans,
    openclawInterruptedRestartSpanCount: timelineSummary.interruptedRestartSpanCount,
    openclawInterruptedRestartSpans: timelineSummary.interruptedRestartSpans,
    openclawTerminalGatewayPid: timelineSummary.terminalGatewayPid,
    openclawKeySpans: timelineSummary.keySpans,
    openclawEventLoopMaxMs: timelineSummary.eventLoopMaxMs,
    openclawLogEventLoopMaxMs: logSummary.livenessWarnings.maxEventLoopDelayMaxMs,
    openclawLivenessWarningCount: logSummary.livenessWarnings.count,
    embeddedRunTraceCount: logSummary.embeddedRuns.eventCount,
    embeddedRunStartupTraceCount: logSummary.embeddedRuns.startupCount,
    embeddedRunPrepTraceCount: logSummary.embeddedRuns.prepCount,
    embeddedRunTraceMaxMs: logSummary.embeddedRuns.totalMaxMs,
    embeddedRunTopStages: logSummary.embeddedRuns.topStages,
    openclawProviderRequestMaxMs: timelineSummary.providerRequestMaxMs,
    openclawChildProcessFailedCount: timelineSummary.childProcessFailedCount,
    runtimeDepsStagingPluginId: timelineSummary.runtimeDepsStagePluginId,
    runtimeDepsLogEvidence,
    runtimeDepsInstallCount: runtimeDepsLogEvidence.installCount,
    runtimeDepsInstallMaxMs: runtimeDepsLogEvidence.installMaxMs,
    runtimeDepsPostbuildMaxMs: runtimeDepsLogEvidence.postbuildMaxMs,
    coldRuntimeDepsInstallCount: runtimeDepsLogEvidence.coldStart.installCount,
    coldRuntimeDepsStagingMs: runtimeDepsLogEvidence.coldStart.installMaxMs,
    warmRuntimeDepsRestageCount: runtimeDepsLogEvidence.warmRestart.installCount,
    warmRuntimeDepsStagingMs: runtimeDepsLogEvidence.warmRestart.installMaxMs,
    runtimeDepsWarmReuseOk: runtimeDepsLogEvidence.warmRestart.installCount === null
      ? null
      : runtimeDepsLogEvidence.warmRestart.installCount === 0,
    pluginMetadataScanCount: openclawDiagnostics.pluginMetadataScanCount,
    configNormalizationCount: openclawDiagnostics.configNormalizationCount,
    runtimeDepsStagingMs,
    eventLoopDelayMs,
    providerModelTimingMs,
    diagnosticCorrelation: buildDiagnosticCorrelation({
      resourceSummary,
      timelineSummary,
      logSummary,
      nodeProfileTopFunction,
      nodeHeapTopFunction,
      eventLoopDelayMs,
      runtimeDepsStagingMs,
      providerModelTimingMs
    })
  };
  record.thresholdPolicy = thresholdPolicy.report;
  const performanceAssessment = buildInstrumentedPerformanceAssessment({
    record,
    thresholds,
    roleThresholds,
    violations
  });
  const effectiveViolations = performanceAssessment
    ? violations.filter((violation) => !isSkippedPerformanceViolation(record, violation))
    : violations;
  if (performanceAssessment) {
    record.performanceThresholdAssessment = performanceAssessment;
    record.measurements.performanceThresholdSkippedCount =
      performanceAssessment.skippedCount;
  } else {
    delete record.performanceThresholdAssessment;
    delete record.measurements.performanceThresholdSkippedCount;
  }

  if (effectiveViolations.length > 0) {
    if (originalStatus === "PASS") {
      const targetViolation = effectiveViolations.some(
        (violation) => violation.failureDomain !== "kova-harness"
      );
      record.status = targetViolation ? "FAIL" : "BLOCKED";
    }
    record.violations = effectiveViolations;
  } else {
    delete record.violations;
  }

  return record;
}

function targetRuntimeEvidenceIssue(runtimeCalibration, targetRuntime) {
  if ((runtimeCalibration ?? []).length === 0 || targetRuntime === undefined) {
    return null;
  }
  if (
    !targetRuntime ||
    !["ok", "compatibility-fallback"].includes(targetRuntime.collectionStatus)
  ) {
    return targetRuntime?.collectionStatus ?? "missing";
  }
  if (
    typeof targetRuntime.nodeVersion !== "string" ||
    !/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(targetRuntime.nodeVersion)
  ) {
    return "invalid-node-version";
  }
  if (
    !Number.isSafeInteger(targetRuntime.gatewayPid) ||
    targetRuntime.gatewayPid <= 0 ||
    !Number.isSafeInteger(targetRuntime.expectedGatewayPid) ||
    targetRuntime.expectedGatewayPid <= 0 ||
    !Number.isSafeInteger(targetRuntime.gatewayPort) ||
    targetRuntime.gatewayPort <= 0 ||
    !Number.isSafeInteger(targetRuntime.expectedGatewayPort) ||
    targetRuntime.expectedGatewayPort <= 0
  ) {
    return "invalid-gateway-identity";
  }
  if (
    targetRuntime.gatewayPid !== targetRuntime.expectedGatewayPid ||
    targetRuntime.gatewayPort !== targetRuntime.expectedGatewayPort
  ) {
    return "identity-mismatch";
  }
  return null;
}

function buildInstrumentedPerformanceAssessment({
  record,
  thresholds,
  roleThresholds,
  violations
}) {
  if (!profilingAffectsPerformance(record.profiling)) {
    return null;
  }

  const skipped = new Map();
  for (const [metric, threshold] of Object.entries(thresholds ?? {})) {
    if (!Number.isFinite(threshold) || !isInstrumentedPerformanceMetric(metric)) {
      continue;
    }
    const measurementMetric = measurementMetricForThreshold(metric);
    const actual = measurementMetricValue(record.measurements ?? {}, measurementMetric);
    addSkippedPerformanceAssessment(skipped, {
      metric,
      measurementMetric,
      threshold,
      actual,
      affected: instrumentedPerformanceThresholdAffected(record, {
        metric,
        actual
      })
    });
  }

  for (const [role, rolePolicy] of Object.entries(roleThresholds ?? {})) {
    const roleMeasurements = record.measurements?.resourceByRole?.[role] ?? {};
    for (const [metric, threshold] of Object.entries(rolePolicy ?? {})) {
      if (!Number.isFinite(threshold) || !isInstrumentedPerformanceMetric(metric)) {
        continue;
      }
      const actual = metric === "peakProcessRssMb"
        ? roleMeasurements.peakRssProcess?.rssMb ?? null
        : roleMeasurements[metric] ?? null;
      addSkippedPerformanceAssessment(skipped, {
        metric: `resourceByRole.${role}.${metric}`,
        measurementMetric: metric,
        role,
        threshold,
        actual,
        affected: instrumentedPerformanceThresholdAffected(record, {
          metric,
          role,
          actual
        })
      });
    }
  }

  for (const violation of violations) {
    if (!isSkippedPerformanceViolation(record, violation)) {
      continue;
    }
    addSkippedPerformanceAssessment(skipped, {
      metric: violation.metric,
      measurementMetric: measurementMetricForThreshold(violation.metric),
      role: violation.role ?? null,
      threshold: thresholdFromExpected(violation.expected),
      actual: violation.actual,
      observedOverThreshold: true,
      originalMessage: violation.message ?? null
    });
  }

  const entries = [...skipped.values()].toSorted((left, right) =>
    Number(right.observedOverThreshold) - Number(left.observedOverThreshold) ||
    left.metric.localeCompare(right.metric)
  );
  const complete = entries.length === 0;
  return {
    schemaVersion: "kova.performanceThresholdAssessment.v1",
    complete,
    skippedCount: entries.length,
    reason: complete ? null : INSTRUMENTED_PERFORMANCE_REASON,
    rerun: complete
      ? null
      : "rerun without profiling for gateable performance evidence",
    skipped: entries
  };
}

function addSkippedPerformanceAssessment(target, assessment) {
  if (assessment.affected === false) {
    return;
  }
  const existing = target.get(assessment.metric);
  const actual = finiteNumberOrNull(assessment.actual);
  const threshold = finiteNumberOrNull(assessment.threshold);
  const observedOverThreshold = assessment.observedOverThreshold === true;
  const next = {
    metric: assessment.metric,
    measurementMetric: assessment.measurementMetric,
    role: assessment.role ?? null,
    status: "SKIPPED",
    reason: INSTRUMENTED_PERFORMANCE_REASON,
    threshold,
    actual,
    observedOverThreshold,
    affectsRecordStatus: false,
    message: assessment.originalMessage
      ? `${assessment.originalMessage}; threshold not adjudicated because the run was instrumented`
      : `${assessment.metric} was not adjudicated because the run was instrumented`
  };
  if (
    !existing ||
    Number(next.observedOverThreshold) > Number(existing.observedOverThreshold) ||
    (
      next.observedOverThreshold === existing.observedOverThreshold &&
      (next.actual ?? Number.NEGATIVE_INFINITY) >
        (existing.actual ?? Number.NEGATIVE_INFINITY)
    )
  ) {
    target.set(assessment.metric, next);
  }
}

function isSkippedPerformanceViolation(record, violation) {
  return violation?.failureDomain !== "kova-harness" &&
    Number.isFinite(violation?.actual) &&
    isInstrumentedPerformanceMetric(violation?.metric) &&
    instrumentedPerformanceThresholdAffected(record, {
      metric: violation.metric,
      role: violation.role,
      actual: violation.actual,
      command: violation.command
    });
}

function thresholdFromExpected(expected) {
  if (Number.isFinite(expected)) {
    return expected;
  }
  const match = String(expected ?? "").match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function finiteNumberOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function strictestPrimaryThreshold(headlineThreshold, roleThreshold) {
  if (typeof headlineThreshold !== "number") {
    return null;
  }
  return typeof roleThreshold === "number"
    ? Math.min(headlineThreshold, roleThreshold)
    : headlineThreshold;
}

function collectAgentTurns(record, providerEvidence, scenario, timelineSummary, logSummary) {
  const turns = [];
  let index = 0;
  const scenarioExpectedText = scenario.agent?.expectedText ?? null;
  for (const phase of record.phases ?? []) {
    for (const result of phase.results ?? []) {
      if (!isAgentMessageCommand(result.command)) {
        continue;
      }
      index += 1;
      const expectedFailure = phase.expectedAgentFailure === true || scenario.agent?.expectedFailure === true;
      const gatewaySession = extractGatewaySessionTurn(result);
      const channelModelTurn = gatewaySession ? null : extractChannelModelTurn(result);
      const expectedText = channelModelTurn ? channelModelTurn.expectedText : scenarioExpectedText;
      const timingResult = gatewaySession
        ? resultForActiveTurnWindow(result, gatewaySession)
        : (channelModelTurn ? resultForChannelModelTurnWindow(result, channelModelTurn) : result);
      const attribution = computeProviderTurnAttribution(timingResult, providerEvidence);
      const response = extractAgentResponse(result);
      const expectedTextPresent = typeof expectedText === "string" && expectedText.length > 0
        ? responseMatchesExpectedText(response, expectedText)
        : null;
      const commandPassed = commandResultPassed(result) && result.timedOut !== true;
      const expectedFailureObserved = expectedFailure === true && commandPassed;
      const normalResponseOk = channelModelTurn
        ? commandPassed
        : commandPassed && response.usable === true && (expectedTextPresent !== false);
      const isAgentCliTurn = isAgentCliMessageCommand(result.command);
      const phaseBreakdown = buildAgentTurnBreakdown({ result: timingResult, attribution, timelineSummary, logSummary });
      const turnDiagnostics = summarizeActiveTurnDiagnostics({
        timelineSummary,
        activeStartedAtEpochMs: timingResult.startedAtEpochMs,
        activeFinishedAtEpochMs: timingResult.finishedAtEpochMs,
        gatewaySession
      });
      const gatewaySessionPreProviderAttribution = gatewaySession
        ? buildGatewaySessionPreProviderAttribution({
            label: agentTurnLabel(phase.id, index),
            phaseId: phase.id,
            activeStartedAtEpochMs: timingResult.startedAtEpochMs,
            activeFinishedAtEpochMs: timingResult.finishedAtEpochMs,
            attribution,
            timelineSummary
          })
        : null;
      const agentCliPreProviderAttribution = isAgentCliTurn
        ? buildAgentCliPreProviderAttribution({
            label: agentTurnLabel(phase.id, index),
            phaseId: phase.id,
            activeStartedAtEpochMs: timingResult.startedAtEpochMs,
            activeFinishedAtEpochMs: timingResult.finishedAtEpochMs,
            attribution,
            timelineSummary
          })
        : null;
      turns.push({
        schemaVersion: "kova.agentTurnEvidence.v1",
        index,
        phaseId: phase.id,
        label: agentTurnLabel(phase.id, index),
        expectedFailure,
        expectedFailureObserved,
        command: result.command,
        status: result.status,
        timedOut: result.timedOut === true,
        totalTurnMs: timingResult.durationMs ?? attribution?.totalTurnMs ?? null,
        commandStartedAt: timingResult.startedAt ?? null,
        commandStartedAtEpochMs: timingResult.startedAtEpochMs ?? null,
        commandFinishedAt: timingResult.finishedAt ?? null,
        commandFinishedAtEpochMs: timingResult.finishedAtEpochMs ?? null,
        rawCommandStartedAt: result.startedAt ?? null,
        rawCommandStartedAtEpochMs: result.startedAtEpochMs ?? null,
        rawCommandFinishedAt: result.finishedAt ?? null,
        rawCommandFinishedAtEpochMs: result.finishedAtEpochMs ?? null,
        rawCommandDurationMs: result.durationMs ?? null,
        gatewaySession,
        channelModelTurn,
        expectedText,
        responseText: response.text,
        responseOk: expectedFailure ? expectedFailureObserved : normalResponseOk,
        assistantResponseOk: normalResponseOk,
        expectedTextPresent,
        preProviderMs: attribution?.preProviderMs ?? null,
        providerFinalMs: attribution?.providerFinalMs ?? null,
        postProviderMs: attribution?.postProviderMs ?? null,
        firstByteLatencyMs: attribution?.firstByteLatencyMs ?? null,
        firstChunkLatencyMs: attribution?.firstChunkLatencyMs ?? null,
        preProviderDominance: attribution?.preProviderDominates ?? null,
        providerDominance: attribution?.providerDominates ?? null,
        requestCount: attribution?.requestCount ?? 0,
        missingProviderRequest: attribution?.missingProviderRequest ?? true,
        providerRoutes: attribution?.routes ?? [],
        providerModels: attribution?.models ?? [],
        providerStatuses: attribution?.statuses ?? [],
        providerModes: attribution?.modes ?? [],
        providerOutcomes: attribution?.outcomes ?? [],
        providerErrorClasses: attribution?.errorClasses ?? [],
        providerErrors: attribution?.errors ?? [],
        providerRequestTiming: attribution?.providerRequestTiming ?? null,
        providerAfterCommandEnd: attribution?.providerAfterCommandEnd ?? false,
        providerLateByMs: attribution?.providerLateByMs ?? null,
        phaseBreakdown,
        turnDiagnostics,
        gatewaySessionPreProviderAttribution,
        agentCliPreProviderAttribution,
        metadataScanCount: turnDiagnostics.metadataScan.count,
        metadataScanTotalMs: turnDiagnostics.metadataScan.totalDurationMs,
        metadataScanMaxMs: turnDiagnostics.metadataScan.maxDurationMs,
        eventLoopMaxMs: turnDiagnostics.eventLoop.maxMs,
        sessionPollCount: turnDiagnostics.sessionPolling.pollCount,
        cleanupMs: phaseBreakdown?.buckets?.cleanupMs ?? null,
        processLeaks: result.processSnapshots?.leaks ?? null,
        processLeakCount: result.processSnapshots?.leaks?.leakCount ?? null,
        leakedProcesses: result.processSnapshots?.leaks?.leakedProcesses ?? [],
        healthOk: phase.metrics?.health?.ok ?? null,
        healthP95Ms: phase.metrics?.healthSummary?.p95Ms ?? null,
        resourceSamples: summarizeTurnResources(result.resourceSamples)
      });
    }
  }
  return turns;
}

function preferredPreProviderAttributionSummary(...summaries) {
  return summaries.find((summary) => summary?.count > 0) ?? summaries[0];
}

function checkGatewaySessionTransport(violations, agentTurns, scenario) {
  if (scenario.id !== "gateway-session-send-turn" && scenario.surface !== "gateway-session-send-turn") {
    return;
  }
  for (const turn of agentTurns) {
    if (!turn.gatewaySession) {
      continue;
    }
    const transport = turn.gatewaySession.gatewayTransportKind;
    if (transport === "direct-gateway-rpc") {
      continue;
    }
    violations.push({
      kind: "harness",
      metric: "gatewayTransport.kind",
      expected: "direct-gateway-rpc",
      actual: transport ?? "unknown",
      phaseId: turn.phaseId,
      message: `Gateway session benchmark used ${transport ?? "unknown"} transport; direct Gateway RPC is required for Gateway product measurement`
    });
  }
}

function checkChannelModelTurnCases(violations, agentTurns) {
  for (const turn of agentTurns) {
    const failedCases = Array.isArray(turn.channelModelTurn?.failedModelTurnCases)
      ? turn.channelModelTurn.failedModelTurnCases
      : [];
    for (const failedCase of failedCases) {
      const caseId = typeof failedCase?.id === "string" && failedCase.id.length > 0
        ? failedCase.id
        : "unknown";
      const failedInvariants = Array.isArray(failedCase.failedInvariants)
        ? failedCase.failedInvariants.filter((invariant) => invariant?.id || invariant?.reason)
        : [];
      const failedInvariant = failedInvariants[0]?.id ?? null;
      const failedInvariantSummary = formatChannelInvariantFailures(failedInvariants);
      const atomCoverage = formatChannelAtomCoverage(failedCase.capabilities);
      const workflow = typeof failedCase.workflow === "string" && failedCase.workflow.length > 0
        ? failedCase.workflow
        : null;
      const inventoryWorkflow = typeof failedCase.inventoryWorkflow === "string" && failedCase.inventoryWorkflow.length > 0
        ? failedCase.inventoryWorkflow
        : null;
      const matrix = compactChannelWorkflowMatrix(failedCase.matrix);
      const matrixDetail = formatChannelWorkflowMatrix(matrix);
      const ownerArea = typeof failedCase.ownerArea === "string" && failedCase.ownerArea.length > 0
        ? failedCase.ownerArea
        : "OpenClaw";
      const detail = [
        workflow ? `workflow ${workflow}` : null,
        inventoryWorkflow ? `inventory ${inventoryWorkflow}` : null,
        matrixDetail ? `matrix ${matrixDetail}` : null,
        failedInvariantSummary,
        atomCoverage ? `atoms ${atomCoverage}` : null
      ].filter(Boolean).join("; ");
      violations.push({
        kind: "channel",
        metric: `channelModelTurn.case.${caseId}`,
        phaseId: turn.phaseId,
        workflow,
        inventoryWorkflow,
        matrix,
        failedInvariant,
        failedInvariants,
        failedInvariantCount: failedInvariants.length,
        failedInvariantSummary,
        atomCoverage,
        userAction: typeof failedCase.userAction === "string" ? failedCase.userAction : null,
        ownerArea,
        expected: "passed",
        actual: "failed",
        message: `channel model turn case ${caseId} failed${failedCase?.reason ? `: ${failedCase.reason}` : ""}${detail ? ` (${detail})` : ""}`
      });
    }
  }
}

function formatChannelAtomCoverage(capabilities) {
  if (!Array.isArray(capabilities) || capabilities.length === 0) {
    return null;
  }
  const atoms = capabilities
    .map((capability) => [capability?.group, capability?.id].filter(Boolean).join("/"))
    .filter(Boolean);
  return atoms.length > 0 ? atoms.join(", ") : null;
}

function formatChannelInvariantFailures(invariants) {
  if (!Array.isArray(invariants) || invariants.length === 0) {
    return null;
  }
  const ids = invariants
    .map((invariant) => invariant?.id)
    .filter((id) => typeof id === "string" && id.length > 0);
  if (ids.length === 0) {
    return null;
  }
  const shown = ids.slice(0, 4);
  const suffix = ids.length > shown.length ? `, +${ids.length - shown.length} more` : "";
  return `${ids.length === 1 ? "invariant" : "invariants"} ${shown.join(", ")}${suffix}`;
}

function extractGatewaySessionTurn(result) {
  if (!result?.command?.includes("run-gateway-session-send-turn.mjs")) {
    return null;
  }
  const payload = parseJsonObject(result.stdout);
  if (!payload || payload.surface !== "gateway-session-send-turn") {
    return null;
  }
  const activeStartedAtEpochMs = numberOrNull(payload.activeStartedAtEpochMs ?? payload.sendStartedAtEpochMs);
  const activeFinishedAtEpochMs = numberOrNull(
    payload.activeFinishedAtEpochMs ??
    payload.assistantMatchedAtEpochMs ??
    payload.finishedAtEpochMs
  );
  if (activeStartedAtEpochMs === null || activeFinishedAtEpochMs === null || activeFinishedAtEpochMs < activeStartedAtEpochMs) {
    return null;
  }
  const activeTurnMs = numberOrNull(payload.activeTurnMs) ?? Math.max(0, activeFinishedAtEpochMs - activeStartedAtEpochMs);
  return {
    schemaVersion: "kova.gatewaySessionTurn.v1",
    method: payload.method ?? "sessions.send",
    surface: payload.surface,
    createSession: typeof payload.createSession === "boolean" ? payload.createSession : null,
    minAssistantCount: numberOrNull(payload.minAssistantCount),
    sessionKey: payload.sessionKey ?? null,
    runId: payload.runId ?? null,
    gatewayTransportKind: payload.gatewayTransport?.kind ?? null,
    activeStartedAtEpochMs,
    activeFinishedAtEpochMs,
    activeTurnMs,
    sessionCreateDurationMs: numberOrNull(payload.sessionCreateDurationMs),
    sendDurationMs: numberOrNull(payload.sendDurationMs),
    timeToFirstAssistantMs: numberOrNull(payload.timeToFirstAssistantMs),
    timeToMatchedAssistantMs: numberOrNull(payload.timeToMatchedAssistantMs),
    assistantMessageCount: numberOrNull(payload.assistantMessageCount),
    historyPollCount: numberOrNull(payload.historyPollCount),
    historyErrorCount: numberOrNull(payload.historyErrorCount),
    expectedTextPresent: typeof payload.expectedTextPresent === "boolean" ? payload.expectedTextPresent : null
  };
}

function extractChannelModelTurn(result) {
  if (!result?.command?.includes("run-channel-probe-turn.mjs")) {
    return null;
  }
  const payload = parseJsonObject(result.stdout);
  if (!payload || payload.schemaVersion !== "kova.channelProbeTurnRun.v1") {
    return null;
  }
  const activeStartedAtEpochMs = numberOrNull(payload.activeStartedAtEpochMs);
  const activeFinishedAtEpochMs = numberOrNull(payload.activeFinishedAtEpochMs);
  if (activeStartedAtEpochMs === null || activeFinishedAtEpochMs === null || activeFinishedAtEpochMs < activeStartedAtEpochMs) {
    return null;
  }
  const activeTurnMs = numberOrNull(payload.activeTurnMs) ?? Math.max(0, activeFinishedAtEpochMs - activeStartedAtEpochMs);
  return {
    schemaVersion: "kova.channelModelTurn.v1",
    surface: "channel-model-turn-baseline",
    inboundEventId: payload.inboundEventId ?? null,
    routeSessionKey: payload.routeSessionKey ?? null,
    expectedText: typeof payload.expectedText === "string" && payload.expectedText.length > 0 ? payload.expectedText : null,
    finalText: typeof payload.finalText === "string" && payload.finalText.length > 0 ? payload.finalText : null,
    expectedTextPresent: typeof payload.finalText === "string" && typeof payload.expectedText === "string"
      ? textEquals(payload.finalText, payload.expectedText)
      : null,
    providerRequestDelta: numberOrNull(payload.providerRequestDelta),
    modelTurnCaseCount: numberOrNull(payload.modelTurnCaseCount),
    capabilityRowCount: numberOrNull(payload.capabilityRowCount),
    failedModelTurnCases: Array.isArray(payload.failedModelTurnCases) || Array.isArray(payload.failedCases)
      ? (payload.failedModelTurnCases ?? payload.failedCases).map(compactFailedModelTurnCase).filter(Boolean)
      : [],
    activeStartedAtEpochMs,
    activeFinishedAtEpochMs,
    activeTurnMs
  };
}

function compactFailedModelTurnCase(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  return {
    id: typeof value.id === "string" ? value.id : null,
    workflow: typeof value.workflow === "string" ? value.workflow : null,
    inventoryWorkflow: typeof value.inventoryWorkflow === "string" ? value.inventoryWorkflow : null,
    matrix: compactChannelWorkflowMatrix(value.matrix),
    userAction: typeof value.userAction === "string" ? value.userAction : null,
    ownerArea: typeof value.ownerArea === "string" ? value.ownerArea : null,
    capabilities: Array.isArray(value.capabilities)
      ? value.capabilities.map((capability) => ({
          group: typeof capability?.group === "string" ? capability.group : null,
          id: typeof capability?.id === "string" ? capability.id : null
        })).filter((capability) => capability.group || capability.id)
      : [],
    reason: typeof value.reason === "string" ? value.reason : null,
    failedInvariants: Array.isArray(value.failedInvariants)
      ? value.failedInvariants.map((invariant) => ({
          id: typeof invariant?.id === "string" ? invariant.id : null,
          reason: typeof invariant?.reason === "string" ? invariant.reason : null
        }))
      : []
  };
}

function compactChannelWorkflowMatrix(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const matrix = {
    content: typeof value.content === "string" ? value.content : null,
    route: typeof value.route === "string" ? value.route : null,
    delivery: typeof value.delivery === "string" ? value.delivery : null,
    lifecycle: typeof value.lifecycle === "string" ? value.lifecycle : null
  };
  return Object.values(matrix).some(Boolean) ? matrix : null;
}

function formatChannelWorkflowMatrix(matrix) {
  if (!matrix) {
    return null;
  }
  return [
    matrix.content,
    matrix.route,
    matrix.delivery,
    matrix.lifecycle
  ].filter(Boolean).join("/");
}

function resultForActiveTurnWindow(result, gatewaySession) {
  return {
    ...result,
    startedAt: isoOrNull(gatewaySession.activeStartedAtEpochMs),
    startedAtEpochMs: gatewaySession.activeStartedAtEpochMs,
    finishedAt: isoOrNull(gatewaySession.activeFinishedAtEpochMs),
    finishedAtEpochMs: gatewaySession.activeFinishedAtEpochMs,
    durationMs: gatewaySession.activeTurnMs
  };
}

function resultForChannelModelTurnWindow(result, channelModelTurn) {
  return {
    ...result,
    startedAt: isoOrNull(channelModelTurn.activeStartedAtEpochMs),
    startedAtEpochMs: channelModelTurn.activeStartedAtEpochMs,
    finishedAt: isoOrNull(channelModelTurn.activeFinishedAtEpochMs),
    finishedAtEpochMs: channelModelTurn.activeFinishedAtEpochMs,
    durationMs: channelModelTurn.activeTurnMs
  };
}

function summarizeActiveTurnDiagnostics({ timelineSummary, activeStartedAtEpochMs, activeFinishedAtEpochMs, gatewaySession }) {
  const events = Array.isArray(timelineSummary?.turnAttributionEvents) && timelineSummary.turnAttributionEvents.length > 0
    ? timelineSummary.turnAttributionEvents
    : (Array.isArray(timelineSummary?.events) ? timelineSummary.events : []);
  const windowEvents = events.filter((event) =>
    eventEpochMs(event) !== null &&
    eventEpochMs(event) >= activeStartedAtEpochMs &&
    eventEpochMs(event) <= activeFinishedAtEpochMs
  );
  const metadataScans = windowEvents.filter((event) =>
    (event.type === "span.end" || event.type === "span.error" || event.type === "mark") &&
    event.name === "plugins.metadata.scan"
  );
  const eventLoopSamples = windowEvents.filter((event) => event.type === "eventLoop.sample");
  const eventLoopMaxValues = eventLoopSamples
    .map((event) => numberOrNull(event.maxMs ?? event.eventLoopDelayMs))
    .filter((value) => value !== null);

  return {
    schemaVersion: "kova.activeTurnDiagnostics.v1",
    activeStartedAtEpochMs,
    activeFinishedAtEpochMs,
    metadataScan: summarizeTimedEvents(metadataScans),
    eventLoop: {
      sampleCount: eventLoopSamples.length,
      maxMs: eventLoopMaxValues.length > 0 ? Math.max(...eventLoopMaxValues) : null,
      slowestSample: selectSlowestEventLoopSample(eventLoopSamples)
    },
    sessionPolling: {
      pollCount: gatewaySession?.historyPollCount ?? null,
      errorCount: gatewaySession?.historyErrorCount ?? null
    }
  };
}

function summarizeTimedEvents(events) {
  const durations = events.map((event) => numberOrNull(event.durationMs)).filter((value) => value !== null);
  return {
    count: events.length,
    totalDurationMs: roundNumber(durations.reduce((total, value) => total + value, 0)),
    maxDurationMs: durations.length > 0 ? Math.max(...durations) : null,
    slowest: events
      .filter((event) => typeof event.durationMs === "number")
      .toSorted((left, right) => right.durationMs - left.durationMs)
      .map(compactTimelineEvent)
      .at(0) ?? null
  };
}

function selectSlowestEventLoopSample(samples) {
  return samples
    .map((event) => ({
      timestamp: event.timestamp ?? null,
      maxMs: numberOrNull(event.maxMs ?? event.eventLoopDelayMs),
      p95Ms: numberOrNull(event.p95Ms),
      p99Ms: numberOrNull(event.p99Ms),
      activeSpanName: event.activeSpanName ?? event.spanName ?? null
    }))
    .filter((sample) => sample.maxMs !== null)
    .toSorted((left, right) => right.maxMs - left.maxMs)
    .at(0) ?? null;
}

function compactTimelineEvent(event) {
  return {
    type: event.type ?? null,
    name: event.name ?? null,
    timestamp: event.timestamp ?? null,
    durationMs: event.durationMs ?? null,
    pluginId: event.pluginId ?? event.attributes?.pluginId ?? null
  };
}

function eventEpochMs(event) {
  const direct = numberOrNull(event?.timestampEpochMs ?? event?.timeEpochMs);
  if (direct !== null) {
    return direct;
  }
  const parsed = Date.parse(event?.timestamp ?? event?.time ?? "");
  return Number.isFinite(parsed) ? parsed : null;
}

function parseJsonObject(text) {
  try {
    const parsed = JSON.parse(String(text ?? ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function evaluateAgentFailureContainment({ turns, record, thresholds, gatewayExpected = true, health = null }) {
  const healthFailures = countPostStartupHealthFailures(record, health);
  const healthFailureBreakdown = postStartupHealthFailureBreakdown(health);
  if (turns.length === 0) {
    return {
      schemaVersion: "kova.agentFailureContainment.v1",
      processLeakCount: 0,
      leakLimit: 0,
      leakedProcesses: [],
      processLeaksOk: true,
      finalGatewayState: record.finalMetrics?.service?.gatewayState ?? null,
      gatewayHealthy: gatewayExpected ? null : true,
      healthFailures,
      healthFailureScope: "post-startup",
      healthFailureBreakdown,
      healthLimit: 0,
      statusWorks: null,
      dashboardResponsive: null,
      tuiResponsive: null
    };
  }
  const leakCount = turns.reduce((total, turn) => total + (turn.processLeakCount ?? 0), 0);
  const leakedProcesses = turns.flatMap((turn) => (turn.leakedProcesses ?? []).map((process) => ({
    ...process,
    phaseId: turn.phaseId,
    turn: turn.label
  })));
  const leakLimit = typeof thresholds.agentProcessLeaks === "number" ? thresholds.agentProcessLeaks : 0;
  const healthLimit = typeof thresholds.agentContainmentHealthFailures === "number"
    ? thresholds.agentContainmentHealthFailures
    : (typeof thresholds.providerFailureHealthFailures === "number" ? thresholds.providerFailureHealthFailures : 0);
  const finalGatewayState = record.finalMetrics?.service?.gatewayState ?? null;
  const statusCommands = collectResults(record).filter((result) =>
    isStatusCommand(result.command)
  );
  const statusWorks = statusCommands.length === 0 ? null : statusCommands.some((result) => result.status === 0 && result.timedOut !== true);

  return {
    schemaVersion: "kova.agentFailureContainment.v1",
    processLeakCount: leakCount,
    leakLimit,
    leakedProcesses,
    processLeaksOk: leakCount <= leakLimit,
    finalGatewayState,
    gatewayHealthy: gatewayExpected ? finalGatewayState === "running" && healthFailures <= healthLimit : true,
    healthFailures,
    healthFailureScope: "post-startup",
    healthFailureBreakdown,
    healthLimit,
    statusWorks,
    dashboardResponsive: null,
    tuiResponsive: null
  };
}

const isColdReadyCommand = (command) =>
  commandMatchesPerformanceMetric("coldReadyMs", command);
const isWarmReadyCommand = (command) =>
  commandMatchesPerformanceMetric("warmReadyMs", command);
const isUpgradeCommand = (command) =>
  commandMatchesPerformanceMetric("upgradeMs", command);
const isStatusCommand = (command) =>
  commandMatchesPerformanceMetric("statusMs", command);
const isPluginsListCommand = (command) =>
  commandMatchesPerformanceMetric("pluginsListMs", command);
const isPluginUpdateDryRunCommand = (command) =>
  commandMatchesPerformanceMetric("pluginUpdateDryRunMs", command);
const isModelsListCommand = (command) =>
  commandMatchesPerformanceMetric("modelsListMs", command);
const isDoctorFixCommand = (command) =>
  commandMatchesPerformanceMetric("doctorFixMs", command);

function checkAgentFailureContainment(violations, containment) {
  if (containment.processLeaksOk !== true) {
    const first = containment.leakedProcesses[0];
    violations.push({
      kind: "agent-containment",
      metric: "agentProcessLeakCount",
      expected: `<= ${containment.leakLimit}`,
      actual: containment.processLeakCount,
      message: `agent command leaked ${containment.processLeakCount} process(es) after completion${first ? `; first leak ${first.role} pid ${first.pid} ${first.command}` : ""}`
    });
  }
  if (containment.gatewayHealthy === false) {
    violations.push({
      kind: "agent-containment",
      metric: "agentGatewayHealthy",
      expected: `gateway running and post-startup health failures <= ${containment.healthLimit}`,
      actual: `gateway=${containment.finalGatewayState ?? "unknown"} healthFailures=${containment.healthFailures}`,
      message: `gateway was not healthy after agent command; gateway=${containment.finalGatewayState ?? "unknown"}, post-startup health failures=${containment.healthFailures}`
    });
  }
  if (containment.statusWorks === false) {
    violations.push({
      kind: "agent-containment",
      metric: "agentStatusWorks",
      expected: "post-agent status command succeeds",
      actual: false,
      message: "post-agent status command did not succeed"
    });
  }
}

function selectAgentTurn(turns, label) {
  return turns.find((turn) => turn.label === label) ?? null;
}

function collectSlowestProviderTurn(turns) {
  if (turns.length === 0) {
    return null;
  }
  return turns.toSorted((left, right) => (right.totalTurnMs ?? -1) - (left.totalTurnMs ?? -1))[0];
}

function maxTurnDuration(turns) {
  const durations = turns.map((turn) => turn.totalTurnMs).filter((value) => typeof value === "number");
  return durations.length === 0 ? null : Math.max(...durations);
}

function summarizeAgentTurnStats(turns) {
  return {
    schemaVersion: "kova.agentTurnStats.v1",
    count: turns.length,
    totalTurnMs: summarizeNumericField(turns, "totalTurnMs"),
    preProviderMs: summarizeNumericField(turns, "preProviderMs"),
    providerFinalMs: summarizeNumericField(turns, "providerFinalMs"),
    postProviderMs: summarizeNumericField(turns, "postProviderMs"),
    cleanupMs: summarizeNumericField(turns, "cleanupMs"),
    firstByteLatencyMs: summarizeNumericField(turns, "firstByteLatencyMs"),
    processLeakCount: turns.reduce((sum, turn) => sum + (turn.processLeakCount ?? 0), 0),
    missingProviderRequestCount: turns.filter((turn) => turn.missingProviderRequest === true).length,
    responseOkCount: turns.filter((turn) => turn.responseOk === true).length
  };
}

function summarizeAgentTurnDiagnostics(turns) {
  return {
    schemaVersion: "kova.agentTurnDiagnosticsSummary.v1",
    metadataScanCount: turns.reduce((sum, turn) => sum + (turn.metadataScanCount ?? 0), 0),
    metadataScanTotalMs: roundNumber(turns.reduce((sum, turn) => sum + (turn.metadataScanTotalMs ?? 0), 0)),
    metadataScanMaxMs: maxNullable(...turns.map((turn) => turn.metadataScanMaxMs)),
    eventLoopMaxMs: maxNullable(...turns.map((turn) => turn.eventLoopMaxMs)),
    eventLoopSampleCount: turns.reduce((sum, turn) => sum + (turn.turnDiagnostics?.eventLoop?.sampleCount ?? 0), 0),
    sessionPollCount: turns.reduce((sum, turn) => sum + (turn.sessionPollCount ?? 0), 0),
    sessionPollErrorCount: turns.reduce((sum, turn) => sum + (turn.gatewaySession?.historyErrorCount ?? 0), 0)
  };
}

function summarizeNumericField(items, field) {
  const values = items
    .map((item) => item?.[field])
    .filter((value) => typeof value === "number" && Number.isFinite(value))
    .toSorted((left, right) => left - right);
  if (values.length === 0) {
    return {
      count: 0,
      min: null,
      median: null,
      p95: null,
      max: null
    };
  }
  return {
    count: values.length,
    min: values[0],
    median: percentile(values, 50),
    p95: percentile(values, 95),
    max: values.at(-1)
  };
}

function maxProviderRequestConcurrency(requests) {
  const events = [];
  for (const request of requests ?? []) {
    if (typeof request.receivedAtEpochMs !== "number" || typeof request.respondedAtEpochMs !== "number") {
      continue;
    }
    if (request.respondedAtEpochMs < request.receivedAtEpochMs) {
      continue;
    }
    events.push({ time: request.receivedAtEpochMs, delta: 1 });
    events.push({ time: request.respondedAtEpochMs, delta: -1 });
  }
  let current = 0;
  let max = 0;
  for (const event of events.toSorted((left, right) => left.time - right.time || right.delta - left.delta)) {
    current += event.delta;
    max = Math.max(max, current);
  }
  return max;
}

function percentile(sortedValues, percentileValue) {
  if (sortedValues.length === 0) {
    return null;
  }
  if (sortedValues.length === 1) {
    return sortedValues[0];
  }
  const position = (percentileValue / 100) * (sortedValues.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) {
    return sortedValues[lower];
  }
  const weight = position - lower;
  return Math.round((sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight) * 1000) / 1000;
}

function checkAgentTurnCorrectness(violations, turns, expectedText) {
  for (const turn of turns) {
    if (turn.expectedFailure === true) {
      if (turn.expectedFailureObserved !== true) {
        violations.push({
          kind: "agent",
          metric: "agentTurn.expectedFailureObserved",
          phaseId: turn.phaseId,
          expected: "provider failure surfaced as command failure",
          actual: turn.status,
          message: `${turn.label} agent turn was expected to fail from provider behavior, but the failure was not observed clearly`
        });
      }
      continue;
    }
    if (turn.responseOk !== true) {
      violations.push({
        kind: "agent",
        metric: "agentTurn.responseOk",
        phaseId: turn.phaseId,
        expected: "usable assistant response",
        actual: turn.responseText ?? "none",
        message: `${turn.label} agent turn did not produce the expected assistant response`
      });
    }
    const turnExpectedText = turn.channelModelTurn ? null : (turn.expectedText ?? expectedText);
    if (typeof turnExpectedText === "string" && turnExpectedText.length > 0 && turn.expectedTextPresent !== true) {
      violations.push({
        kind: "agent",
        metric: "agentTurn.expectedTextPresent",
        phaseId: turn.phaseId,
        expected: turnExpectedText,
        actual: turn.responseText ?? "none",
        message: `${turn.label} agent turn response did not exactly match expected text ${turnExpectedText}`
      });
    }
  }
}

function evaluateProviderSimulation({ turns, scenario, record, thresholds, health = null }) {
  const mode = scenario.mockProvider?.mode ?? "normal";
  const expected = mode !== "normal" && scenario.agent !== undefined;
  const issue = classifyProviderIssue(turns);
  const providerRequests = record.providerEvidence?.requests ?? [];
  const expectedFailureTurns = turns.filter((turn) => turn.expectedFailure === true);
  const normalTurns = turns.filter((turn) => turn.expectedFailure !== true);
  const healthLimit = typeof thresholds.providerFailureHealthFailures === "number" ? thresholds.providerFailureHealthFailures : 0;
  const healthFailures = countPostStartupHealthFailures(record, health);
  const healthFailureBreakdown = postStartupHealthFailureBreakdown(health);
  const finalGatewayState = record.finalMetrics?.service?.gatewayState ?? null;
  const containmentOk = !expected || (
    finalGatewayState === "running" &&
    healthFailures <= healthLimit
  );
  const protocolFailureObserved = mode === "protocol-failure"
    ? hasProtocolFailureRequest(providerRequests) && issue.kind === "malformed-response"
    : null;
  const disconnectObserved = mode === "disconnect-then-recover"
    ? hasDisconnectFailureRequest(providerRequests) || turns.some((turn) => hasProviderFailureEvidence(turn, "provider-disconnect"))
    : null;
  const recoveryOk = PROVIDER_RECOVERY_MODES.has(mode)
    ? hasProviderFailureBeforeSuccessfulRequest(providerRequests, mode) ||
      (
        turns.some((turn) => hasProviderFailureEvidence(turn, mode === "disconnect-then-recover" ? "provider-disconnect" : null)) &&
        turns.some((turn) => turn.responseOk === true && hasSuccessfulProviderRequest(turn))
      )
    : null;
  const providerSlowMinMs = thresholds.providerSlowMinMs ?? scenario.mockProvider?.delayMs ?? null;
  const slowObserved = mode === "slow"
    ? turns.some((turn) => typeof turn.providerFinalMs === "number" && typeof providerSlowMinMs === "number" && turn.providerFinalMs >= providerSlowMinMs)
    : null;
  const providerRequestCount = record.providerEvidence?.requestCount ?? turns.reduce((total, turn) => total + (turn.requestCount ?? 0), 0);
  const providerRequestCountMin = thresholds.providerRequestCountMin ?? scenario.mockProvider?.concurrency ?? null;
  const providerMaxConcurrency = maxProviderRequestConcurrency(record.providerEvidence?.requests ?? []);
  const providerConcurrencyMin = thresholds.providerConcurrencyMin ?? (typeof scenario.mockProvider?.concurrency === "number" ? Math.min(2, scenario.mockProvider.concurrency) : null);
  const requestCountOk = typeof providerRequestCountMin === "number" ? providerRequestCount >= providerRequestCountMin : null;
  const overlapObserved = typeof providerConcurrencyMin === "number" ? providerMaxConcurrency >= providerConcurrencyMin : null;
  const concurrentObserved = mode === "concurrent-pressure"
    ? requestCountOk === true && overlapObserved === true
    : null;

  return {
    schemaVersion: "kova.agentProviderSimulation.v1",
    mode,
    expected,
    observedIssue: issue.kind,
    observedIssueSummary: issue.summary,
    containmentOk,
    recoveryOk,
    slowObserved,
    expectedFailureCount: expectedFailureTurns.length,
    expectedFailureObservedCount: expectedFailureTurns.filter((turn) => turn.expectedFailureObserved === true).length,
    successfulTurnCount: normalTurns.filter((turn) => turn.responseOk === true).length,
    protocolFailureObserved,
    disconnectObserved,
    finalGatewayState,
    healthFailures,
    healthFailureScope: "post-startup",
    healthFailureBreakdown,
    healthLimit,
    providerSlowMinMs,
    providerRequestCount,
    providerRequestCountMin,
    providerMaxConcurrency,
    providerConcurrencyMin,
    requestCountOk,
    overlapObserved,
    concurrentObserved
  };
}

function checkProviderSimulation(violations, simulation) {
  if (!simulation.expected) {
    return;
  }
  if (simulation.mode === "slow" && simulation.slowObserved !== true) {
    violations.push({
      kind: "provider-simulation",
      metric: "providerSlowObserved",
      expected: `>= ${simulation.providerSlowMinMs ?? "configured delay"}ms provider work`,
      actual: simulation.observedIssueSummary,
      message: "mock provider slow mode did not produce observable slow provider work"
    });
  }
  if (simulation.mode === "timeout" && !["provider-timeout", "streaming-stall", "provider-aborted", "http-error"].includes(simulation.observedIssue)) {
    violations.push({
      kind: "provider-simulation",
      metric: "providerTimeoutObserved",
      expected: "provider timeout or aborted request",
      actual: simulation.observedIssue,
      message: "mock provider timeout mode did not produce observable timeout/abort evidence"
    });
  }
  if (simulation.mode === "streaming-stall" && !["streaming-stall", "provider-aborted", "provider-timeout", "http-error"].includes(simulation.observedIssue)) {
    violations.push({
      kind: "provider-simulation",
      metric: "providerStreamingStallObserved",
      expected: "streaming stall or aborted request",
      actual: simulation.observedIssue,
      message: "mock provider streaming-stall mode did not produce observable stall/abort evidence"
    });
  }
  if (simulation.mode === "malformed" && simulation.observedIssue !== "malformed-response") {
    violations.push({
      kind: "provider-simulation",
      metric: "providerMalformedObserved",
      expected: "malformed provider response",
      actual: simulation.observedIssue,
      message: "mock provider malformed mode did not produce malformed response evidence"
    });
  }
  if (simulation.mode === "protocol-failure" && simulation.protocolFailureObserved !== true) {
    violations.push({
      kind: "provider-simulation",
      metric: "providerProtocolFailureObserved",
      expected: "protocol-invalid provider response from protocol-failure fixture",
      actual: simulation.observedIssue,
      message: "mock provider protocol-failure mode did not prove the protocol-invalid provider response was exercised"
    });
  }
  if (simulation.mode === "error-then-recover" && simulation.recoveryOk !== true) {
    violations.push({
      kind: "provider-simulation",
      metric: "providerRecoveryOk",
      expected: "first request fails and later request succeeds",
      actual: simulation.recoveryOk,
      message: "mock provider error-then-recover mode did not prove agent recovery"
    });
  }
  if (simulation.mode === "disconnect-then-recover" && simulation.disconnectObserved !== true) {
    violations.push({
      kind: "provider-simulation",
      metric: "providerDisconnectObserved",
      expected: "provider disconnect evidence before recovery",
      actual: simulation.observedIssue,
      message: "mock provider disconnect-then-recover mode did not prove a provider disconnect"
    });
  }
  if (simulation.mode === "disconnect-then-recover" && simulation.recoveryOk !== true) {
    violations.push({
      kind: "provider-simulation",
      metric: "providerDisconnectRecoveryOk",
      expected: "disconnect request fails and later provider request succeeds",
      actual: simulation.recoveryOk,
      message: "mock provider disconnect-then-recover mode did not prove recovery after disconnect"
    });
  }
  if (simulation.mode === "concurrent-pressure" && simulation.concurrentObserved !== true) {
    violations.push({
      kind: "provider-simulation",
      metric: "providerConcurrentPressureObserved",
      expected: `>= ${simulation.providerRequestCountMin ?? "configured concurrency"} provider requests and max in-flight >= ${simulation.providerConcurrencyMin ?? "configured overlap"}`,
      actual: `requests=${simulation.providerRequestCount}, maxInFlight=${simulation.providerMaxConcurrency}`,
      message: "mock provider concurrent-pressure mode did not produce enough overlapping provider work"
    });
  }
  if (simulation.containmentOk !== true) {
    violations.push({
      kind: "provider-containment",
      metric: "providerFailureContainmentOk",
      expected: `gateway running and post-startup health failures <= ${simulation.healthLimit}`,
      actual: `gateway=${simulation.finalGatewayState ?? "unknown"} healthFailures=${simulation.healthFailures}`,
      message: `provider ${simulation.mode} failure was not contained; gateway=${simulation.finalGatewayState ?? "unknown"}, post-startup health failures=${simulation.healthFailures}`
    });
  }
}

function buildAgentFailureFixerSummary(latencyDiagnosis, cleanupDiagnosis, providerSimulation, containment) {
  const items = [];
  if (providerSimulation?.expected === true && (providerSimulation.mode === "timeout" || providerSimulation.observedIssue === "provider-timeout")) {
    items.push({
      kind: "provider-timeout",
      summary: "Provider timed out; verify OpenClaw surfaces the timeout clearly, cancels the turn, and leaves the gateway responsive.",
      likelyOwner: "provider / agent timeout handling"
    });
  }
  if (providerSimulation?.expected === true && (providerSimulation.mode === "streaming-stall" || providerSimulation.observedIssue === "streaming-stall")) {
    items.push({
      kind: "streaming-stall",
      summary: "Provider stream stalled; verify OpenClaw applies stream idle timeouts and does not freeze gateway/TUI/dashboard.",
      likelyOwner: "provider streaming / agent turn cancellation"
    });
  }
  if (providerSimulation?.expected === true && providerSimulation.mode !== "protocol-failure" && (providerSimulation.mode === "malformed" || providerSimulation.observedIssue === "malformed-response")) {
    items.push({
      kind: "malformed-response",
      summary: "Provider returned malformed output; verify OpenClaw reports a clear provider parse error and keeps the session usable.",
      likelyOwner: "provider response parsing"
    });
  }
  if (providerSimulation?.expected === true && providerSimulation.mode === "protocol-failure") {
    items.push({
      kind: "provider-protocol-failure",
      summary: "Provider returned a protocol-invalid response; verify OpenClaw reports a clear provider contract error and keeps the session usable.",
      likelyOwner: "provider response contract handling"
    });
  }
  if (providerSimulation?.expected === true && providerSimulation.recoveryOk === true) {
    items.push({
      kind: "provider-recovered",
      summary: "Provider failed and later recovered; verify retry/recovery behavior is intentional and latency remains acceptable.",
      likelyOwner: "provider retry / agent recovery"
    });
  }
  if (providerSimulation?.expected === true && providerSimulation.observedIssue === "provider-disconnect") {
    items.push({
      kind: "provider-disconnect",
      summary: providerSimulation.observedIssueSummary ?? "Provider disconnected before recovery; verify OpenClaw reports the interruption and leaves follow-up turns usable.",
      likelyOwner: "provider transport recovery"
    });
  }
  if (providerSimulation?.expected === true && providerSimulation.observedIssue === "provider-error") {
    items.push({
      kind: "provider-error",
      summary: providerSimulation.observedIssueSummary ?? "Provider returned an explicit error; verify OpenClaw reports it clearly and keeps the session usable.",
      likelyOwner: "provider error handling / agent recovery"
    });
  }
  if (providerSimulation?.expected === true && providerSimulation.observedIssue === "provider-aborted") {
    items.push({
      kind: "provider-aborted",
      summary: providerSimulation.observedIssueSummary ?? "Provider request was aborted; verify OpenClaw cancels cleanly and does not leave a hung turn.",
      likelyOwner: "provider cancellation / agent turn lifecycle"
    });
  }
  if (providerSimulation?.expected === true && providerSimulation.observedIssue === "http-error") {
    items.push({
      kind: "provider-http-error",
      summary: providerSimulation.observedIssueSummary ?? "Provider returned an HTTP error; verify OpenClaw maps it to actionable user-facing guidance.",
      likelyOwner: "provider HTTP error mapping"
    });
  }
  if (providerSimulation?.expected === true && providerSimulation.observedIssue === "none") {
    items.push({
      kind: "provider-failure-not-observed",
      summary: `Mock provider mode ${providerSimulation.mode} did not produce the expected failure evidence; verify the scenario exercises the intended OpenClaw provider path.`,
      likelyOwner: "scenario/provider harness wiring"
    });
  }
  if (providerSimulation?.expected === true && providerSimulation.mode === "concurrent-pressure") {
    items.push({
      kind: "provider-concurrent-pressure",
      summary: `Concurrent provider pressure produced ${providerSimulation.providerRequestCount ?? "unknown"} provider request(s), max in-flight ${providerSimulation.providerMaxConcurrency ?? "unknown"}; verify OpenClaw keeps gateway and agent sessions responsive under overlapping turns.`,
      likelyOwner: "agent concurrency / provider scheduling"
    });
  }
  if (latencyDiagnosis?.kind === "cold-pre-provider-stall" || latencyDiagnosis?.kind === "pre-provider-stall") {
    items.push({
      kind: "pre-provider-stall",
      summary: latencyDiagnosis.summary,
      likelyOwner: latencyDiagnosis.likelyOwner
    });
  }
  if (latencyDiagnosis?.kind === "auth-failure") {
    items.push({
      kind: "auth-failure",
      summary: "Agent turn failed before provider work because model/provider auth was missing; verify OpenClaw reports credential setup guidance and keeps the gateway usable.",
      likelyOwner: latencyDiagnosis.likelyOwner
    });
  }
  if (cleanupDiagnosis?.kind === "slow-agent-cleanup") {
    items.push({
      kind: "slow-agent-cleanup",
      summary: cleanupDiagnosis.summary,
      likelyOwner: cleanupDiagnosis.likelyOwner
    });
  }
  if ((containment?.processLeakCount ?? 0) > 0) {
    const first = containment.leakedProcesses?.[0];
    items.push({
      kind: "leaked-child-process",
      summary: `Agent command left ${containment.processLeakCount} process(es) running after completion${first ? `; first leak ${first.role} pid ${first.pid}` : ""}.`,
      likelyOwner: "agent cleanup / plugin child process lifecycle"
    });
  }
  if (containment?.gatewayHealthy === false) {
    items.push({
      kind: "gateway-after-agent-unhealthy",
      summary: `Gateway was not healthy after agent command; gateway=${containment.finalGatewayState ?? "unknown"}, post-startup health failures=${containment.healthFailures}.`,
      likelyOwner: "gateway supervision / agent failure containment"
    });
  }
  if (containment?.statusWorks === false) {
    items.push({
      kind: "status-after-agent-failed",
      summary: "OpenClaw status command did not respond cleanly after the failed agent turn; verify failed turns do not degrade CLI/gateway control paths.",
      likelyOwner: "gateway control path / agent failure containment"
    });
  }
  if (containment?.dashboardResponsive === false) {
    items.push({
      kind: "dashboard-after-agent-failed",
      summary: "Dashboard did not stay responsive after the failed agent turn; verify gateway UI endpoints are isolated from agent/provider failures.",
      likelyOwner: "dashboard / gateway failure containment"
    });
  }
  if (containment?.tuiResponsive === false) {
    items.push({
      kind: "tui-after-agent-failed",
      summary: "TUI did not stay responsive after the failed agent turn; verify terminal input and gateway attach paths are isolated from provider failures.",
      likelyOwner: "TUI / gateway attach failure containment"
    });
  }
  return {
    schemaVersion: "kova.agentFailureFixerSummary.v1",
    count: items.length,
    items
  };
}

function checkAgentTurnThresholds(violations, turns, selected, thresholds, record) {
  for (const turn of turns) {
    if (turn.missingProviderRequest === true && record.auth?.mode === "mock") {
      violations.push({
        kind: "provider",
        metric: "agentProviderRequestMissing",
        phaseId: turn.phaseId,
        expected: "provider request during agent command",
        actual: "none",
        message: `${turn.label} agent turn ran with mock auth but no mock provider request was captured`
      });
      continue;
    }
    checkTurnThreshold(violations, turn, "totalTurnMs", thresholds.agentTurnMs, `${turn.label} agent turn took ${turn.totalTurnMs}ms`);
    checkTurnThreshold(violations, turn, "preProviderMs", thresholds.preProviderMs, `${turn.label} agent spent ${turn.preProviderMs}ms before provider work`);
    if (turn.expectedFailure !== true) {
      checkTurnThreshold(violations, turn, "providerFinalMs", thresholds.providerFinalMs, `${turn.label} provider work took ${turn.providerFinalMs}ms`);
    }
    // Cleanup is source-span evidence: gate it when present, while absence remains
    // explicit null. Non-null malformed evidence still blocks in the helper.
    checkTurnThreshold(
      violations,
      turn,
      "cleanupMs",
      thresholds.agentCleanupMs,
      `${turn.label} agent cleanup took ${turn.cleanupMs}ms`,
      { optionalMeasurement: true }
    );
    if (typeof thresholds.preProviderDominanceRatio === "number" &&
      typeof turn.preProviderDominance === "number" &&
      turn.preProviderDominance > thresholds.preProviderDominanceRatio &&
      preProviderDominanceExceededAbsoluteGate(turn, thresholds)) {
      violations.push({
        kind: "agent-latency",
        metric: "preProviderDominanceRatio",
        phaseId: turn.phaseId,
        expected: `<= ${thresholds.preProviderDominanceRatio}`,
        actual: turn.preProviderDominance,
        message: `${turn.label} pre-provider work dominated agent turn (${Math.round(turn.preProviderDominance * 100)}% of ${turn.totalTurnMs}ms)`
      });
    }
  }

  checkTurnThreshold(violations, selected.coldAgentTurn, "totalTurnMs", thresholds.coldAgentTurnMs, `cold agent turn took ${selected.coldAgentTurn?.totalTurnMs}ms`);
  checkTurnThreshold(violations, selected.warmAgentTurn, "totalTurnMs", thresholds.warmAgentTurnMs, `warm agent turn took ${selected.warmAgentTurn?.totalTurnMs}ms`);
  checkTurnThreshold(violations, selected.coldAgentTurn, "preProviderMs", thresholds.coldPreProviderMs, `cold pre-provider latency was ${selected.coldAgentTurn?.preProviderMs}ms`);
  checkTurnThreshold(violations, selected.warmAgentTurn, "preProviderMs", thresholds.warmPreProviderMs, `warm pre-provider latency was ${selected.warmAgentTurn?.preProviderMs}ms`);

  const totalDelta = delta(selected.coldAgentTurn?.totalTurnMs, selected.warmAgentTurn?.totalTurnMs);
  if (typeof thresholds.coldWarmDeltaMs === "number" && typeof totalDelta === "number" && totalDelta > thresholds.coldWarmDeltaMs) {
    violations.push({
      kind: "agent-latency",
      metric: "coldWarmDeltaMs",
      expected: `<= ${thresholds.coldWarmDeltaMs}`,
      actual: totalDelta,
      message: `cold agent turn was ${totalDelta}ms slower than warm turn`
    });
  }

  if (selected.agentLatencyDiagnosis?.severity === "fail") {
    violations.push({
      kind: "agent-latency",
      metric: "agentLatencyDiagnosis",
      expected: "no cold pre-provider stall",
      actual: selected.agentLatencyDiagnosis.kind,
      message: selected.agentLatencyDiagnosis.summary
    });
  }
}

function checkAgentTurnAggregateThresholds(violations, stats, thresholds) {
  checkAggregateThreshold(violations, stats.totalTurnMs.p95, "agentTurnP95Ms", thresholds.agentTurnP95Ms);
  checkAggregateThreshold(violations, stats.totalTurnMs.max, "agentTurnMaxMs", thresholds.agentTurnMaxMs);
  checkAggregateThreshold(violations, stats.preProviderMs.p95, "agentPreProviderP95Ms", thresholds.agentPreProviderP95Ms);
  checkAggregateThreshold(violations, stats.preProviderMs.max, "agentPreProviderMaxMs", thresholds.agentPreProviderMaxMs);
  checkAggregateThreshold(violations, stats.providerFinalMs.p95, "agentProviderFinalP95Ms", thresholds.agentProviderFinalP95Ms);
  checkAggregateThreshold(violations, stats.providerFinalMs.max, "agentProviderFinalMaxMs", thresholds.agentProviderFinalMaxMs);
  checkAggregateThreshold(
    violations,
    stats.cleanupMs.p95,
    "agentCleanupP95Ms",
    thresholds.agentCleanupP95Ms,
    { optionalMeasurement: true }
  );
  checkAggregateThreshold(
    violations,
    stats.cleanupMs.max,
    "agentCleanupMaxMs",
    thresholds.agentCleanupMaxMs,
    { optionalMeasurement: true }
  );
}

function preProviderDominanceExceededAbsoluteGate(turn, thresholds) {
  if (typeof thresholds.preProviderMs !== "number" || typeof turn.preProviderMs !== "number") {
    return true;
  }
  return turn.preProviderMs > thresholds.preProviderMs;
}

function diagnoseAgentLatency({ coldAgentTurn, warmAgentTurn, providerTurn, thresholds, timelineSummary, authMode = null, expectedProviderMode = "normal", providerSimulation = null }) {
  if (!providerTurn) {
    return null;
  }
  if (providerTurn.missingProviderRequest === true) {
    if (providerTurn.expectedFailure === true && ["missing", "broken", "none", "skip"].includes(authMode)) {
      return {
        kind: "auth-failure",
        severity: "info",
        summary: `Agent turn failed before provider work because auth mode is ${authMode}.`,
        likelyOwner: "agent-runtime/auth"
      };
    }
    if (authMode === "live") {
      return {
        kind: "live-provider-timing-unavailable",
        severity: "info",
        summary: "Live provider request timing was not captured; use OpenClaw timeline spans or a deterministic mock provider lane for provider boundary attribution.",
        likelyOwner: "Kova/OpenClaw diagnostics integration"
      };
    }
    return {
      kind: "no-provider-request",
      severity: "fail",
      summary: "No provider request happened during the agent turn.",
      likelyOwner: "agent-runtime/auth/provider-routing"
    };
  }

  const providerIssue = classifyProviderIssue([providerTurn]);
  if (providerIssue.kind !== "none") {
    const expectedProviderFailure = providerTurn.expectedFailure === true || providerSimulation?.expected === true;
    return {
      kind: providerIssue.kind,
      severity: expectedProviderMode === "normal" && !expectedProviderFailure ? "fail" : "info",
      summary: providerSimulation?.observedIssueSummary ?? providerIssue.summary,
      likelyOwner: "provider"
    };
  }

  const preProviderThreshold = thresholds.preProviderMs ?? thresholds.coldPreProviderMs ?? 10000;
  const dominanceThreshold = thresholds.preProviderDominanceRatio ?? 0.8;
  const coldWarmDeltaThreshold = thresholds.coldWarmDeltaMs ?? 10000;
  const coldWarmDelta = delta(coldAgentTurn?.totalTurnMs, warmAgentTurn?.totalTurnMs);
  const providerFast = typeof providerTurn.providerFinalMs === "number" && providerTurn.providerFinalMs <= (thresholds.providerFinalMs ?? 3000);
  const preProviderDominant = typeof providerTurn.preProviderDominance === "number" && providerTurn.preProviderDominance > dominanceThreshold;
  const preProviderSlow = typeof providerTurn.preProviderMs === "number" && providerTurn.preProviderMs > preProviderThreshold;
  const coldImproved = typeof coldWarmDelta === "number" && coldWarmDelta > coldWarmDeltaThreshold;

  if (providerFast && preProviderSlow && preProviderDominant) {
    return {
      kind: coldImproved ? "cold-pre-provider-stall" : "pre-provider-stall",
      severity: "fail",
      summary: `${providerTurn.label} provider was fast (${providerTurn.providerFinalMs}ms), but OpenClaw spent ${providerTurn.preProviderMs}ms before provider work${coldImproved ? `; warm turn improved by ${coldWarmDelta}ms` : ""}.`,
      likelyOwner: "model catalog / channel plugin loading / runtime capabilities",
      supportingSpans: relevantAgentSpans(timelineSummary)
    };
  }

  if (typeof providerTurn.providerFinalMs === "number" && providerTurn.providerFinalMs > (thresholds.providerFinalMs ?? 3000)) {
    return {
      kind: "provider-slow",
      severity: "warn",
      summary: `Provider work took ${providerTurn.providerFinalMs}ms; investigate provider/mock-provider route before blaming OpenClaw pre-provider work.`,
      likelyOwner: "provider"
    };
  }

  return {
    kind: "agent-latency-attributed",
    severity: "info",
    summary: `${providerTurn.label} agent turn ${providerTurn.totalTurnMs ?? "unknown"}ms; pre-provider ${providerTurn.preProviderMs ?? "unknown"}ms; provider ${providerTurn.providerFinalMs ?? "unknown"}ms.`,
    likelyOwner: "OpenClaw"
  };
}

function diagnoseAgentCleanup(turns, stats, thresholds) {
  const threshold = thresholds.agentCleanupMs ?? thresholds.agentCleanupMaxMs ?? null;
  const max = stats.cleanupMs.max;
  if (typeof threshold !== "number" || typeof max !== "number" || max <= threshold) {
    return null;
  }
  const slowest = turns
    .filter((turn) => typeof turn.cleanupMs === "number")
    .toSorted((left, right) => right.cleanupMs - left.cleanupMs)[0] ?? null;
  return {
    kind: "slow-agent-cleanup",
    severity: "fail",
    summary: `${slowest?.label ?? "agent"} cleanup took ${max}ms after provider work; investigate agent cleanup, MCP runtime shutdown, plugin child cleanup, or session persistence.`,
    likelyOwner: "agent cleanup / plugin child process lifecycle",
    maxCleanupMs: max,
    thresholdMs: threshold,
    phaseId: slowest?.phaseId ?? null
  };
}

function classifyProviderIssue(turns) {
  const errors = turns.flatMap((turn) => turn.providerErrors ?? []);
  const errorKinds = new Set(errors.map((error) => error.kind).filter(Boolean));
  if (errorKinds.has("provider-timeout")) {
    return { kind: "provider-timeout", summary: "Provider timed out before completing the agent turn." };
  }
  if (errorKinds.has("streaming-stall")) {
    return { kind: "streaming-stall", summary: "Provider stream stalled before completing the agent turn." };
  }
  if (errorKinds.has("malformed-response")) {
    return { kind: "malformed-response", summary: "Provider returned a malformed response." };
  }
  if (errorKinds.has("provider-disconnect")) {
    return { kind: "provider-disconnect", summary: "Provider disconnected before completing the agent turn." };
  }
  if (errorKinds.has("provider-error")) {
    return { kind: "provider-error", summary: "Provider returned an explicit error before recovery or failure handling." };
  }
  if (errorKinds.has("provider-aborted")) {
    return { kind: "provider-aborted", summary: "Provider request was aborted before a normal response completed." };
  }
  if (errors.some((error) => error.kind === "http" && typeof error.status === "number" && error.status >= 400)) {
    const first = errors.find((error) => error.kind === "http" && typeof error.status === "number" && error.status >= 400);
    return { kind: "http-error", summary: `Provider returned HTTP ${first.status}.` };
  }
  return { kind: "none", summary: "No provider failure evidence found." };
}

function hasSuccessfulProviderRequest(turn) {
  return (turn.providerStatuses ?? []).some((status) => Number(status.value) >= 200 && Number(status.value) < 300);
}

function hasProviderFailureEvidence(turn, expectedKind = null) {
  if (expectedKind) {
    return (turn.providerErrors ?? []).some((error) => error.kind === expectedKind);
  }
  return (turn.providerErrors ?? []).some((error) =>
    ["provider-error", "provider-disconnect", "provider-timeout", "streaming-stall", "malformed-response", "provider-aborted"].includes(error.kind) ||
    (error.kind === "http" && typeof error.status === "number" && error.status >= 400)
  );
}

function hasProtocolFailureRequest(requests) {
  return requests.some((request) =>
    request.mode === "protocol-failure" &&
    request.responseType === "malformed" &&
    typeof request.status === "number" &&
    request.status >= 200 &&
    request.status < 300
  );
}

function hasDisconnectFailureRequest(requests) {
  return requests.some((request) => isProviderFailureRequest(request, "disconnect-then-recover"));
}

function hasProviderFailureBeforeSuccessfulRequest(requests, mode) {
  let sawFailure = false;
  for (const request of requests
    .filter((item) => typeof item.receivedAtEpochMs === "number")
    .toSorted((left, right) => left.receivedAtEpochMs - right.receivedAtEpochMs)) {
    if (isProviderFailureRequest(request, mode)) {
      sawFailure = true;
      continue;
    }
    if (sawFailure && isSuccessfulProviderRequest(request)) {
      return true;
    }
  }
  return false;
}

function isProviderFailureRequest(request, mode) {
  if (mode === "disconnect-then-recover") {
    return request.mode === "disconnect-then-recover" && request.errorClass === "provider-disconnect";
  }
  if (mode === "error-then-recover") {
    return request.mode === "error-then-recover" && (
      request.errorClass === "provider-error" ||
      (typeof request.status === "number" && request.status >= 400)
    );
  }
  return false;
}

function isSuccessfulProviderRequest(request) {
  return typeof request.status === "number" && request.status >= 200 && request.status < 300;
}

function relevantAgentSpans(timelineSummary) {
  const names = [
    "agent.turn",
    "agent.prepare",
    "agent.runtimeCapabilities",
    "channel.capabilities",
    "channel.plugin.get",
    "channel.plugin.load",
    "models.catalog.gateway",
    "models.catalog.load",
    "models.discovery",
    "plugins.metadata.scan",
    "runtimeDeps.stage",
    "provider.request",
    "agent.cleanup"
  ];
  return names
    .map((name) => timelineSummary.keySpans?.[name])
    .filter(Boolean)
    .filter((span) => (span.count ?? 0) > 0 || (span.openCount ?? 0) > 0 || typeof span.maxDurationMs === "number")
    .map((span) => ({
      name: span.name,
      count: span.count,
      maxDurationMs: span.maxDurationMs,
      openCount: span.openCount
    }));
}

function agentTurnLabel(phaseId, index) {
  if (phaseId?.includes("cold")) {
    return "cold";
  }
  if (phaseId?.includes("warm")) {
    return "warm";
  }
  if (phaseId?.includes("gateway-session")) {
    return "gateway-session";
  }
  if (phaseId?.includes("gateway")) {
    return "gateway-rpc";
  }
  if (phaseId?.includes("tui")) {
    return "tui";
  }
  if (phaseId?.includes("openai")) {
    return "openai-compatible";
  }
  return `turn-${index}`;
}

function summarizeTurnResources(samples) {
  if (!samples) {
    return null;
  }
  return {
    sampleCount: samples.sampleCount ?? 0,
    peakTotalRssMb: samples.peakTotalRssMb ?? null,
    maxTotalCpuPercent: samples.maxTotalCpuPercent ?? null,
    topRolesByRss: samples.topRolesByRss ?? [],
    topRolesByCpu: samples.topRolesByCpu ?? []
  };
}

function timelineRequirementFor(options) {
  const targetKind = options.targetPlan?.kind ?? null;
  const profileDiagnostics = options.profile?.diagnostics ?? {};
  const requiredForTargetKinds = profileDiagnostics.timelineRequiredForTargetKinds ?? [];
  if (profileDiagnostics.timelineRequired === true && (requiredForTargetKinds.length === 0 || requiredForTargetKinds.includes(targetKind))) {
    return {
      required: true,
      reason: `profile '${options.profile?.id ?? "unknown"}' on target kind '${targetKind ?? "unknown"}'`
    };
  }
  if (options.surface?.diagnostics?.timelineRequiredForSourceBuild === true && targetKind === "local-build" && profileDiagnostics.timelineRequired === true) {
    return {
      required: true,
      reason: `surface '${options.surface.id}' source-build diagnostics`
    };
  }
  return { required: false, reason: null };
}

function requiredTimelineSpans(options) {
  return new Set([
    ...(options.surface?.diagnostics?.expectedSpans ?? []),
    ...(options.profile?.diagnostics?.requiredKeySpans ?? [])
  ]);
}

function diagnosticSpanContractFor(options) {
  const targetKind = options.targetPlan?.kind ?? null;
  const profileDiagnostics = options.profile?.diagnostics ?? {};
  const spanMode = options.surface?.diagnostics?.missingExpectedSpanSeverity ??
    profileDiagnostics.missingExpectedSpanSeverity ??
    "diagnostic-gap";
  const hardRequiredSpans = Array.isArray(profileDiagnostics.requiredKeySpans) && profileDiagnostics.requiredKeySpans.length > 0;
  const enforceMissingSpans = spanMode === "fail" || hardRequiredSpans;
  const missingSpanSeverity = enforceMissingSpans ? "fail" : spanMode === "warn" ? "warning" : "diagnostic-gap";
  return {
    schemaVersion: "kova.diagnosticsContract.v1",
    targetKind,
    expectedSpanCount: requiredTimelineSpans(options).size,
    missingSpanSeverity,
    enforceMissingSpans,
    reason: enforceMissingSpans
      ? "diagnostics span contract is explicitly enforced"
      : "missing expected spans reduce diagnostic attribution but do not by themselves fail the user path"
  };
}

function missingTimelineSpans(timelineSummary, requiredSpans) {
  return [...requiredSpans].filter((name) => !timelineSpanObserved(timelineSummary, name));
}

function timelineSpanObserved(timelineSummary, name) {
  const exact = timelineSummary.keySpans?.[name] ?? timelineSummary.spanTotals?.[name];
  if ((exact?.count ?? 0) > 0 || (exact?.openCount ?? 0) > 0) {
    return true;
  }
  if ((timelineSummary.openSpans ?? []).some((span) => span.name === name)) {
    return true;
  }
  if (name === "gateway.chat_send" || name === "auto_reply" || name === "reply" || name === "models.catalog") {
    return Object.entries(timelineSummary.spanTotals ?? {}).some(([spanName, summary]) =>
      spanName === name || (spanName.startsWith(`${name}.`) && (summary.count ?? 0) > 0)
    );
  }
  return false;
}

function maxDurationWhere(results, predicate) {
  const durations = results
    .filter((result) => predicate(result.command))
    .map((result) => result.durationMs)
    .filter((duration) => typeof duration === "number");
  return durations.length === 0 ? null : Math.max(...durations);
}

function sumNumbers(values) {
  return values.reduce((total, value) => total + (typeof value === "number" ? value : 0), 0);
}

function countHealthFailures(record) {
  let count = 0;
  for (const phase of record.phases ?? []) {
    count += phase.metrics?.healthSummary?.failureCount ?? healthFailureCount([phase.metrics?.health]);
  }

  count += record.finalMetrics?.healthSummary?.failureCount ?? healthFailureCount([record.finalMetrics?.health]);
  return count;
}

function countPostStartupHealthFailures(record, health = null) {
  if (health?.schemaVersion === "kova.health.v1") {
    const breakdown = postStartupHealthFailureBreakdown(health);
    return breakdown.postReady + breakdown.unknown + breakdown.final;
  }
  return countHealthFailures(record);
}

function postStartupHealthFailureBreakdown(health) {
  return {
    startup: health?.startupSamples?.failureCount ?? 0,
    postReady: health?.postReadySamples?.failureCount ?? 0,
    unknown: health?.unknownSamples?.failureCount ?? 0,
    final: health?.final?.failureCount ?? 0
  };
}

function countListeningFailures(record) {
  let count = 0;
  for (const phase of record.phases ?? []) {
    if (phase.metrics?.readiness && phase.metrics.readiness.listeningReady === false && phase.metrics.readiness.deadlineMs > 0) {
      count += 1;
    }
  }
  if (record.finalMetrics?.readiness && record.finalMetrics.readiness.listeningReady === false && record.finalMetrics.readiness.deadlineMs > 0) {
    count += 1;
  }
  return count;
}

function countReadinessFailures(record) {
  let count = 0;
  for (const phase of record.phases ?? []) {
    if (phase.metrics?.readiness && phase.metrics.readiness.ready === false && phase.metrics.readiness.deadlineMs > 0) {
      count += 1;
    }
  }
  if (record.finalMetrics?.readiness && record.finalMetrics.readiness.ready === false && record.finalMetrics.readiness.deadlineMs > 0) {
    count += 1;
  }
  return count;
}

function collectTcpConnectMax(record) {
  const durations = [];
  for (const phase of record.phases ?? []) {
    const duration = phase.metrics?.listening?.durationMs;
    if (typeof duration === "number") {
      durations.push(duration);
    }
  }
  const finalDuration = record.finalMetrics?.listening?.durationMs;
  if (typeof finalDuration === "number") {
    durations.push(finalDuration);
  }
  return durations.length === 0 ? null : Math.max(...durations);
}

function countGatewayRestarts(record, results = collectResults(record)) {
  const commandRestarts = results.filter((result) => result.command.startsWith("ocm service restart ")).length;
  const logRestarts = countLogMetric(record, "gatewayRestartMentions", results);
  if (typeof logRestarts === "number") {
    return commandRestarts + logRestarts;
  }
  return commandRestarts > 0 ? commandRestarts : null;
}

function collectIntentionalRestartSourcePids(record) {
  const sourcePids = new Set();
  let previousTimeline = null;
  let restartPending = false;

  for (const phase of record.phases ?? []) {
    restartPending ||= (phase.results ?? []).some((result) =>
      result.command?.startsWith("ocm service restart ") && commandResultPassed(result)
    );
    const timeline = phase.metrics?.timeline;
    if (!timeline?.available) {
      continue;
    }
    const gatewayPids = timeline.gatewayPids ?? [];
    const transitionIsAdjacent = previousTimeline?.terminalGatewayPid !== null &&
      previousTimeline?.terminalGatewayPid !== undefined &&
      gatewayPids.at(-2) === previousTimeline.terminalGatewayPid &&
      gatewayPids.at(-1) === timeline.terminalGatewayPid;
    if (restartPending && transitionIsAdjacent) {
      sourcePids.add(previousTimeline.terminalGatewayPid);
    }
    restartPending = false;
    previousTimeline = timeline;
  }

  const finalTimeline = record.finalMetrics?.timeline;
  if (restartPending && finalTimeline?.available && finalTimeline !== previousTimeline) {
    const gatewayPids = finalTimeline.gatewayPids ?? [];
    if (previousTimeline?.terminalGatewayPid !== null &&
      previousTimeline?.terminalGatewayPid !== undefined &&
      gatewayPids.at(-2) === previousTimeline.terminalGatewayPid &&
      gatewayPids.at(-1) === finalTimeline.terminalGatewayPid) {
      sourcePids.add(previousTimeline.terminalGatewayPid);
    }
  }

  return sourcePids;
}

function collectSoakEvidence(results) {
  const loops = results
    .filter((result) => result.command?.includes("run-soak-loop.mjs"))
    .map((result) => parseSoakLoopOutput(result))
    .filter(Boolean);

  if (loops.length === 0) {
    return {
      schemaVersion: "kova.soakEvidence.v1",
      available: false,
      durationMs: null,
      iterations: null,
      commandP95Ms: null,
      commandMaxMs: null,
      commandFailures: null,
      healthP95Ms: null,
      healthMaxMs: null,
      healthFailures: null,
      loops: []
    };
  }

  return {
    schemaVersion: "kova.soakEvidence.v1",
    available: true,
    durationMs: maxNullable(...loops.map((loop) => loop.durationMs)),
    iterations: maxNullable(...loops.map((loop) => loop.iterations)),
    commandP95Ms: maxNullable(...loops.map((loop) => loop.commandSummary?.p95Ms)),
    commandMaxMs: maxNullable(...loops.map((loop) => loop.commandSummary?.maxMs)),
    commandFailures: loops.reduce((total, loop) => total + (loop.commandSummary?.failureCount ?? 0), 0),
    healthP95Ms: maxNullable(...loops.map((loop) => loop.healthSummary?.p95Ms)),
    healthMaxMs: maxNullable(...loops.map((loop) => loop.healthSummary?.maxMs)),
    healthFailures: loops.reduce((total, loop) => total + (loop.healthSummary?.failureCount ?? 0), 0),
    loops: loops.map((loop) => ({
      durationMs: loop.durationMs ?? null,
      iterations: loop.iterations ?? null,
      commandSummary: loop.commandSummary ?? null,
      healthSummary: loop.healthSummary ?? null
    }))
  };
}

function parseSoakLoopOutput(result) {
  const text = result.stdout ?? "";
  const jsonStart = text.indexOf("{");
  if (jsonStart < 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(text.slice(jsonStart));
    return parsed?.schemaVersion === "kova.soakLoop.v1" ? parsed : null;
  } catch {
    return null;
  }
}

function collectMcpBridgeEvidence(results) {
  const smokes = results
    .filter((result) => result.command?.includes("mcp-bridge-smoke.mjs"))
    .map((result) => parseMcpBridgeSmokeOutput(result))
    .filter(Boolean);

  if (smokes.length === 0) {
    return {
      schemaVersion: "kova.mcpBridgeEvidence.v1",
      available: false,
      initializeMs: null,
      toolsListMs: null,
      shutdownMs: null,
      toolCount: null,
      toolNames: [],
      processExited: null,
      errors: [],
      smokes: []
    };
  }

  return {
    schemaVersion: "kova.mcpBridgeEvidence.v1",
    available: true,
    initializeMs: maxNullable(...smokes.map((smoke) => smoke.initializeMs)),
    toolsListMs: maxNullable(...smokes.map((smoke) => smoke.toolsListMs)),
    shutdownMs: maxNullable(...smokes.map((smoke) => smoke.shutdownMs)),
    toolCount: maxNullable(...smokes.map((smoke) => smoke.toolCount)),
    toolNames: [...new Set(smokes.flatMap((smoke) => smoke.toolNames ?? []))].sort(),
    processExited: smokes.every((smoke) => smoke.processExited === true),
    errors: smokes.flatMap((smoke) => smoke.errors ?? []),
    smokes: smokes.map((smoke) => ({
      durationMs: smoke.durationMs ?? null,
      initializeMs: smoke.initializeMs ?? null,
      toolsListMs: smoke.toolsListMs ?? null,
      shutdownMs: smoke.shutdownMs ?? null,
      toolCount: smoke.toolCount ?? null,
      processExited: smoke.processExited ?? null,
      exitStatus: smoke.exitStatus ?? null,
      exitSignal: smoke.exitSignal ?? null,
      errors: smoke.errors ?? []
    }))
  };
}

function parseMcpBridgeSmokeOutput(result) {
  return parseSchemaOutput(result, "kova.mcpBridgeSmoke.v1");
}

function collectCronRuntimeEvidence(results) {
  const smokes = results
    .filter((result) => result.command?.includes("run-cron-runtime-smoke.mjs"))
    .map((result) => parseSchemaOutput(result, "kova.cronRuntimeSmoke.v1"))
    .filter(Boolean);
  if (smokes.length === 0) {
    return {
      schemaVersion: "kova.cronRuntimeEvidence.v1",
      available: false,
      cronStatusMs: null,
      cronRegisterMs: null,
      cronRunMs: null,
      cronRunsMs: null,
      cronRunCompleted: null,
      cronTriggerAttributed: null,
      errors: [],
      smokes: []
    };
  }
  return {
    schemaVersion: "kova.cronRuntimeEvidence.v1",
    available: true,
    cronStatusMs: maxNullable(...smokes.map((smoke) => smoke.cronStatusMs)),
    cronRegisterMs: maxNullable(...smokes.map((smoke) => smoke.cronRegisterMs)),
    cronRunMs: maxNullable(...smokes.map((smoke) => smoke.cronRunMs)),
    cronRunsMs: maxNullable(...smokes.map((smoke) => smoke.cronRunsMs)),
    cronRunCompleted: smokes.every((smoke) => smoke.cronRunCompleted === true),
    cronTriggerAttributed: smokes.every((smoke) => smoke.cronTriggerAttributed === true),
    errors: smokes.flatMap((smoke) => smoke.errors ?? []),
    smokes: smokes.map((smoke) => ({
      durationMs: smoke.durationMs ?? null,
      cronStatusMs: smoke.cronStatusMs ?? null,
      cronRegisterMs: smoke.cronRegisterMs ?? null,
      cronRunMs: smoke.cronRunMs ?? null,
      cronRunsMs: smoke.cronRunsMs ?? null,
      cronRunCompleted: smoke.cronRunCompleted ?? null,
      cronTriggerAttributed: smoke.cronTriggerAttributed ?? null,
      errors: smoke.errors ?? []
    }))
  };
}

function collectExecToolEvidence(results) {
  const smokes = results
    .filter((result) => result.command?.includes("run-exec-tool-safety.mjs"))
    .map((result) => parseSchemaOutput(result, "kova.execToolSafety.v1"))
    .filter(Boolean);
  if (smokes.length === 0) {
    return {
      schemaVersion: "kova.execToolEvidence.v1",
      available: false,
      safeCommandMs: null,
      safeCommandSucceeded: null,
      dangerousCommandBlocked: null,
      dangerousPayloadExecuted: null,
      outputTruncated: null,
      timeoutMs: null,
      processLeaks: null,
      errors: [],
      smokes: []
    };
  }
  return {
    schemaVersion: "kova.execToolEvidence.v1",
    available: true,
    safeCommandMs: maxNullable(...smokes.map((smoke) => smoke.safeCommandMs)),
    safeCommandSucceeded: nullableEvery(smokes.map((smoke) => smoke.safeCommandSucceeded)),
    dangerousCommandBlocked: nullableEvery(smokes.map((smoke) => smoke.dangerousCommandBlocked)),
    dangerousPayloadExecuted: smokes.some((smoke) => smoke.dangerousPayloadExecuted === true),
    outputTruncated: nullableEvery(smokes.map((smoke) => smoke.outputTruncated)),
    timeoutMs: maxNullable(...smokes.map((smoke) => smoke.timeoutMs)),
    processLeaks: maxNullable(...smokes.map((smoke) => smoke.processLeaks)),
    errors: smokes.flatMap((smoke) => smoke.errors ?? []),
    smokes: smokes.map((smoke) => ({
      durationMs: smoke.durationMs ?? null,
      safeCommandMs: smoke.safeCommandMs ?? null,
      safeCommandSucceeded: smoke.safeCommandSucceeded ?? null,
      safeCommandBoundary: smoke.safeCommandBoundary ?? null,
      dangerousCommandBlocked: smoke.dangerousCommandBlocked ?? null,
      dangerousCommandBoundary: smoke.dangerousCommandBoundary ?? null,
      dangerousPayloadExecuted: smoke.dangerousPayloadExecuted ?? null,
      outputTruncated: smoke.outputTruncated ?? null,
      timeoutMs: smoke.timeoutMs ?? null,
      processLeaks: smoke.processLeaks ?? null,
      errors: smoke.errors ?? []
    }))
  };
}

function collectMcpToolCallEvidence(results) {
  const smokes = results
    .filter((result) => result.command?.includes("mcp-tool-call-smoke.mjs"))
    .map((result) => parseSchemaOutput(result, "kova.mcpToolCallSmoke.v1"))
    .filter(Boolean);
  if (smokes.length === 0) {
    return {
      schemaVersion: "kova.mcpToolCallEvidence.v1",
      available: false,
      initializeMs: null,
      toolsListMs: null,
      toolsCallMs: null,
      invalidToolsCallMs: null,
      shutdownMs: null,
      toolCount: null,
      toolNames: [],
      safeToolSucceeded: null,
      safeToolName: null,
      invalidToolErrorAttributed: null,
      processExited: null,
      errors: [],
      smokes: []
    };
  }
  return {
    schemaVersion: "kova.mcpToolCallEvidence.v1",
    available: true,
    initializeMs: maxNullable(...smokes.map((smoke) => smoke.initializeMs)),
    toolsListMs: maxNullable(...smokes.map((smoke) => smoke.toolsListMs)),
    toolsCallMs: maxNullable(...smokes.map((smoke) => smoke.toolsCallMs)),
    invalidToolsCallMs: maxNullable(...smokes.map((smoke) => smoke.invalidToolsCallMs)),
    shutdownMs: maxNullable(...smokes.map((smoke) => smoke.shutdownMs)),
    toolCount: maxNullable(...smokes.map((smoke) => smoke.toolCount)),
    toolNames: [...new Set(smokes.flatMap((smoke) => smoke.toolNames ?? []))].sort(),
    safeToolSucceeded: smokes.every((smoke) => smoke.safeToolSucceeded === true),
    safeToolName: smokes.find((smoke) => typeof smoke.safeToolName === "string")?.safeToolName ?? null,
    invalidToolErrorAttributed: smokes.every((smoke) => smoke.invalidToolErrorAttributed === true),
    processExited: smokes.every((smoke) => smoke.processExited === true),
    errors: smokes.flatMap((smoke) => smoke.errors ?? []),
    smokes: smokes.map((smoke) => ({
      durationMs: smoke.durationMs ?? null,
      initializeMs: smoke.initializeMs ?? null,
      toolsListMs: smoke.toolsListMs ?? null,
      toolsCallMs: smoke.toolsCallMs ?? null,
      invalidToolsCallMs: smoke.invalidToolsCallMs ?? null,
      shutdownMs: smoke.shutdownMs ?? null,
      toolCount: smoke.toolCount ?? null,
      toolNames: smoke.toolNames ?? [],
      safeToolName: smoke.safeToolName ?? null,
      safeToolSucceeded: smoke.safeToolSucceeded ?? null,
      invalidToolErrorAttributed: smoke.invalidToolErrorAttributed ?? null,
      processExited: smoke.processExited ?? null,
      errors: smoke.errors ?? []
    }))
  };
}

function combineMcpLifecycleEvidence(mcpBridgeEvidence, mcpToolCallEvidence) {
  const sources = [mcpBridgeEvidence, mcpToolCallEvidence].filter((evidence) => evidence.available);
  if (sources.length === 0) {
    return {
      schemaVersion: "kova.mcpLifecycleEvidence.v1",
      available: false,
      initializeMs: null,
      toolsListMs: null,
      shutdownMs: null,
      toolCount: null,
      toolNames: [],
      processExited: null,
      processLeaks: null
    };
  }
  const processExited = sources.every((evidence) => evidence.processExited === true);
  return {
    schemaVersion: "kova.mcpLifecycleEvidence.v1",
    available: true,
    initializeMs: maxNullable(...sources.map((evidence) => evidence.initializeMs)),
    toolsListMs: maxNullable(...sources.map((evidence) => evidence.toolsListMs)),
    shutdownMs: maxNullable(...sources.map((evidence) => evidence.shutdownMs)),
    toolCount: maxNullable(...sources.map((evidence) => evidence.toolCount)),
    toolNames: [...new Set(sources.flatMap((evidence) => evidence.toolNames ?? []))].sort(),
    processExited,
    processLeaks: processExited ? 0 : 1
  };
}

function collectDirtyPluginEvidence(record) {
  const entries = collectPhaseResultEntries(record);
  const summaries = entries
    .filter(({ result }) => result.command?.includes("dirty-plugin-state.mjs"))
    .map(({ phase, result }) => ({ phase, result, parsed: parseSchemaOutput(result, "kova.dirtyPluginState.v1") }))
    .filter((entry) => entry.parsed);
  const verifierSummaries = summaries.filter(({ result }) => result.command?.includes(" verify "));
  const pluginCommands = entries.filter(({ phase, result }) =>
    (phase.id === "plugin-inspect" || phase.id === "restart") &&
    / -- plugins (?:list|update\b)/.test(result.command ?? "")
  );
  const pluginCommandText = pluginCommands.map(({ result }) => `${result.stdout ?? ""}\n${result.stderr ?? ""}`).join("\n");
  const pluginCommandStatuses = pluginCommands.map(({ result }) => result.status);
  const verifierFailures = verifierSummaries.flatMap(({ parsed }) => parsed.failures ?? []);
  const failedVerifierCommands = summaries
    .filter(({ result }) => result.status !== 0)
    .map(({ result }) => firstLine(result.stderr) || firstLine(result.stdout) || `dirty plugin verifier exited ${result.status}`);
  const dirtyRecords = summaries.flatMap(({ parsed }) => parsed.pluginRecords ?? [])
    .filter((plugin) => String(plugin.id ?? "").startsWith("kova-dirty-"));
  const checksumVerdicts = verifierSummaries
    .map(({ parsed }) => typeof parsed.ok === "boolean" ? parsed.ok : null)
    .filter((value) => value !== null);

  return {
    schemaVersion: "kova.dirtyPluginEvidence.v1",
    available: summaries.length > 0 || pluginCommands.length > 0,
    dirtyPluginDetected: dirtyRecords.length > 0 ? dirtyRecords.some((plugin) => plugin.dirty === true || plugin.partial === true || plugin.broken === true || plugin.symlink === true || plugin.staleDeps === true || plugin.manifestDrift === true) : null,
    dirtyPluginReported: pluginCommandText.length > 0 ? /kova-dirty-|dirty plugin|dirty/i.test(pluginCommandText) : null,
    dirtyPluginChecksumPreserved: checksumVerdicts.length > 0 ? checksumVerdicts.every(Boolean) : null,
    doctorDestructiveChangeCount: verifierSummaries.length > 0 ? verifierFailures.length : null,
    pluginsUsableWithDirtyState: pluginCommandStatuses.length > 0 ? pluginCommandStatuses.every((status) => status === 0) : null,
    gatewaySurvivedDirtyPlugin: dirtyGatewaySurvived(record, entries),
    errors: [...verifierFailures, ...failedVerifierCommands],
    summaries: summaries.map(({ phase, result, parsed }) => ({
      phaseId: phase.id,
      command: result.command,
      status: result.status,
      state: parsed.state ?? null,
      ok: parsed.ok ?? null,
      aggregateMarkerMissing: parsed.aggregateMarkerMissing ?? null,
      pluginRecordCount: Array.isArray(parsed.pluginRecords) ? parsed.pluginRecords.length : 0,
      failures: parsed.failures ?? []
    }))
  };
}

function collectReleaseRecoveryEvidence(record) {
  const entries = collectPhaseResultEntries(record);
  const upgradeVersion = extractPhaseVersion(entries, "upgrade");
  const retryVersion = extractPhaseVersion(entries, "update-retry");
  const rollbackResult = entries.find(({ phase, result }) =>
    phase.id === "rollback" && result.command?.includes("restore-first-ocm-upgrade-snapshot.mjs")
  )?.result ?? null;
  const rollbackParsed = rollbackResult ? parseSchemaOutput(rollbackResult, "kova.ocmUpgradeSnapshotRestore.v1") : null;
  const doctorResults = entries.filter(({ phase, result }) =>
    phase.id === "doctor-repair" && isDoctorFixCommand(result.command)
  );
  const doctorSummaries = doctorResults
    .map(({ result }) => parseSchemaOutput(result, "kova.doctorRepair.v1"))
    .filter(Boolean);
  const postUpgradePluginCommands = entries.filter(({ phase, result }) =>
    phase.id === "plugin-health" && / -- plugins (?:list|update\b)/.test(result.command ?? "")
  );
  const postRollbackPluginCommands = entries.filter(({ phase, result }) =>
    phase.id === "rollback" && / -- plugins list\b/.test(result.command ?? "")
  );
  const rollbackVerifier = entries
    .filter(({ phase, result }) => phase.id === "state-rollback" && result.command?.includes("dirty-plugin-state.mjs") && result.command.includes(" verify "))
    .map(({ result }) => parseSchemaOutput(result, "kova.dirtyPluginState.v1"))
    .filter(Boolean);
  const rollbackFailures = rollbackVerifier.flatMap((parsed) => parsed.failures ?? []);
  const restoreFailure = rollbackResult && rollbackResult.status !== 0
    ? firstLine(rollbackResult.stderr) || firstLine(rollbackResult.stdout) || `rollback restore exited ${rollbackResult.status}`
    : null;
  const doctorEvidenceMissing = doctorResults.length > 0 && doctorSummaries.length === 0
    ? "doctor repair command did not emit kova.doctorRepair.v1 evidence"
    : null;
  const doctorFailures = doctorSummaries.flatMap((parsed) => parsed.errors ?? []);

  return {
    schemaVersion: "kova.releaseRecoveryEvidence.v1",
    available: Boolean(upgradeVersion || retryVersion || rollbackResult || doctorResults.length || doctorSummaries.length || postUpgradePluginCommands.length || postRollbackPluginCommands.length || rollbackVerifier.length),
    doctorFixSucceeded: doctorSummaries.length > 0 ? doctorSummaries.every((parsed) => parsed.doctorFixSucceeded === true) : null,
    doctorUnrepairedFindingCount: doctorSummaries.length > 0 ? sumNumbers(doctorSummaries.map((parsed) => parsed.doctorUnrepairedFindingCount)) : null,
    updateRetryVersionDrift: upgradeVersion && retryVersion ? (upgradeVersion === retryVersion ? 0 : 1) : null,
    upgradeVersion,
    retryVersion,
    rollbackAvailable: rollbackResult ? rollbackResult.status === 0 && Boolean(rollbackParsed?.snapshotId) : null,
    rollbackSucceeded: rollbackResult ? rollbackResult.status === 0 && Boolean(rollbackParsed?.restored) : null,
    pluginsUsableAfterUpgrade: postUpgradePluginCommands.length > 0 ? postUpgradePluginCommands.every(({ result }) => result.status === 0) : null,
    pluginsUsableAfterRollback: postRollbackPluginCommands.length > 0 ? postRollbackPluginCommands.every(({ result }) => result.status === 0) : null,
    rollbackPreservedPluginData: rollbackVerifier.length > 0 ? rollbackVerifier.every((parsed) => parsed.ok === true) : null,
    errors: [restoreFailure, doctorEvidenceMissing, ...doctorFailures, ...rollbackFailures].filter(Boolean),
    doctor: doctorSummaries.map((parsed) => ({
      status: parsed.status ?? null,
      doctorFixSucceeded: parsed.doctorFixSucceeded ?? null,
      doctorUnrepairedFindingCount: parsed.doctorUnrepairedFindingCount ?? null
    })),
    rollback: rollbackResult ? {
      status: rollbackResult.status,
      snapshotId: rollbackParsed?.snapshotId ?? null,
      selectedBy: rollbackParsed?.selectedBy ?? null
    } : null
  };
}

function parseSchemaOutput(result, schemaVersion) {
  const text = result.stdout ?? "";
  const jsonStart = text.indexOf("{");
  if (jsonStart < 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(text.slice(jsonStart));
    return parsed?.schemaVersion === schemaVersion ? parsed : null;
  } catch {
    return null;
  }
}

function nullableEvery(values) {
  const concrete = values.filter((value) => value !== null && value !== undefined);
  return concrete.length === 0 ? null : concrete.every((value) => value === true);
}

function dirtyGatewaySurvived(record, entries) {
  if (record.finalMetrics?.service?.gatewayState === "running") {
    return true;
  }
  const statusResults = entries.filter(({ phase, result }) =>
    (phase.id === "doctor" || phase.id === "restart") &&
    (/ -- status\b/.test(result.command ?? "") || /service status/.test(result.command ?? ""))
  );
  return statusResults.length > 0 ? statusResults.every(({ result }) => result.status === 0) : null;
}

function extractPhaseVersion(entries, phaseId) {
  const result = entries.find(({ phase, result }) => phase.id === phaseId && / -- --version\b/.test(result.command ?? ""))?.result;
  if (!result) {
    return null;
  }
  return extractOpenClawVersion(result.stdout) ?? extractOpenClawVersion(result.stderr);
}

function extractOpenClawVersion(text = "") {
  const match = String(text).match(/\b(\d{4}\.\d+\.\d+(?:[-+._a-z0-9]+)?)\b/i);
  return match?.[1] ?? null;
}

function firstLine(value) {
  return String(value ?? "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

function collectBrowserAutomationEvidence(results) {
  const smokes = results
    .filter((result) => result.command?.includes("browser-automation-smoke.mjs"))
    .map((result) => parseBrowserAutomationSmokeOutput(result))
    .filter(Boolean);

  if (smokes.length === 0) {
    return {
      schemaVersion: "kova.browserAutomationEvidence.v1",
      available: false,
      browserDoctorMs: null,
      browserStartMs: null,
      browserTabsMs: null,
      browserOpenMs: null,
      browserSnapshotMs: null,
      browserStopMs: null,
      browserTabCount: null,
      browserSnapshotOk: null,
      browserStopped: null,
      errors: [],
      smokes: []
    };
  }

  return {
    schemaVersion: "kova.browserAutomationEvidence.v1",
    available: true,
    browserDoctorMs: maxNullable(...smokes.map((smoke) => smoke.browserDoctorMs)),
    browserStartMs: maxNullable(...smokes.map((smoke) => smoke.browserStartMs)),
    browserTabsMs: maxNullable(...smokes.map((smoke) => smoke.browserTabsMs)),
    browserOpenMs: maxNullable(...smokes.map((smoke) => smoke.browserOpenMs)),
    browserSnapshotMs: maxNullable(...smokes.map((smoke) => smoke.browserSnapshotMs)),
    browserStopMs: maxNullable(...smokes.map((smoke) => smoke.browserStopMs)),
    browserTabCount: maxNullable(...smokes.map((smoke) => smoke.browserTabCount)),
    browserSnapshotOk: smokes.every((smoke) => smoke.browserSnapshotOk === true),
    browserStopped: smokes.every((smoke) => smoke.browserStopped === true),
    errors: smokes.flatMap((smoke) => smoke.errors ?? []),
    smokes: smokes.map((smoke) => ({
      durationMs: smoke.durationMs ?? null,
      browserDoctorMs: smoke.browserDoctorMs ?? null,
      browserStartMs: smoke.browserStartMs ?? null,
      browserTabsMs: smoke.browserTabsMs ?? null,
      browserOpenMs: smoke.browserOpenMs ?? null,
      browserSnapshotMs: smoke.browserSnapshotMs ?? null,
      browserStopMs: smoke.browserStopMs ?? null,
      browserTabCount: smoke.browserTabCount ?? null,
      browserSnapshotOk: smoke.browserSnapshotOk ?? null,
      browserStopped: smoke.browserStopped ?? null,
      errors: smoke.errors ?? []
    }))
  };
}

function parseBrowserAutomationSmokeOutput(result) {
  const text = result.stdout ?? "";
  const jsonStart = text.indexOf("{");
  if (jsonStart < 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(text.slice(jsonStart));
    return parsed?.schemaVersion === "kova.browserAutomationSmoke.v1" ? parsed : null;
  } catch {
    return null;
  }
}

function collectMediaUnderstandingEvidence(results) {
  const smokes = results
    .filter((result) => result.command?.includes("media-understanding-timeout.mjs"))
    .map((result) => parseMediaUnderstandingTimeoutOutput(result))
    .filter(Boolean);

  if (smokes.length === 0) {
    return {
      schemaVersion: "kova.mediaUnderstandingEvidence.v1",
      available: false,
      mediaDescribeMs: null,
      mediaTimeoutObserved: null,
      mediaCommandTimedOut: null,
      mediaStatusAfterTimeoutMs: null,
      gatewayStatusWorks: null,
      errors: [],
      smokes: []
    };
  }

  return {
    schemaVersion: "kova.mediaUnderstandingEvidence.v1",
    available: true,
    mediaDescribeMs: maxNullable(...smokes.map((smoke) => smoke.mediaDescribeMs)),
    mediaTimeoutObserved: smokes.every((smoke) => smoke.mediaTimeoutObserved === true),
    mediaCommandTimedOut: smokes.some((smoke) => smoke.mediaCommandTimedOut === true),
    mediaStatusAfterTimeoutMs: maxNullable(...smokes.map((smoke) => smoke.mediaStatusAfterTimeoutMs)),
    gatewayStatusWorks: smokes.every((smoke) => smoke.gatewayStatusWorks === true),
    errors: smokes.flatMap((smoke) => smoke.errors ?? []),
    smokes: smokes.map((smoke) => ({
      durationMs: smoke.durationMs ?? null,
      mediaDescribeMs: smoke.mediaDescribeMs ?? null,
      mediaTimeoutObserved: smoke.mediaTimeoutObserved ?? null,
      mediaCommandTimedOut: smoke.mediaCommandTimedOut ?? null,
      mediaCommandStatus: smoke.mediaCommandStatus ?? null,
      mediaStatusAfterTimeoutMs: smoke.mediaStatusAfterTimeoutMs ?? null,
      gatewayStatusWorks: smoke.gatewayStatusWorks ?? null,
      errors: smoke.errors ?? []
    }))
  };
}

function parseMediaUnderstandingTimeoutOutput(result) {
  const text = result.stdout ?? "";
  const jsonStart = text.indexOf("{");
  if (jsonStart < 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(text.slice(jsonStart));
    return parsed?.schemaVersion === "kova.mediaUnderstandingTimeout.v1" ? parsed : null;
  } catch {
    return null;
  }
}

function collectNetworkOfflineEvidence(results) {
  const smokes = results
    .filter((result) => result.command?.includes("agent-network-offline.mjs"))
    .map((result) => parseNetworkOfflineOutput(result))
    .filter(Boolean);

  if (smokes.length === 0) {
    return {
      schemaVersion: "kova.networkOfflineEvidence.v1",
      available: false,
      networkTurnMs: null,
      networkFailureObserved: null,
      networkCommandTimedOut: null,
      networkStatusAfterFailureMs: null,
      gatewayStatusWorks: null,
      errors: [],
      smokes: []
    };
  }

  return {
    schemaVersion: "kova.networkOfflineEvidence.v1",
    available: true,
    networkTurnMs: maxNullable(...smokes.map((smoke) => smoke.networkTurnMs)),
    networkFailureObserved: smokes.every((smoke) => smoke.networkFailureObserved === true),
    networkCommandTimedOut: smokes.some((smoke) => smoke.networkCommandTimedOut === true),
    networkStatusAfterFailureMs: maxNullable(...smokes.map((smoke) => smoke.networkStatusAfterFailureMs)),
    gatewayStatusWorks: smokes.every((smoke) => smoke.gatewayStatusWorks === true),
    errors: smokes.flatMap((smoke) => smoke.errors ?? []),
    smokes: smokes.map((smoke) => ({
      durationMs: smoke.durationMs ?? null,
      networkTurnMs: smoke.networkTurnMs ?? null,
      networkFailureObserved: smoke.networkFailureObserved ?? null,
      networkCommandTimedOut: smoke.networkCommandTimedOut ?? null,
      networkCommandStatus: smoke.networkCommandStatus ?? null,
      networkStatusAfterFailureMs: smoke.networkStatusAfterFailureMs ?? null,
      gatewayStatusWorks: smoke.gatewayStatusWorks ?? null,
      errors: smoke.errors ?? []
    }))
  };
}

function parseNetworkOfflineOutput(result) {
  const text = result.stdout ?? "";
  const jsonStart = text.indexOf("{");
  if (jsonStart < 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(text.slice(jsonStart));
    return parsed?.schemaVersion === "kova.agentNetworkOffline.v1" ? parsed : null;
  } catch {
    return null;
  }
}

function collectOfficialPluginEvidence(results) {
  const runs = results
    .filter((result) => result.command?.includes("run-official-plugin-install.mjs"))
    .map((result) => parseOfficialPluginInstallOutput(result))
    .filter(Boolean);

  if (runs.length === 0) {
    return {
      schemaVersion: "kova.officialPluginEvidence.v1",
      available: false,
      ok: null,
      pluginCount: 0,
      requiredPluginCount: 0,
      failedRequiredCount: 0,
      durationMs: null,
      installed: null,
      listed: null,
      registryRefreshed: null,
      securityBlockCount: null,
      securityEvidence: null,
      failureEvidence: [],
      artifactPath: null,
      runs: []
    };
  }

  const securityBlockCounts = runs.map((run) => run.securityBlockCount);
  const securityBlockCount = securityBlockCounts.every((count) => Number.isInteger(count) && count >= 0)
    ? securityBlockCounts.reduce((total, count) => total + count, 0)
    : null;

  return {
    schemaVersion: "kova.officialPluginEvidence.v1",
    available: true,
    ok: runs.every((run) => run.ok === true),
    pluginCount: maxNullable(...runs.map((run) => run.pluginCount)),
    requiredPluginCount: maxNullable(...runs.map((run) => run.requiredPluginCount)),
    failedRequiredCount: runs.reduce((total, run) => total + (run.failedRequiredCount ?? 0), 0),
    durationMs: maxNullable(...runs.map((run) => run.durationMs)),
    installed: runs.every((run) => run.installed === true),
    listed: runs.every((run) => run.listed === true),
    registryRefreshed: runs.every((run) => run.registryRefreshed === true),
    securityBlockCount,
    securityEvidence: runs.find((run) => run.securityBlocked === true)?.securityEvidence ?? null,
    failureEvidence: runs.flatMap((run) => run.failureEvidence ?? []),
    artifactPath: runs.find((run) => typeof run.artifactPath === "string" && run.artifactPath.length > 0)?.artifactPath ?? null,
    runs: runs.map((run) => ({
      ok: run.ok === true,
      pluginCount: run.pluginCount ?? null,
      requiredPluginCount: run.requiredPluginCount ?? null,
      failedRequiredCount: run.failedRequiredCount ?? null,
      durationMs: run.durationMs ?? null,
      installed: run.installed === true,
      listed: run.listed === true,
      registryRefreshed: run.registryRefreshed === true,
      securityBlocked: run.securityBlocked === true,
      securityBlockCount: run.securityBlockCount ?? null,
      securityEvidence: run.securityEvidence ?? null,
      failureEvidence: run.failureEvidence ?? [],
      artifactPath: run.artifactPath ?? null,
      pluginResults: run.pluginResults ?? [],
      commands: run.commands ?? []
    }))
  };
}

function parseOfficialPluginInstallOutput(result) {
  const text = result.stdout ?? "";
  const jsonStart = text.indexOf("{");
  if (jsonStart < 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(text.slice(jsonStart));
    return parsed?.schemaVersion === "kova.officialPluginInstall.v1" ? parsed : null;
  } catch {
    return null;
  }
}

function officialPluginInstallFailureMessage(evidence) {
  const failure = firstOfficialPluginFailure(evidence);
  if (failure) {
    return failure;
  }
  if (evidence.securityBlockCount > 0) {
    return `official plugin install was blocked by the OpenClaw security scanner: ${evidence.securityEvidence ?? "unknown plugin"}`;
  }
  if (evidence.installed === false) {
    return "one or more official plugin install commands failed";
  }
  if (evidence.listed === false) {
    return "one or more official plugins did not appear in plugins list after install";
  }
  if (evidence.registryRefreshed === false) {
    return "official plugin registry refresh failed after installing one or more official plugins";
  }
  return "official plugin install validation failed";
}

function firstOfficialPluginFailure(evidence) {
  const failure = evidence.failureEvidence?.[0];
  const command = failure?.command;
  if (!failure || !command) {
    return null;
  }
  const plugin = failure.plugin ? `${failure.plugin} ` : "";
  const timedOut = command.timedOut ? " timed out" : "";
  const status = command.status !== null && command.status !== undefined ? ` exited ${command.status}` : " failed";
  const response = firstNonEmptyLine(command.stderrSnippet, command.stdoutSnippet);
  return `${plugin}official plugin command${timedOut || status}: ${command.command ?? command.id}${response ? `; ${response}` : ""}`;
}

function firstNonEmptyLine(...values) {
  for (const value of values) {
    const line = String(value ?? "").split(/\r?\n/).map((item) => item.trim()).find(Boolean);
    if (line) {
      return line;
    }
  }
  return null;
}

function healthFailureCount(samples) {
  return samples.filter((sample) => sample && !sample.ok).length;
}

function summarizeMeasurementScopes(record) {
  const phases = { product: 0, harness: 0, cleanup: 0 };
  const results = { product: 0, harness: 0, cleanup: 0 };
  for (const phase of record.phases ?? []) {
    const phaseScope = measurementScopeForPhase(phase);
    phases[phaseScope] += 1;
    results[phaseScope] += phase.results?.length ?? 0;
  }
  return {
    schemaVersion: "kova.measurementScopeSummary.v1",
    productPhaseCount: phases.product,
    harnessPhaseCount: phases.harness,
    cleanupPhaseCount: phases.cleanup,
    productCommandCount: results.product,
    harnessCommandCount: results.harness,
    cleanupCommandCount: results.cleanup
  };
}

function collectResults(record, options = {}) {
  const excludePhaseIds = new Set(options.excludePhaseIds ?? []);
  const results = [];
  for (const phase of record.phases ?? []) {
    if (excludePhaseIds.has(phase.id)) {
      continue;
    }
    if (options.productOnly === true && !measuredProductPhase(phase)) {
      continue;
    }
    for (const result of phase.results ?? []) {
      results.push(result);
    }
  }
  return results;
}

function collectPhaseResultEntries(record, options = {}) {
  const excludePhaseIds = new Set(options.excludePhaseIds ?? []);
  const entries = [];
  for (const phase of record.phases ?? []) {
    if (excludePhaseIds.has(phase.id)) {
      continue;
    }
    if (options.productOnly === true && !measuredProductPhase(phase)) {
      continue;
    }
    for (const result of phase.results ?? []) {
      entries.push({ phase, result });
    }
  }
  return entries;
}

function recordExpectsGateway(record) {
  return collectResults(record).some((result) => {
    const command = result.command ?? "";
    if (isColdReadyCommand(command) || isWarmReadyCommand(command)) {
      return true;
    }
    return false;
  });
}

function collectGatewayProcessResources(record, options = {}) {
  // collectEnvMetrics.process samples OCM's supervised service.childPid, so it
  // belongs to the gateway role without contaminating aggregate command trees.
  let summary = null;
  for (const phase of record.phases ?? []) {
    if (options.productOnly === true && !measuredProductPhase(phase)) {
      continue;
    }
    summary = mergeGatewayProcessMetrics(summary, phase.metrics?.process, options);
  }
  return mergeGatewayProcessMetrics(summary, record.finalMetrics?.process, options);
}

function mergeGatewayProcessMetrics(summary, process, options = {}) {
  const rssMb = typeof process?.rssMb === "number" ? process.rssMb : null;
  const cpuPercent = !options.intervalCpu && typeof process?.cpuPercent === "number" ? process.cpuPercent : null;
  if (rssMb === null && cpuPercent === null) {
    return summary;
  }
  const next = summary ?? {
    peakRssMb: null,
    maxCpuPercent: null,
    peakRssAtMs: null,
    peakCpuAtMs: null,
    peakProcessCount: 1,
    peakRssProcess: null,
    peakCpuProcess: null
  };
  const compactProcess = {
    pid: process.pid ?? null,
    roles: ["gateway"],
    role: "gateway",
    rssMb,
    cpuPercent,
    command: process.command ?? null
  };
  if (rssMb !== null && (next.peakRssMb === null || rssMb > next.peakRssMb)) {
    next.peakRssMb = rssMb;
    next.peakRssProcess = compactProcess;
  }
  if (cpuPercent !== null && (next.maxCpuPercent === null || cpuPercent > next.maxCpuPercent)) {
    next.maxCpuPercent = cpuPercent;
    next.peakCpuProcess = compactProcess;
  }
  return next;
}

function collectResourceSummary(results, options = {}) {
  let sampleCount = 0;
  let peakTotalRssMb = null;
  let maxTotalCpuPercent = null;
  let maxTotalCpuPercentLower = null;
  let peakCommandTreeRssMb = null;
  let peakGatewayRssMb = null;
  let peakRssSample = null;
  let peakCpuSample = null;
  let maxTotalRssGrowthMb = null;
  let maxGatewayRssGrowthMb = null;
  let trend = null;
  const artifacts = [];
  const byPid = new Map();
  const byRole = new Map();

  for (const result of results) {
    const samples = result.resourceSamples;
    if (!samples) {
      continue;
    }
    sampleCount += samples.sampleCount ?? 0;
    peakTotalRssMb = maxNullable(peakTotalRssMb, samples.peakTotalRssMb);
    maxTotalCpuPercent = maxNullable(maxTotalCpuPercent, samples.maxTotalCpuPercent);
    maxTotalCpuPercentLower = maxNullable(maxTotalCpuPercentLower, samples.maxTotalCpuPercentLower);
    peakCommandTreeRssMb = maxNullable(peakCommandTreeRssMb, samples.peakCommandTreeRssMb);
    peakGatewayRssMb = maxNullable(peakGatewayRssMb, samples.peakGatewayRssMb);
    mergeRoleSummaries(byRole, samples.byRole ?? {});
    maxTotalRssGrowthMb = maxNullable(maxTotalRssGrowthMb, samples.trend?.totalRssGrowthMb);
    maxGatewayRssGrowthMb = maxNullable(maxGatewayRssGrowthMb, samples.trend?.gatewayRssGrowthMb);
    trend = maxTrend(trend, samples.trend);
    peakRssSample = maxSample(peakRssSample, samples.peakRssSample, "totalRssMb");
    peakCpuSample = maxSample(peakCpuSample, samples.peakCpuSample, "totalCpuPercent");
    if (samples.artifactPath) {
      artifacts.push(samples.artifactPath);
    }
    for (const process of [...(samples.topByRss ?? []), ...(samples.topByCpu ?? [])]) {
      const processIdentity = `${process.pid}:${process.startTicks ?? "legacy"}`;
      const existing = byPid.get(processIdentity) ?? {
        pid: process.pid,
        ...(process.startTicks === undefined ? {} : { startTicks: process.startTicks }),
        command: process.command,
        role: process.role,
        peakRssMb: 0,
        maxCpuPercent: 0,
        firstSeenMs: process.firstSeenMs,
        lastSeenMs: process.lastSeenMs
      };
      existing.command = process.command;
      existing.role = mergeRoles(existing.role, process.role);
      existing.peakRssMb = Math.max(existing.peakRssMb, process.peakRssMb ?? 0);
      existing.maxCpuPercent = Math.max(existing.maxCpuPercent, process.maxCpuPercent ?? 0);
      existing.firstSeenMs = Math.min(existing.firstSeenMs ?? process.firstSeenMs ?? 0, process.firstSeenMs ?? 0);
      existing.lastSeenMs = Math.max(existing.lastSeenMs ?? process.lastSeenMs ?? 0, process.lastSeenMs ?? 0);
      byPid.set(processIdentity, existing);
    }
  }

  if (options.gatewayProcessResources) {
    mergeRoleSummaries(byRole, { gateway: options.gatewayProcessResources });
    peakGatewayRssMb = maxNullable(peakGatewayRssMb, options.gatewayProcessResources.peakRssMb);
  }

  const processes = [...byPid.values()];
  const roleSummaries = Object.fromEntries([...byRole.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right)));
  const roleList = Object.entries(roleSummaries).map(([role, summary]) => ({ role, ...summary }));
  return {
    sampleCount,
    peakTotalRssMb,
    maxTotalCpuPercent,
    maxTotalCpuPercentLower,
    peakCommandTreeRssMb,
    peakGatewayRssMb,
    maxTotalRssGrowthMb,
    maxGatewayRssGrowthMb,
    trend,
    byRole: roleSummaries,
    topRolesByRss: roleList.toSorted((left, right) => (right.peakRssMb ?? 0) - (left.peakRssMb ?? 0)).slice(0, 8),
    topRolesByCpu: roleList.toSorted((left, right) => (right.maxCpuPercent ?? 0) - (left.maxCpuPercent ?? 0)).slice(0, 8),
    peakRssSample,
    peakCpuSample,
    artifacts,
    topByRss: processes.toSorted((left, right) => right.peakRssMb - left.peakRssMb).slice(0, 5),
    topByCpu: processes.toSorted((left, right) => right.maxCpuPercent - left.maxCpuPercent).slice(0, 5)
  };
}

function maxTrend(current, candidate) {
  if (!candidate?.available) {
    return current;
  }
  if (!current) {
    return candidate;
  }
  const currentGrowth = Math.max(current.totalRssGrowthMb ?? 0, current.gatewayRssGrowthMb ?? 0);
  const candidateGrowth = Math.max(candidate.totalRssGrowthMb ?? 0, candidate.gatewayRssGrowthMb ?? 0);
  return candidateGrowth > currentGrowth ? candidate : current;
}

function mergeRoleSummaries(target, source) {
  for (const [role, summary] of Object.entries(source)) {
    const existing = target.get(role) ?? {
      peakRssMb: null,
      maxCpuPercent: null,
      peakRssAtMs: null,
      peakCpuAtMs: null,
      peakProcessCount: 0,
      peakRssProcess: null,
      peakCpuProcess: null
    };
    if (typeof summary.peakRssMb === "number" && (existing.peakRssMb === null || summary.peakRssMb > existing.peakRssMb)) {
      existing.peakRssMb = summary.peakRssMb;
      existing.peakRssAtMs = summary.peakRssAtMs ?? null;
      existing.peakProcessCount = summary.peakProcessCount ?? 0;
      existing.peakRssProcess = summary.peakRssProcess ?? null;
    }
    if (typeof summary.maxCpuPercent === "number" && (existing.maxCpuPercent === null || summary.maxCpuPercent > existing.maxCpuPercent)) {
      existing.maxCpuPercent = summary.maxCpuPercent;
      existing.peakCpuAtMs = summary.peakCpuAtMs ?? null;
      existing.peakCpuProcess = summary.peakCpuProcess ?? null;
    }
    if (typeof summary.maxCpuPercentLower === "number") existing.maxCpuPercentLower = Math.max(existing.maxCpuPercentLower ?? 0, summary.maxCpuPercentLower);
    target.set(role, existing);
  }
}

function hasAnyThreshold(thresholds, metrics) {
  return metrics.some((metric) => typeof thresholds[metric] === "number");
}

function checkRequiredBooleanGate(violations, kind, metric, actual, threshold, message) {
  if (typeof threshold !== "number") {
    return;
  }
  if (actual === null || actual === undefined) {
    violations.push({
      kind,
      metric,
      expected: threshold >= 1,
      actual: null,
      message: `${message}; metric evidence was not captured`
    });
    return;
  }
  checkBooleanThreshold(violations, kind, metric, actual, threshold, message);
}

function checkRequiredMaxGate(violations, kind, metric, actual, threshold, label) {
  if (typeof threshold !== "number") {
    return;
  }
  if (actual === null || actual === undefined) {
    violations.push({
      kind,
      metric,
      expected: `<= ${threshold}`,
      actual: null,
      message: `${label} evidence was not captured`
    });
    return;
  }
  if (actual > threshold) {
    violations.push({
      kind,
      metric,
      expected: `<= ${threshold}`,
      actual,
      message: `${label} ${actual} exceeded threshold ${threshold}`
    });
  }
}

function checkRequiredMinGate(violations, kind, metric, actual, threshold, label) {
  if (typeof threshold !== "number") {
    return;
  }
  if (actual === null || actual === undefined) {
    violations.push({
      kind,
      metric,
      expected: `>= ${threshold}`,
      actual: null,
      message: `${label} evidence was not captured`
    });
    return;
  }
  if (actual < threshold) {
    violations.push({
      kind,
      metric,
      expected: `>= ${threshold}`,
      actual,
      message: `${label} ${actual} below threshold ${threshold}`
    });
  }
}

function maxSample(current, candidate, key) {
  if (!candidate || typeof candidate[key] !== "number") {
    return current;
  }
  if (!current || candidate[key] > current[key]) {
    return candidate;
  }
  return current;
}

function compactSampleProcess(process) {
  if (!process) {
    return null;
  }
  return {
    pid: process.pid ?? null,
    role: process.role ?? null,
    rssMb: process.rssMb ?? process.peakRssMb ?? null,
    cpuPercent: process.cpuPercent ?? process.maxCpuPercent ?? null,
    command: process.command ?? null
  };
}

export function compactEvaluatedTimelineEvidence(record) {
  const timelines = recordTimelines(record);
  const currentTimeline = timelines.findLast((timeline) => timeline.available) ?? null;
  let attributionTimeline = null;
  let attributionEventCount = -1;
  for (const timeline of timelines) {
    const eventCount = timeline.eventCount ?? timeline.events?.length ?? 0;
    if (eventCount >= attributionEventCount && Array.isArray(timeline.events)) {
      attributionTimeline = timeline;
      attributionEventCount = eventCount;
    }
  }

  const retained = new Set([currentTimeline, attributionTimeline].filter(Boolean));
  for (const timeline of timelines) {
    delete timeline.openSpansAll;
    if (retained.has(timeline)) {
      continue;
    }
    delete timeline.events;
    delete timeline.turnAttributionEvents;
  }
}

function collectTimelineSummary(record, { intentionalRestartSourcePids = new Set() } = {}) {
  const timelines = recordTimelines(record);

  const available = timelines.some((timeline) => timeline.available);
  // A rotated final timeline owns terminal span state; the most complete
  // snapshot retains attribution history from before the rotation.
  const currentTimeline = timelines.findLast((timeline) => timeline.available) ?? null;
  let attributionTimeline = null;
  let attributionEventCount = -1;
  for (const timeline of timelines) {
    const eventCount = timeline.eventCount ?? timeline.events?.length ?? 0;
    if (eventCount >= attributionEventCount && Array.isArray(timeline.events)) {
      attributionTimeline = timeline;
      attributionEventCount = eventCount;
    }
  }
  let eventCount = 0;
  let parseErrorCount = 0;
  let slowestSpan = null;
  let eventLoopMaxMs = null;
  let providerRequestMaxMs = null;
  let childProcessFailedCount = 0;
  let repeatedSpanCount = 0;
  let runtimeDepsStageMaxMs = null;
  let slowestRuntimeDepsPlugin = null;
  const terminalGatewayPid = currentTimeline?.terminalGatewayPid ?? null;
  const rawOpenSpans = currentTimeline?.openSpansAll ?? currentTimeline?.openSpans ?? [];
  const interruptedRestartSpans = terminalGatewayPid !== null
    ? rawOpenSpans.filter((span) =>
      span.pid !== null &&
      span.pid !== terminalGatewayPid &&
      intentionalRestartSourcePids.has(span.pid)
    )
    : [];
  const interruptedRestartSpanSet = new Set(interruptedRestartSpans);
  const latestOpenSpansAll = rawOpenSpans.filter((span) => !interruptedRestartSpanSet.has(span));
  const latestOpenSpanCount = latestOpenSpansAll.length;
  const latestOpenSpans = latestOpenSpansAll
    .toSorted((left, right) => (right.ageMs ?? -1) - (left.ageMs ?? -1))
    .slice(0, 25);
  const events = attributionTimeline?.events ?? [];
  const turnAttributionEvents = Array.isArray(attributionTimeline?.turnAttributionEvents)
    ? attributionTimeline.turnAttributionEvents
    : [];
  const artifacts = new Set();
  const keySpans = {};
  const spanTotals = {};

  for (const timeline of timelines) {
    for (const artifact of timeline.artifacts ?? []) {
      artifacts.add(artifact);
    }
    eventCount = Math.max(eventCount, timeline.eventCount ?? 0);
    parseErrorCount = Math.max(parseErrorCount, timeline.parseErrorCount ?? 0);
    childProcessFailedCount = Math.max(childProcessFailedCount, timeline.childProcesses?.failedCount ?? 0);
    repeatedSpanCount = Math.max(repeatedSpanCount, timeline.repeatedSpans?.length ?? 0);
    mergeKeySpans(keySpans, timeline.keySpans ?? {}, {
      current: timeline === currentTimeline
    });
    mergeSpanTotals(spanTotals, timeline.spanTotals ?? {});
    eventLoopMaxMs = maxNullable(eventLoopMaxMs, timeline.eventLoop?.maxMs);
    providerRequestMaxMs = maxNullable(providerRequestMaxMs, timeline.providers?.maxDurationMs);
    runtimeDepsStageMaxMs = maxNullable(
      runtimeDepsStageMaxMs,
      timeline.runtimeDeps?.maxDurationMs ?? timeline.spanTotals?.["runtimeDeps.stage"]?.maxDurationMs
    );

    const runtimeDepsCandidate = timeline.runtimeDeps?.slowest;
    if (runtimeDepsCandidate && typeof runtimeDepsCandidate.durationMs === "number") {
      if (!slowestRuntimeDepsPlugin || runtimeDepsCandidate.durationMs > slowestRuntimeDepsPlugin.durationMs) {
        slowestRuntimeDepsPlugin = runtimeDepsCandidate;
      }
    }

    const candidate = timeline.slowestSpans?.[0];
    if (candidate && typeof candidate.durationMs === "number") {
      if (!slowestSpan || candidate.durationMs > slowestSpan.durationMs) {
        slowestSpan = candidate;
      }
    }
  }

  replaceKeySpanOpenState(keySpans, latestOpenSpansAll);

  return {
    available,
    eventCount,
    parseErrorCount,
    slowestSpanName: slowestSpan?.name ?? null,
    slowestSpanMs: slowestSpan?.durationMs ?? null,
    repeatedSpanCount,
    openSpanCount: latestOpenSpanCount,
    openSpans: latestOpenSpans,
    openSpansAll: latestOpenSpansAll,
    interruptedRestartSpanCount: interruptedRestartSpans.length,
    interruptedRestartSpans: interruptedRestartSpans.slice(0, 25),
    terminalGatewayPid,
    artifacts: [...artifacts],
    timelineArtifacts: [...artifacts],
    events,
    turnAttributionEvents,
    keySpans,
    spanTotals,
    eventLoopMaxMs,
    providerRequestMaxMs,
    childProcessFailedCount,
    runtimeDepsStageMaxMs,
    runtimeDepsStagePluginId: slowestRuntimeDepsPlugin?.pluginId ?? null
  };
}

function replaceKeySpanOpenState(keySpans, openSpans) {
  for (const [name, summary] of Object.entries(keySpans)) {
    const open = openSpans.filter((span) => keyTimelineSpanMatches(name, span.name));
    summary.openCount = open.length;
    summary.open = open.slice(0, 5);
  }
}

function keyTimelineSpanMatches(keyName, spanName) {
  if (keyName === "gateway.chat_send" || keyName === "auto_reply" || keyName === "reply") {
    return spanName === keyName || spanName.startsWith(`${keyName}.`);
  }
  return spanName === keyName;
}

function recordTimelines(record) {
  const timelines = [];
  for (const phase of record.phases ?? []) {
    if (phase.metrics?.timeline) {
      timelines.push(phase.metrics.timeline);
    }
  }
  if (record.finalMetrics?.timeline) {
    timelines.push(record.finalMetrics.timeline);
  }
  return timelines;
}

function mergeSpanTotals(target, source) {
  for (const [name, summary] of Object.entries(source)) {
    const existing = target[name] ?? {
      name,
      count: 0,
      errorCount: 0,
      openCount: 0,
      totalDurationMs: 0,
      maxDurationMs: null,
      slowest: null
    };
    existing.count = Math.max(existing.count, summary.count ?? 0);
    existing.errorCount = Math.max(existing.errorCount, summary.errorCount ?? 0);
    existing.openCount = Math.max(existing.openCount, summary.openCount ?? 0);
    existing.totalDurationMs = Math.max(existing.totalDurationMs, summary.totalDurationMs ?? 0);
    existing.maxDurationMs = maxNullable(existing.maxDurationMs, summary.maxDurationMs);
    if (summary.slowest?.durationMs !== undefined &&
      (!existing.slowest || summary.slowest.durationMs > existing.slowest.durationMs)) {
      existing.slowest = summary.slowest;
    }
    target[name] = existing;
  }
}

function mergeKeySpans(target, source, { current = false } = {}) {
  for (const [name, summary] of Object.entries(source)) {
    const existing = target[name] ?? {
      name,
      count: 0,
      errorCount: 0,
      openCount: 0,
      totalDurationMs: 0,
      maxDurationMs: null,
      slowest: null,
      open: []
    };
    existing.count = Math.max(existing.count, summary.count ?? 0);
    existing.errorCount = Math.max(existing.errorCount, summary.errorCount ?? 0);
    existing.totalDurationMs = Math.max(existing.totalDurationMs, summary.totalDurationMs ?? 0);
    existing.maxDurationMs = maxNullable(existing.maxDurationMs, summary.maxDurationMs);
    if (summary.slowest?.durationMs !== undefined &&
      (!existing.slowest || summary.slowest.durationMs > existing.slowest.durationMs)) {
      existing.slowest = summary.slowest;
    }
    if (current) {
      existing.openCount = summary.openCount ?? summary.open?.length ?? 0;
      existing.open = [...(summary.open ?? [])].slice(0, 5);
    }
    target[name] = existing;
  }
}

function maxNullable(...values) {
  const numbers = values.filter((value) => typeof value === "number");
  return numbers.length === 0 ? null : Math.max(...numbers);
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isoOrNull(epochMs) {
  return typeof epochMs === "number" && Number.isFinite(epochMs) ? new Date(epochMs).toISOString() : null;
}

function delta(left, right) {
  return typeof left === "number" && typeof right === "number" ? Math.max(0, left - right) : null;
}

function roundNumber(value) {
  return Math.round(value * 100) / 100;
}

function mergeRoles(left, right) {
  const roles = new Set(`${left ?? ""},${right ?? ""}`.split(",").filter(Boolean));
  return [...roles].join(",");
}

const LOG_METRIC_PATTERNS = {
  missingDependencyErrors: /cannot find (module|package)|missing dependenc|missing runtime dep/i,
  pluginLoadFailures: /\[plugins\].*failed to load|plugin.*failed to load|\[plugins\].*failed during register|plugin.*failed during register|\[plugins\].*plugin service failed|plugin service failed/i,
  metadataScanMentions: /collectBundledPluginMetadata|bundled plugin metadata|manifest read|readdirSync/i,
  configNormalizationMentions: /config normal/i,
  gatewayRestartMentions: /gateway.*restart|restart.*gateway|service restart|restarting/i,
  providerLoadMentions: /provider.*load|load.*provider|provider registry|auth provider/i,
  modelCatalogMentions: /model catalog|models list|loading models|available models/i,
  eventLoopDelayMentions: /event loop|event-loop|blocked loop|loop delay/i,
  v8DiagnosticMentions: /v8|diagnostic report|heapsnapshot|heap snapshot/i
};

function countLogMetric(record, key, results = [], options = {}) {
  let observed = false;
  let count = 0;
  for (const phase of record.phases ?? []) {
    const value = phase.metrics?.logs?.[key];
    if (typeof value === "number") {
      observed = true;
      count = Math.max(count, value);
    }
  }

  const finalValue = record.finalMetrics?.logs?.[key];
  if (typeof finalValue === "number") {
    observed = true;
    count = Math.max(count, finalValue);
  }

  const commandLogMetric = countExplicitLogCommandMetric(results, key, options);
  if (commandLogMetric.observed || commandLogMetric.count > 0) {
    observed = true;
    count = Math.max(count, commandLogMetric.count);
  }
  return observed ? count : null;
}

function combineCommandAndLogCount(commandCount, logCount, logCommandObserved) {
  if (typeof logCount === "number") {
    return commandCount + logCount;
  }
  if (commandCount > 0) {
    return commandCount;
  }
  return logCommandObserved ? 0 : null;
}

function countExplicitLogCommandMetric(results, key, options = {}) {
  const pattern = LOG_METRIC_PATTERNS[key];
  const providerTimeoutMetric = key === "providerTimeoutMentions";
  if (!pattern && !providerTimeoutMetric) {
    return { observed: false, count: 0 };
  }
  let observed = false;
  let count = 0;
  for (const result of results) {
    if (!isLogCommandResult(result)) {
      continue;
    }
    if (result.status === 0) {
      observed = true;
    }
    const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    const matchCount = providerTimeoutMetric
      ? countProviderTimeoutMentions(text)
      : countPattern(text, pattern, { ignoreLine: options.ignoreLine });
    if (matchCount > 0) {
      observed = true;
      count += matchCount;
    }
  }
  return { observed, count };
}

function expectedPluginFailureLineIgnorer(scenario) {
  const markers = (scenario?.expectedPluginFailureMarkers ?? [])
    .filter((marker) => typeof marker === "string" && marker.length > 0);
  if (markers.length === 0) {
    return null;
  }
  return (line) => markers.some((marker) => String(line ?? "").includes(marker));
}

function hasSuccessfulLogCommandResult(results) {
  return results.some((result) => isLogCommandResult(result) && result.status === 0);
}

function isLogCommandResult(result) {
  return /^ocm\s+logs\s+/.test(result?.command ?? "");
}

function countPattern(text, pattern, { ignoreLine = null } = {}) {
  let count = 0;
  for (const line of String(text ?? "").split("\n")) {
    if (pattern.test(line) && !(typeof ignoreLine === "function" && ignoreLine(line))) {
      count += 1;
    }
  }
  return count;
}

function countHeapSnapshotBytes(record) {
  let observed = false;
  let count = 0;
  for (const metrics of allMetricObjects(record)) {
    if (metrics?.heapSnapshot) {
      observed = true;
    }
    const value = metrics?.heapSnapshot?.artifactBytes;
    if (typeof value === "number") {
      count = Math.max(count, value);
    }
  }
  return observed ? count : null;
}

function countNodeProfileMetric(record, key) {
  let observed = false;
  let count = 0;
  for (const phase of record.phases ?? []) {
    if (phase.metrics?.nodeProfiles) {
      observed = true;
    }
    const value = phase.metrics?.nodeProfiles?.[key];
    if (typeof value === "number") {
      count = Math.max(count, value);
    }
  }

  const finalValue = record.finalMetrics?.nodeProfiles?.[key];
  if (record.finalMetrics?.nodeProfiles) {
    observed = true;
  }
  if (typeof finalValue === "number") {
    count = Math.max(count, finalValue);
  }
  return observed ? count : null;
}

function collectNodeProfileTopFunction(record) {
  let top = null;
  for (const metrics of allMetricObjects(record)) {
    const candidate = metrics?.nodeProfiles?.cpuProfileSummary?.topFunctions?.[0];
    if (!candidate || typeof candidate.selfMs !== "number") {
      continue;
    }
    if (!top || candidate.selfMs > top.selfMs) {
      top = candidate;
    }
  }
  return top;
}

function collectNodeHeapTopFunction(record) {
  let top = null;
  for (const metrics of allMetricObjects(record)) {
    const candidate = metrics?.nodeProfiles?.heapProfileSummary?.topFunctions?.[0];
    if (!candidate || typeof candidate.selfSizeMb !== "number") {
      continue;
    }
    if (!top || candidate.selfSizeMb > top.selfSizeMb) {
      top = candidate;
    }
  }
  return top;
}

function countDiagnosticReportMetric(record, key) {
  let observed = false;
  let count = 0;
  for (const metrics of allMetricObjects(record)) {
    if (metrics?.diagnosticReport) {
      observed = true;
    }
    const value = metrics?.diagnosticReport?.[key];
    if (typeof value === "number") {
      count = Math.max(count, value);
    }
  }
  return observed ? count : null;
}

function buildDiagnosticCorrelation({
  resourceSummary,
  timelineSummary,
  logSummary,
  nodeProfileTopFunction,
  nodeHeapTopFunction,
  eventLoopDelayMs,
  runtimeDepsStagingMs,
  providerModelTimingMs
}) {
  const findings = [];
  if (resourceSummary.peakCpuSample) {
    findings.push({
      kind: "cpu-peak",
      summary: `CPU peaked at ${resourceSummary.peakCpuSample.totalCpuPercent}% around ${resourceSummary.peakCpuSample.elapsedMs}ms`,
      elapsedMs: resourceSummary.peakCpuSample.elapsedMs,
      process: compactSampleProcess(resourceSummary.peakCpuSample.topProcess)
    });
  }
  if (resourceSummary.peakRssSample) {
    findings.push({
      kind: "rss-peak",
      summary: `RSS peaked at ${resourceSummary.peakRssSample.totalRssMb} MB around ${resourceSummary.peakRssSample.elapsedMs}ms`,
      elapsedMs: resourceSummary.peakRssSample.elapsedMs,
      process: compactSampleProcess(resourceSummary.peakRssSample.topProcess)
    });
  }
  if (nodeProfileTopFunction) {
    findings.push({
      kind: "cpu-function",
      summary: `Top sampled CPU function: ${nodeProfileTopFunction.functionName} ${nodeProfileTopFunction.selfMs}ms`,
      functionName: nodeProfileTopFunction.functionName,
      selfMs: nodeProfileTopFunction.selfMs,
      url: nodeProfileTopFunction.url
    });
  }
  if (nodeHeapTopFunction) {
    findings.push({
      kind: "heap-function",
      summary: `Top sampled heap allocation function: ${nodeHeapTopFunction.functionName} ${nodeHeapTopFunction.selfSizeMb} MB`,
      functionName: nodeHeapTopFunction.functionName,
      selfSizeMb: nodeHeapTopFunction.selfSizeMb,
      url: nodeHeapTopFunction.url
    });
  }
  if (timelineSummary.slowestSpanName) {
    findings.push({
      kind: "openclaw-span",
      summary: `Slowest OpenClaw span: ${timelineSummary.slowestSpanName} ${timelineSummary.slowestSpanMs}ms`,
      span: timelineSummary.slowestSpanName,
      durationMs: timelineSummary.slowestSpanMs
    });
  }
  if (timelineSummary.openSpans.length > 0) {
    const span = timelineSummary.openSpans[0];
    findings.push({
      kind: "openclaw-open-span",
      summary: `Open OpenClaw span: ${span.name}${span.ageMs !== null ? ` age ${span.ageMs}ms` : ""}`,
      span: span.name,
      ageMs: span.ageMs
    });
  }
  if (logSummary?.embeddedRuns?.topStages?.length > 0) {
    const stage = logSummary.embeddedRuns.topStages[0];
    findings.push({
      kind: "embedded-run-stage",
      summary: `Slowest embedded agent stage from logs: ${stage.name} ${stage.totalDurationMs}ms`,
      stage: stage.name,
      durationMs: stage.totalDurationMs,
      maxDurationMs: stage.maxDurationMs
    });
  }
  if ((logSummary?.livenessWarnings?.count ?? 0) > 0) {
    findings.push({
      kind: "liveness-warning",
      summary: `OpenClaw liveness warnings: ${logSummary.livenessWarnings.count}, max event-loop delay ${logSummary.livenessWarnings.maxEventLoopDelayMaxMs ?? "unknown"}ms`,
      count: logSummary.livenessWarnings.count,
      eventLoopDelayMaxMs: logSummary.livenessWarnings.maxEventLoopDelayMaxMs
    });
  }
  if (eventLoopDelayMs !== null) {
    findings.push({
      kind: "event-loop",
      summary: `Max structured event-loop delay: ${eventLoopDelayMs}ms`,
      durationMs: eventLoopDelayMs
    });
  }
  if (runtimeDepsStagingMs !== null) {
    findings.push({
      kind: "runtime-deps",
      summary: `Runtime dependency staging max: ${runtimeDepsStagingMs}ms`,
      durationMs: runtimeDepsStagingMs
    });
  }
  if (providerModelTimingMs !== null) {
    findings.push({
      kind: "provider-model",
      summary: `Provider/model timing max: ${providerModelTimingMs}ms`,
      durationMs: providerModelTimingMs
    });
  }
  return {
    schemaVersion: "kova.diagnosticCorrelation.v1",
    findingCount: findings.length,
    findings
  };
}

function collectLogSummary(record) {
  const embeddedRuns = {
    schemaVersion: "kova.embeddedRunTraceSummary.v1",
    available: false,
    eventCount: 0,
    startupCount: 0,
    prepCount: 0,
    totalMaxMs: null,
    stageTotals: {},
    topStages: [],
    events: []
  };
  const livenessWarnings = {
    schemaVersion: "kova.livenessWarningSummary.v1",
    available: false,
    count: 0,
    maxEventLoopDelayP99Ms: null,
    maxEventLoopDelayMaxMs: null,
    maxEventLoopUtilization: null,
    maxCpuCoreRatio: null,
    events: []
  };

  for (const metrics of allMetricObjects(record)) {
    mergeEmbeddedRuns(embeddedRuns, metrics?.logs?.embeddedRuns);
    mergeLivenessWarnings(livenessWarnings, metrics?.logs?.livenessWarnings);
  }

  embeddedRuns.available = embeddedRuns.eventCount > 0;
  embeddedRuns.topStages = Object.values(embeddedRuns.stageTotals)
    .toSorted((left, right) => (right.totalDurationMs - left.totalDurationMs) || left.name.localeCompare(right.name))
    .slice(0, 12);
  livenessWarnings.available = livenessWarnings.count > 0;

  return {
    schemaVersion: "kova.logSummary.v1",
    embeddedRuns,
    livenessWarnings
  };
}

function mergeEmbeddedRuns(target, source) {
  if (!source) {
    return;
  }
  target.eventCount += source.eventCount ?? 0;
  target.startupCount += source.startupCount ?? 0;
  target.prepCount += source.prepCount ?? 0;
  target.totalMaxMs = maxNullable(target.totalMaxMs, source.totalMaxMs);
  target.events = [...target.events, ...(source.events ?? [])].slice(-40);
  for (const [name, summary] of Object.entries(source.stageTotals ?? {})) {
    const current = target.stageTotals[name] ?? {
      name,
      count: 0,
      totalDurationMs: 0,
      maxDurationMs: null,
      maxOffsetMs: null,
      traceKinds: []
    };
    current.count += summary.count ?? 0;
    current.totalDurationMs = roundNumber(current.totalDurationMs + (summary.totalDurationMs ?? 0));
    current.maxDurationMs = maxNullable(current.maxDurationMs, summary.maxDurationMs);
    current.maxOffsetMs = maxNullable(current.maxOffsetMs, summary.maxOffsetMs);
    current.traceKinds = [...new Set([...current.traceKinds, ...(summary.traceKinds ?? [])])].sort();
    target.stageTotals[name] = current;
  }
}

function mergeLivenessWarnings(target, source) {
  if (!source) {
    return;
  }
  target.count += source.count ?? 0;
  target.maxEventLoopDelayP99Ms = maxNullable(target.maxEventLoopDelayP99Ms, source.maxEventLoopDelayP99Ms);
  target.maxEventLoopDelayMaxMs = maxNullable(target.maxEventLoopDelayMaxMs, source.maxEventLoopDelayMaxMs);
  target.maxEventLoopUtilization = maxNullable(target.maxEventLoopUtilization, source.maxEventLoopUtilization);
  target.maxCpuCoreRatio = maxNullable(target.maxCpuCoreRatio, source.maxCpuCoreRatio);
  target.events = [...target.events, ...(source.events ?? [])].slice(-40);
}

function collectOpenClawDiagnostics(record) {
  const values = {
    pluginMetadataScanCount: null,
    configNormalizationCount: null,
    runtimeDepsStagingMs: null,
    eventLoopDelayMs: null,
    providerModelTimingMs: null
  };

  for (const metrics of allMetricObjects(record)) {
    const diagnostics = metrics?.openclawDiagnostics;
    if (!diagnostics) {
      continue;
    }
    values.pluginMetadataScanCount = maxNullable(values.pluginMetadataScanCount, diagnostics.pluginMetadataScanCount);
    values.configNormalizationCount = maxNullable(values.configNormalizationCount, diagnostics.configNormalizationCount);
    values.runtimeDepsStagingMs = maxNullable(values.runtimeDepsStagingMs, diagnostics.runtimeDepsStagingMs);
    values.eventLoopDelayMs = maxNullable(values.eventLoopDelayMs, diagnostics.eventLoopDelayMs);
    values.providerModelTimingMs = maxNullable(values.providerModelTimingMs, diagnostics.providerModelTimingMs);
  }

  return values;
}

function collectRuntimeDepsLogEvidence(record) {
  const phases = (record.phases ?? []).map((phase) => ({
    id: phase.id,
    summary: summarizeRuntimeDepsPhase(phase)
  }));
  const cold = selectRuntimeDepsPhase(phases, ["cold-start", "provision", "start", "gateway"]);
  const warm = selectRuntimeDepsPhase(phases, ["warm-restart", "restart"]);
  const coldStart = compactRuntimeDepsPhase(cold);
  const warmRestart = compactRuntimeDepsWarmPhase(warm, cold);
  const allSummaries = [
    ...phases.map((phase) => phase.summary),
    ...allMetricObjects(record).map((metrics) => metrics.logs?.runtimeDeps).filter(Boolean)
  ];

  return {
    schemaVersion: "kova.runtimeDepsEvidence.v1",
    available: allSummaries.some((summary) => (summary?.eventCount ?? 0) > 0),
    installCount: maxNullable(...allSummaries.map((summary) => summary?.installCount)),
    installMaxMs: maxNullable(...allSummaries.map((summary) => summary?.installMaxMs)),
    postbuildCount: maxNullable(...allSummaries.map((summary) => summary?.postbuildCount)),
    postbuildMaxMs: maxNullable(...allSummaries.map((summary) => summary?.postbuildMaxMs)),
    pluginIds: [...new Set(allSummaries.flatMap((summary) => summary?.pluginIds ?? []))].sort(),
    coldStart,
    warmRestart,
    phases: phases.map((phase) => ({
      id: phase.id,
      eventCount: phase.summary.eventCount,
      stageCount: phase.summary.stageCount,
      installCount: phase.summary.installCount,
      installMaxMs: phase.summary.installMaxMs,
      postbuildCount: phase.summary.postbuildCount,
      postbuildMaxMs: phase.summary.postbuildMaxMs,
      pluginIds: phase.summary.pluginIds
    }))
  };
}

function summarizeRuntimeDepsPhase(phase) {
  const texts = [];
  for (const result of phase?.results ?? []) {
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    if (/runtime dep|runtime dependency|runtime-deps|bundled runtime deps/i.test(output)) {
      texts.push(output);
    }
  }
  const summary = summarizeRuntimeDepsLogs(texts.join("\n"));
  if (summary.eventCount > 0 || !phase?.metrics?.logs?.runtimeDeps) {
    return summary;
  }
  return phase.metrics.logs.runtimeDeps;
}

function selectRuntimeDepsPhase(phases, ids) {
  return phases.find((phase) => ids.includes(phase.id))?.summary ?? null;
}

function compactRuntimeDepsPhase(summary) {
  if (!summary) {
    return {
      eventCount: null,
      installCount: null,
      installMaxMs: null,
      postbuildCount: null,
      postbuildMaxMs: null,
      pluginIds: []
    };
  }
  return {
    eventCount: summary.eventCount ?? 0,
    installCount: summary.installCount ?? 0,
    installMaxMs: summary.installMaxMs ?? null,
    postbuildCount: summary.postbuildCount ?? 0,
    postbuildMaxMs: summary.postbuildMaxMs ?? null,
    pluginIds: summary.pluginIds ?? []
  };
}

function compactRuntimeDepsWarmPhase(warm, cold) {
  if (!warm) {
    return compactRuntimeDepsPhase(null);
  }
  const warmInstallCount = incrementalCount(warm.installCount, cold?.installCount);
  return {
    eventCount: incrementalCount(warm.eventCount, cold?.eventCount),
    installCount: warmInstallCount,
    installMaxMs: warmInstallCount > 0 ? (warm.installMaxMs ?? null) : null,
    postbuildCount: incrementalCount(warm.postbuildCount, cold?.postbuildCount),
    postbuildMaxMs: incrementalCount(warm.postbuildCount, cold?.postbuildCount) > 0 ? (warm.postbuildMaxMs ?? null) : null,
    pluginIds: warmInstallCount > 0 ? (warm.pluginIds ?? []) : []
  };
}

function incrementalCount(current, previous) {
  if (typeof current !== "number") {
    return null;
  }
  if (typeof previous !== "number") {
    return current;
  }
  return current >= previous ? current - previous : current;
}

function allMetricObjects(record) {
  return [
    ...(record.phases ?? []).map((phase) => phase.metrics).filter(Boolean),
    record.finalMetrics,
    record.failureDiagnostics
  ].filter(Boolean);
}

function resolveResourceGate(resourceSummary, surface, { peakTrackedRssMb, cpuPercentMaxTracked }) {
  const configured = surface?.resourcePrimaryRole ?? null;
  if (typeof configured === "string" && configured.length > 0) {
    const resources = resourceSummary?.byRole?.[configured] ?? null;
    if (resources) {
      return roleResourceGate(configured, resources, "configured primary resource role");
    }
    return {
      kind: "role-missing",
      primaryRole: configured,
      role: configured,
      peakRssMb: null,
      cpuPercentMax: null,
      reason: `configured primary resource role '${configured}' was not observed in product resource samples`,
      attribution: {
        role: configured,
        observed: false,
        topRolesByRss: resourceSummary?.topRolesByRss?.slice(0, 4) ?? [],
        topRolesByCpu: resourceSummary?.topRolesByCpu?.slice(0, 4) ?? [],
        peakRssProcess: compactSampleProcess(resourceSummary?.peakRssSample?.topProcess),
        peakCpuProcess: compactSampleProcess(resourceSummary?.peakCpuSample?.topProcess)
      }
    };
  }
  const gateway = resourceSummary?.byRole?.gateway;
  if (typeof gateway?.peakRssMb === "number" || typeof gateway?.maxCpuPercent === "number") {
    return roleResourceGate("gateway", gateway, "default gateway resource role");
  }
  const topRole = firstObservedRole(resourceSummary?.topRolesByRss) ?? firstObservedRole(resourceSummary?.topRolesByCpu);
  if (topRole) {
    const resources = resourceSummary?.byRole?.[topRole] ?? null;
    if (resources) {
      return roleResourceGate(topRole, resources, "largest observed resource role");
    }
  }
  return {
    kind: "tracked-total",
    primaryRole: null,
    role: null,
    peakRssMb: peakTrackedRssMb,
    cpuPercentMax: cpuPercentMaxTracked,
    reason: "no product resource role was observed; using tracked aggregate",
    attribution: {
      role: null,
      observed: false,
      topRolesByRss: resourceSummary?.topRolesByRss?.slice(0, 4) ?? [],
      topRolesByCpu: resourceSummary?.topRolesByCpu?.slice(0, 4) ?? [],
      peakRssProcess: compactSampleProcess(resourceSummary?.peakRssSample?.topProcess),
      peakCpuProcess: compactSampleProcess(resourceSummary?.peakCpuSample?.topProcess)
    }
  };
}

function roleResourceGate(role, resources, reason) {
  return {
    kind: "role",
    primaryRole: role,
    role,
    peakRssMb: typeof resources?.peakRssMb === "number" ? resources.peakRssMb : null,
    cpuPercentMax: typeof resources?.maxCpuPercent === "number" ? resources.maxCpuPercent : null,
    reason,
    attribution: {
      role,
      observed: true,
      peakRssMb: resources?.peakRssMb ?? null,
      maxCpuPercent: resources?.maxCpuPercent ?? null,
      peakProcessCount: resources?.peakProcessCount ?? null,
      peakRssProcess: resources?.peakRssProcess ?? null,
      peakCpuProcess: resources?.peakCpuProcess ?? null
    }
  };
}

function firstObservedRole(roles) {
  return (roles ?? []).find((entry) => typeof entry?.role === "string" && entry.role.length > 0)?.role ?? null;
}

function hasActivePrimaryResourceThreshold(thresholds, roleThresholds, primaryResourceRole) {
  if (!primaryResourceRole) {
    return false;
  }
  if (typeof thresholds?.peakRssMb === "number" || typeof thresholds?.cpuPercentMax === "number") {
    return true;
  }
  const role = roleThresholds?.[primaryResourceRole] ?? null;
  return typeof role?.peakRssMb === "number" ||
    typeof role?.peakProcessRssMb === "number" ||
    typeof role?.maxCpuPercent === "number";
}

function resourceRssLabel(primaryResourceRole, resourceGateKind) {
  if (resourceGateKind === "role-missing") {
    return `${primaryResourceRole} RSS`;
  }
  if (resourceGateKind !== "role") {
    return "tracked total peak RSS";
  }
  if (primaryResourceRole === "gateway") {
    return "gateway peak RSS";
  }
  return `${primaryResourceRole} peak RSS`;
}

function resourceBreakdownSuffix(resourceSummary, resourceGate) {
  const topRoles = (resourceSummary?.topRolesByRss ?? [])
    .filter((entry) => entry?.role && typeof entry.peakRssMb === "number")
    .slice(0, 3)
    .map((entry) => `${entry.role} ${entry.peakRssMb} MB`);
  if (topRoles.length === 0) {
    return "";
  }
  if (resourceGate.kind === "role") {
    return `; observed role ${resourceGate.role}; top RSS roles: ${topRoles.join(", ")}`;
  }
  if (resourceGate.kind === "tracked-total") {
    return `; aggregate only; top RSS roles: ${topRoles.join(", ")}`;
  }
  return `; configured role not observed; top RSS roles: ${topRoles.join(", ")}`;
}

function countDiagnosticMetric(record, key) {
  let observed = false;
  let count = 0;
  for (const metrics of allMetricObjects(record)) {
    if (metrics?.diagnostics) {
      observed = true;
    }
    const value = metrics?.diagnostics?.[key];
    if (typeof value === "number") {
      count = Math.max(count, value);
    }
  }
  return observed ? count : null;
}

function extractAgentResponse(result) {
  if (result.status !== 0 || result.timedOut) {
    return { usable: false, text: null };
  }

  const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  try {
    const parsed = JSON.parse(result.stdout);
    const finalText = findFirstString(parsed, [
      "finalAssistantVisibleText",
      "finalAssistantRawText",
      "finalText",
      "text",
      "reply"
    ]);
    if (typeof finalText === "string" && finalText.trim().length > 0 && finalText.trim() !== "NO_REPLY") {
      return { usable: true, text: finalText.trim() };
    }
  } catch {
    // Fall through to tolerant text checks. Some OpenClaw builds still emit
    // diagnostics alongside JSON in integration environments.
  }

  const payloadText = findPayloadText(text);
  if (typeof payloadText === "string" && payloadText.trim().length > 0 && payloadText.trim() !== "NO_REPLY") {
    return { usable: true, text: payloadText.trim() };
  }

  const match = text.match(/"finalAssistant(?:Raw|Visible)Text"\s*:\s*"([^"]+)"/);
  const finalText = match?.[1] ?? null;
  return {
    usable: typeof finalText === "string" && finalText.trim().length > 0 && finalText.trim() !== "NO_REPLY",
    text: finalText?.trim() ?? null
  };
}

function responseMatchesExpectedText(response, expectedText) {
  return textEquals(response.text, expectedText);
}

function textEquals(actual, expected) {
  return typeof actual === "string" && typeof expected === "string" && actual.trim() === expected.trim();
}

function findFirstString(value, keys) {
  if (!value || typeof value !== "object") {
    return null;
  }
  for (const key of keys) {
    if (typeof value[key] === "string") {
      return value[key];
    }
  }
  for (const child of Object.values(value)) {
    const nested = findFirstString(child, keys);
    if (typeof nested === "string") {
      return nested;
    }
  }
  return null;
}

function findPayloadText(text) {
  const payloadIndex = text.indexOf('"payloads"');
  if (payloadIndex < 0) {
    return null;
  }
  const payloadText = text.slice(payloadIndex).match(/"text"\s*:\s*"((?:\\.|[^"\\])*)"/)?.[1];
  if (typeof payloadText !== "string") {
    return null;
  }
  try {
    return JSON.parse(`"${payloadText}"`);
  } catch {
    return payloadText;
  }
}

function countMissingDependencyErrors(results) {
  let count = 0;
  const pattern = /cannot find module|missing dependenc|missing runtime dep|failed to load/i;
  for (const result of results) {
    const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    for (const line of text.split("\n")) {
      if (pattern.test(line)) {
        count += 1;
      }
    }
  }
  return count;
}
