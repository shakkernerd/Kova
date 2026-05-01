import { buildAgentTurnBreakdown } from "./collectors/agent-turns.mjs";
import { computeProviderTurnAttribution } from "./collectors/provider.mjs";

export function evaluateRecord(record, scenario, options = {}) {
  const originalStatus = record.status;
  const thresholds = { ...(options.surface?.thresholds ?? {}), ...(scenario.thresholds ?? {}) };
  const roleThresholds = mergeRoleThresholds(options.surface?.roleThresholds, scenario.thresholds?.roleThresholds);
  const violations = [];
  const allResults = collectResults(record);
  const resourceSummary = collectResourceSummary(allResults);
  const peakRssMb = maxNullable(collectPeakRss(record), resourceSummary.peakTotalRssMb);
  const cpuPercentMax = maxNullable(collectCpuPercentMax(record), resourceSummary.maxTotalCpuPercent);
  const missingDependencyErrors = countMissingDependencyErrors(allResults) + countLogMetric(record, "missingDependencyErrors");
  const pluginLoadFailures = countLogMetric(record, "pluginLoadFailures");
  const metadataScanMentions = countLogMetric(record, "metadataScanMentions");
  const configNormalizationMentions = countLogMetric(record, "configNormalizationMentions");
  const gatewayRestartCount = countGatewayRestarts(record);
  const providerLoadMentions = countLogMetric(record, "providerLoadMentions");
  const modelCatalogMentions = countLogMetric(record, "modelCatalogMentions");
  const providerTimeoutMentions = countLogMetric(record, "providerTimeoutMentions");
  const eventLoopDelayMentions = countLogMetric(record, "eventLoopDelayMentions");
  const v8DiagnosticMentions = countLogMetric(record, "v8DiagnosticMentions");
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
  const openclawDiagnostics = collectOpenClawDiagnostics(record);
  const timelineSummary = collectTimelineSummary(record);
  const timelineRequirement = timelineRequirementFor(options);
  const requiredOpenSpans = requiredTimelineSpans(options);
  const openRequiredSpans = timelineSummary.openSpans.filter((span) => requiredOpenSpans.has(span.name));
  const runtimeDepsStagingMs = maxNullable(openclawDiagnostics.runtimeDepsStagingMs, timelineSummary.runtimeDepsStageMaxMs);
  const eventLoopDelayMs = maxNullable(openclawDiagnostics.eventLoopDelayMs, timelineSummary.eventLoopMaxMs);
  const providerModelTimingMs = maxNullable(openclawDiagnostics.providerModelTimingMs, timelineSummary.providerRequestMaxMs);
  const agentTurns = collectAgentTurns(record, record.providerEvidence, scenario, timelineSummary);
  const coldAgentTurn = selectAgentTurn(agentTurns, "cold") ?? agentTurns[0] ?? null;
  const warmAgentTurn = selectAgentTurn(agentTurns, "warm") ?? agentTurns[1] ?? null;
  const providerTurn = collectSlowestProviderTurn(agentTurns);
  const agentTurnStats = summarizeAgentTurnStats(agentTurns);
  const agentTurnMs = maxNullable(maxDurationWhere(allResults, isAgentMessageCommand), maxTurnDuration(agentTurns));
  const agentResponseOk = agentTurns.length === 0 ? null : agentTurns.every((turn) => turn.responseOk === true);
  const agentProviderSimulation = evaluateProviderSimulation({ turns: agentTurns, scenario, record, thresholds });
  const agentFailureContainment = evaluateAgentFailureContainment({ turns: agentTurns, record, thresholds });
  const agentLatencyDiagnosis = diagnoseAgentLatency({
    coldAgentTurn,
    warmAgentTurn,
    providerTurn,
    thresholds,
    timelineSummary,
    expectedProviderMode: scenario.mockProvider?.mode ?? "normal",
    providerSimulation: agentProviderSimulation
  });
  const finalGatewayState = record.finalMetrics?.service?.gatewayState ?? null;
  const healthFailures = countHealthFailures(record);
  const healthP95Ms = collectHealthP95(record);
  const listeningFailures = countListeningFailures(record);
  const tcpConnectMaxMs = collectTcpConnectMax(record);
  const timeToListeningMs = collectTimeToListening(record);
  const timeToHealthReadyMs = collectTimeToHealthReady(record);
  const readinessFailures = countReadinessFailures(record);
  const readinessClassification = collectWorstReadinessClassification(record);
  const coldReadyMs = maxDurationWhere(allResults, (command) => command.startsWith("ocm start "));
  const warmReadyMs = maxDurationWhere(allResults, (command) => command.startsWith("ocm service restart "));
  const upgradeMs = maxDurationWhere(allResults, (command) => command.startsWith("ocm upgrade "));
  const statusMs = maxDurationWhere(allResults, (command) => command.includes(" -- status"));
  const pluginsListMs = maxDurationWhere(allResults, (command) => command.includes(" -- plugins list"));
  const modelsListMs = maxDurationWhere(allResults, (command) => command.includes(" -- models list"));

  checkDuration(violations, allResults, "agentTurnMs", thresholds.agentTurnMs, isAgentMessageCommand);
  checkDuration(violations, allResults, "statusMs", thresholds.statusMs, (command) => command.includes(" -- status"));
  checkDuration(violations, allResults, "pluginsListMs", thresholds.pluginsListMs, (command) => command.includes(" -- plugins list"));
  checkDuration(violations, allResults, "pluginUpdateDryRunMs", thresholds.pluginUpdateDryRunMs, (command) =>
    command.includes(" -- plugins update") && command.includes("--dry-run")
  );
  checkDuration(violations, allResults, "modelsListMs", thresholds.modelsListMs, (command) => command.includes(" -- models list"));
  checkDuration(violations, allResults, "coldReadyMs", thresholds.coldReadyMs ?? thresholds.gatewayReadyMs, (command) =>
    command.startsWith("ocm start ")
  );
  checkDuration(violations, allResults, "warmReadyMs", thresholds.warmReadyMs ?? thresholds.restartReadyMs, (command) =>
    command.startsWith("ocm service restart ")
  );
  checkDuration(violations, allResults, "upgradeMs", thresholds.upgradeMs, (command) => command.startsWith("ocm upgrade "));

  if (typeof thresholds.peakRssMb === "number" && peakRssMb !== null && peakRssMb > thresholds.peakRssMb) {
    violations.push({
      kind: "threshold",
      metric: "peakRssMb",
      expected: `<= ${thresholds.peakRssMb}`,
      actual: peakRssMb,
      message: `peak RSS ${peakRssMb} MB exceeded threshold ${thresholds.peakRssMb} MB`
    });
  }

  if (typeof thresholds.cpuPercentMax === "number" && cpuPercentMax !== null && cpuPercentMax > thresholds.cpuPercentMax) {
    violations.push({
      kind: "threshold",
      metric: "cpuPercentMax",
      expected: `<= ${thresholds.cpuPercentMax}`,
      actual: cpuPercentMax,
      message: `max CPU ${cpuPercentMax}% exceeded threshold ${thresholds.cpuPercentMax}%`
    });
  }
  checkRoleThresholds(violations, resourceSummary.byRole, roleThresholds);

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

  if (finalGatewayState && finalGatewayState !== "running") {
    violations.push({
      kind: "gateway",
      metric: "finalGatewayState",
      expected: "running",
      actual: finalGatewayState,
      message: `final gateway state was ${finalGatewayState}`
    });
  }

  if (typeof thresholds.healthFailures === "number" && healthFailures > thresholds.healthFailures) {
    violations.push({
      kind: "health",
      metric: "healthFailures",
      expected: `<= ${thresholds.healthFailures}`,
      actual: healthFailures,
      message: `${healthFailures} gateway health checks failed, over threshold ${thresholds.healthFailures}`
    });
  }

  if (typeof thresholds.healthP95Ms === "number" && healthP95Ms !== null && healthP95Ms > thresholds.healthP95Ms) {
    violations.push({
      kind: "health",
      metric: "healthP95Ms",
      expected: `<= ${thresholds.healthP95Ms}`,
      actual: healthP95Ms,
      message: `gateway health p95 ${healthP95Ms}ms exceeded threshold ${thresholds.healthP95Ms}ms`
    });
  }

  if (readinessClassification?.state === "hard-failure") {
    violations.push({
      kind: "gateway",
      metric: "readinessClassification",
      expected: "ready",
      actual: readinessClassification.state,
      message: `gateway hard failure: ${readinessClassification.reason}`
    });
  }

  if (readinessClassification?.state === "unhealthy") {
    violations.push({
      kind: "gateway",
      metric: "readinessClassification",
      expected: "ready",
      actual: readinessClassification.state,
      message: `gateway unhealthy: ${readinessClassification.reason}`
    });
  }

  if (readinessClassification?.state === "slow-startup") {
    violations.push({
      kind: "gateway",
      metric: "readinessClassification",
      expected: "ready within threshold",
      actual: readinessClassification.state,
      message: `gateway slow startup: ${readinessClassification.reason}`
    });
  }

  const gatewayReadyThreshold = thresholds.gatewayReadyMs ?? thresholds.coldReadyMs;
  if (
    readinessClassification?.state !== "slow-startup" &&
    typeof gatewayReadyThreshold === "number" &&
    timeToHealthReadyMs !== null &&
    timeToHealthReadyMs > gatewayReadyThreshold
  ) {
    violations.push({
      kind: "gateway",
      metric: "timeToHealthReadyMs",
      expected: `<= ${gatewayReadyThreshold}`,
      actual: timeToHealthReadyMs,
      message: `gateway health ready took ${timeToHealthReadyMs}ms, over threshold ${gatewayReadyThreshold}ms`
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
    coldReadyMs,
    warmReadyMs,
    upgradeMs,
    statusMs,
    pluginsListMs,
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
    agentProviderSimulation,
    agentFailureContainment,
    agentProcessLeakCount: agentFailureContainment.processLeakCount,
    agentLeakedProcesses: agentFailureContainment.leakedProcesses,
    agentFailureFixerSummary: buildAgentFailureFixerSummary(agentLatencyDiagnosis, agentProviderSimulation, agentFailureContainment),
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
    tcpConnectMaxMs,
    timeToListeningMs,
    timeToHealthReadyMs,
    readinessClassification: readinessClassification?.state ?? null,
    readinessClassificationReason: readinessClassification?.reason ?? null,
    readinessThresholdMs: readinessClassification?.thresholdMs ?? null,
    readinessHardDeadlineMs: readinessClassification?.deadlineMs ?? null,
    missingDependencyErrors,
    finalGatewayState,
    healthFailures,
    healthP95Ms,
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
    resourceTopByRss: resourceSummary.topByRss,
    resourceTopByCpu: resourceSummary.topByCpu,
    openclawTimelineAvailable: timelineSummary.available,
    openclawTimelineEventCount: timelineSummary.eventCount,
    openclawTimelineParseErrors: timelineSummary.parseErrorCount,
    openclawSlowestSpanName: timelineSummary.slowestSpanName,
    openclawSlowestSpanMs: timelineSummary.slowestSpanMs,
    openclawRepeatedSpanCount: timelineSummary.repeatedSpanCount,
    openclawOpenSpanCount: timelineSummary.openSpanCount,
    openclawOpenRequiredSpanCount: openRequiredSpans.length,
    openclawOpenSpans: timelineSummary.openSpans,
    openclawKeySpans: timelineSummary.keySpans,
    openclawEventLoopMaxMs: timelineSummary.eventLoopMaxMs,
    openclawProviderRequestMaxMs: timelineSummary.providerRequestMaxMs,
    openclawChildProcessFailedCount: timelineSummary.childProcessFailedCount,
    runtimeDepsStagingPluginId: timelineSummary.runtimeDepsStagePluginId,
    pluginMetadataScanCount: openclawDiagnostics.pluginMetadataScanCount,
    configNormalizationCount: openclawDiagnostics.configNormalizationCount,
    runtimeDepsStagingMs,
    eventLoopDelayMs,
    providerModelTimingMs,
    diagnosticCorrelation: buildDiagnosticCorrelation({
      resourceSummary,
      timelineSummary,
      nodeProfileTopFunction,
      nodeHeapTopFunction,
      eventLoopDelayMs,
      runtimeDepsStagingMs,
      providerModelTimingMs
    })
  };

  if (violations.length > 0) {
    if (originalStatus === "PASS") {
      record.status = "FAIL";
    }
    record.violations = violations;
  } else {
    delete record.violations;
  }

  return record;
}

function collectAgentTurns(record, providerEvidence, scenario, timelineSummary) {
  const turns = [];
  let index = 0;
  const expectedText = scenario.agent?.expectedText ?? null;
  for (const phase of record.phases ?? []) {
    for (const result of phase.results ?? []) {
      if (!isAgentMessageCommand(result.command)) {
        continue;
      }
      index += 1;
      const expectedFailure = phase.expectedAgentFailure === true || scenario.agent?.expectedFailure === true;
      const attribution = computeProviderTurnAttribution(result, providerEvidence);
      const response = extractAgentResponse(result);
      const expectedTextPresent = typeof expectedText === "string" && expectedText.length > 0
        ? responseContainsExpectedText(response, result, expectedText)
        : null;
      const expectedFailureObserved = expectedFailure === true && result.status === 0 && result.timedOut !== true;
      const normalResponseOk = result.status === 0 && result.timedOut !== true && response.usable === true && (expectedTextPresent !== false);
      const phaseBreakdown = buildAgentTurnBreakdown({ result, attribution, timelineSummary });
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
        totalTurnMs: result.durationMs ?? attribution?.totalTurnMs ?? null,
        commandStartedAt: result.startedAt ?? null,
        commandStartedAtEpochMs: result.startedAtEpochMs ?? null,
        commandFinishedAt: result.finishedAt ?? null,
        commandFinishedAtEpochMs: result.finishedAtEpochMs ?? null,
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
        phaseBreakdown,
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

function evaluateAgentFailureContainment({ turns, record, thresholds }) {
  if (turns.length === 0) {
    return {
      schemaVersion: "kova.agentFailureContainment.v1",
      processLeakCount: 0,
      leakLimit: 0,
      leakedProcesses: [],
      processLeaksOk: true,
      finalGatewayState: record.finalMetrics?.service?.gatewayState ?? null,
      gatewayHealthy: null,
      healthFailures: countHealthFailures(record),
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
  const healthFailures = countHealthFailures(record);
  const finalGatewayState = record.finalMetrics?.service?.gatewayState ?? null;
  const statusCommands = collectResults(record).filter((result) => /\s--\sstatus\b|@\S+\s+--\s+status\b/.test(result.command) || result.command.includes(" -- status"));
  const statusWorks = statusCommands.length === 0 ? null : statusCommands.some((result) => result.status === 0 && result.timedOut !== true);

  return {
    schemaVersion: "kova.agentFailureContainment.v1",
    processLeakCount: leakCount,
    leakLimit,
    leakedProcesses,
    processLeaksOk: leakCount <= leakLimit,
    finalGatewayState,
    gatewayHealthy: finalGatewayState === "running" && healthFailures <= healthLimit,
    healthFailures,
    healthLimit,
    statusWorks,
    dashboardResponsive: null,
    tuiResponsive: null
  };
}

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
      expected: `gateway running and health failures <= ${containment.healthLimit}`,
      actual: `gateway=${containment.finalGatewayState ?? "unknown"} healthFailures=${containment.healthFailures}`,
      message: `gateway was not healthy after agent command; gateway=${containment.finalGatewayState ?? "unknown"}, health failures=${containment.healthFailures}`
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
    firstByteLatencyMs: summarizeNumericField(turns, "firstByteLatencyMs"),
    processLeakCount: turns.reduce((sum, turn) => sum + (turn.processLeakCount ?? 0), 0),
    missingProviderRequestCount: turns.filter((turn) => turn.missingProviderRequest === true).length,
    responseOkCount: turns.filter((turn) => turn.responseOk === true).length
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
    if (typeof expectedText === "string" && expectedText.length > 0 && turn.expectedTextPresent !== true) {
      violations.push({
        kind: "agent",
        metric: "agentTurn.expectedTextPresent",
        phaseId: turn.phaseId,
        expected: expectedText,
        actual: turn.responseText ?? "none",
        message: `${turn.label} agent turn response did not include expected marker ${expectedText}`
      });
    }
  }
}

function evaluateProviderSimulation({ turns, scenario, record, thresholds }) {
  const mode = scenario.mockProvider?.mode ?? "normal";
  const expected = mode !== "normal";
  const issue = classifyProviderIssue(turns);
  const expectedFailureTurns = turns.filter((turn) => turn.expectedFailure === true);
  const normalTurns = turns.filter((turn) => turn.expectedFailure !== true);
  const healthLimit = typeof thresholds.providerFailureHealthFailures === "number" ? thresholds.providerFailureHealthFailures : 0;
  const healthFailures = countHealthFailures(record);
  const finalGatewayState = record.finalMetrics?.service?.gatewayState ?? null;
  const containmentOk = !expected || (
    finalGatewayState === "running" &&
    healthFailures <= healthLimit
  );
  const recoveryOk = mode === "error-then-recover"
    ? turns.some((turn) => hasProviderFailureEvidence(turn)) &&
      turns.some((turn) => turn.responseOk === true && hasSuccessfulProviderRequest(turn))
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
    finalGatewayState,
    healthFailures,
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
  if (simulation.mode === "error-then-recover" && simulation.recoveryOk !== true) {
    violations.push({
      kind: "provider-simulation",
      metric: "providerRecoveryOk",
      expected: "first request fails and later request succeeds",
      actual: simulation.recoveryOk,
      message: "mock provider error-then-recover mode did not prove agent recovery"
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
      expected: `gateway running and health failures <= ${simulation.healthLimit}`,
      actual: `gateway=${simulation.finalGatewayState ?? "unknown"} healthFailures=${simulation.healthFailures}`,
      message: `provider ${simulation.mode} failure was not contained; gateway=${simulation.finalGatewayState ?? "unknown"}, health failures=${simulation.healthFailures}`
    });
  }
}

function buildAgentFailureFixerSummary(latencyDiagnosis, providerSimulation, containment) {
  const items = [];
  if (providerSimulation?.mode === "timeout" || providerSimulation?.observedIssue === "provider-timeout") {
    items.push({
      kind: "provider-timeout",
      summary: "Provider timed out; verify OpenClaw surfaces the timeout clearly, cancels the turn, and leaves the gateway responsive.",
      likelyOwner: "provider / agent timeout handling"
    });
  }
  if (providerSimulation?.mode === "streaming-stall" || providerSimulation?.observedIssue === "streaming-stall") {
    items.push({
      kind: "streaming-stall",
      summary: "Provider stream stalled; verify OpenClaw applies stream idle timeouts and does not freeze gateway/TUI/dashboard.",
      likelyOwner: "provider streaming / agent turn cancellation"
    });
  }
  if (providerSimulation?.mode === "malformed" || providerSimulation?.observedIssue === "malformed-response") {
    items.push({
      kind: "malformed-response",
      summary: "Provider returned malformed output; verify OpenClaw reports a clear provider parse error and keeps the session usable.",
      likelyOwner: "provider response parsing"
    });
  }
  if (providerSimulation?.recoveryOk === true) {
    items.push({
      kind: "provider-recovered",
      summary: "Provider failed and later recovered; verify retry/recovery behavior is intentional and latency remains acceptable.",
      likelyOwner: "provider retry / agent recovery"
    });
  }
  if (providerSimulation?.mode === "concurrent-pressure") {
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
      summary: `Gateway was not healthy after agent command; gateway=${containment.finalGatewayState ?? "unknown"}, health failures=${containment.healthFailures}.`,
      likelyOwner: "gateway supervision / agent failure containment"
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
    checkTurnThreshold(violations, turn, "preProviderMs", thresholds.preProviderMs, `${turn.label} agent spent ${turn.preProviderMs}ms before provider work`);
    checkTurnThreshold(violations, turn, "providerFinalMs", thresholds.providerFinalMs, `${turn.label} provider work took ${turn.providerFinalMs}ms`);
    if (typeof thresholds.preProviderDominanceRatio === "number" &&
      typeof turn.preProviderDominance === "number" &&
      turn.preProviderDominance > thresholds.preProviderDominanceRatio) {
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
}

function checkAggregateThreshold(violations, actual, metric, threshold) {
  if (typeof threshold !== "number" || typeof actual !== "number" || actual <= threshold) {
    return;
  }
  violations.push({
    kind: "agent-latency",
    metric,
    expected: `<= ${threshold}`,
    actual,
    message: `${metric} ${actual}ms exceeded threshold ${threshold}ms`
  });
}

function checkTurnThreshold(violations, turn, metric, threshold, message) {
  if (!turn || typeof threshold !== "number" || typeof turn[metric] !== "number" || turn[metric] <= threshold) {
    return;
  }
  violations.push({
    kind: "agent-latency",
    metric,
    phaseId: turn.phaseId,
    expected: `<= ${threshold}`,
    actual: turn[metric],
    message: `${message}, over threshold ${threshold}ms`
  });
}

function diagnoseAgentLatency({ coldAgentTurn, warmAgentTurn, providerTurn, thresholds, timelineSummary, expectedProviderMode = "normal", providerSimulation = null }) {
  if (!providerTurn) {
    return null;
  }
  if (providerTurn.missingProviderRequest === true) {
    return {
      kind: "no-provider-request",
      severity: "fail",
      summary: "No provider request happened during the agent turn.",
      likelyOwner: "agent-runtime/auth/provider-routing"
    };
  }

  const providerIssue = classifyProviderIssue([providerTurn]);
  if (providerIssue.kind !== "none") {
    return {
      kind: providerIssue.kind,
      severity: expectedProviderMode === "normal" ? "fail" : "info",
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

function hasProviderFailureEvidence(turn) {
  return (turn.providerErrors ?? []).some((error) =>
    ["provider-error", "provider-timeout", "streaming-stall", "malformed-response", "provider-aborted"].includes(error.kind) ||
    (error.kind === "http" && typeof error.status === "number" && error.status >= 400)
  );
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

function maxDurationWhere(results, predicate) {
  const durations = results
    .filter((result) => predicate(result.command))
    .map((result) => result.durationMs)
    .filter((duration) => typeof duration === "number");
  return durations.length === 0 ? null : Math.max(...durations);
}

function countHealthFailures(record) {
  let count = 0;
  for (const phase of record.phases ?? []) {
    count += phase.metrics?.healthSummary?.failureCount ?? healthFailureCount([phase.metrics?.health]);
  }

  count += record.finalMetrics?.healthSummary?.failureCount ?? healthFailureCount([record.finalMetrics?.health]);
  return count;
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

function collectWorstReadinessClassification(record) {
  const values = [];
  for (const phase of record.phases ?? []) {
    const readiness = phase.metrics?.readiness;
    if (readiness?.classification && readiness.deadlineMs > 0) {
      values.push(readinessClassificationValue(readiness, phase.id));
    }
  }
  const finalReadiness = record.finalMetrics?.readiness;
  if (finalReadiness?.classification && finalReadiness.deadlineMs > 0) {
    values.push(readinessClassificationValue(finalReadiness, "final"));
  }
  if (values.length === 0) {
    return null;
  }
  values.sort((left, right) => readinessRank(right.state) - readinessRank(left.state));
  return values[0];
}

function readinessClassificationValue(readiness, phaseId) {
  return {
    phaseId,
    state: readiness.classification.state,
    severity: readiness.classification.severity,
    reason: readiness.classification.reason,
    thresholdMs: readiness.thresholdMs,
    deadlineMs: readiness.deadlineMs,
    listeningReadyAtMs: readiness.listeningReadyAtMs,
    healthReadyAtMs: readiness.healthReadyAtMs
  };
}

function readinessRank(state) {
  if (state === "hard-failure") {
    return 4;
  }
  if (state === "unhealthy") {
    return 3;
  }
  if (state === "slow-startup") {
    return 2;
  }
  if (state === "ready") {
    return 1;
  }
  return 0;
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

function collectTimeToListening(record) {
  const values = [];
  for (const phase of record.phases ?? []) {
    const value = phase.metrics?.readiness?.listeningReadyAtMs;
    if (typeof value === "number") {
      values.push(value);
    }
  }
  const finalValue = record.finalMetrics?.readiness?.listeningReadyAtMs;
  if (typeof finalValue === "number") {
    values.push(finalValue);
  }
  return values.length === 0 ? null : Math.max(...values);
}

function collectTimeToHealthReady(record) {
  const values = [];
  for (const phase of record.phases ?? []) {
    const value = phase.metrics?.readiness?.healthReadyAtMs;
    if (typeof value === "number") {
      values.push(value);
    }
  }
  const finalValue = record.finalMetrics?.readiness?.healthReadyAtMs;
  if (typeof finalValue === "number") {
    values.push(finalValue);
  }
  return values.length === 0 ? null : Math.max(...values);
}

function countGatewayRestarts(record) {
  const results = collectResults(record);
  const commandRestarts = results.filter((result) => result.command.startsWith("ocm service restart ")).length;
  return commandRestarts + countLogMetric(record, "gatewayRestartMentions");
}

function collectHealthP95(record) {
  const p95Values = [];
  for (const phase of record.phases ?? []) {
    const p95 = phase.metrics?.healthSummary?.p95Ms;
    if (typeof p95 === "number") {
      p95Values.push(p95);
    }
  }

  const finalP95 = record.finalMetrics?.healthSummary?.p95Ms;
  if (typeof finalP95 === "number") {
    p95Values.push(finalP95);
  }

  if (p95Values.length === 0) {
    return null;
  }
  return Math.max(...p95Values);
}

function healthFailureCount(samples) {
  return samples.filter((sample) => sample && !sample.ok).length;
}

function checkDuration(violations, results, metric, threshold, predicate) {
  if (typeof threshold !== "number") {
    return;
  }

  for (const result of results) {
    if (!predicate(result.command)) {
      continue;
    }
    if (result.durationMs > threshold) {
      violations.push({
        kind: "threshold",
        metric,
        command: result.command,
        expected: `<= ${threshold}`,
        actual: result.durationMs,
        message: `${result.command} took ${result.durationMs}ms, over threshold ${threshold}ms`
      });
    }
  }
}

function checkRoleThresholds(violations, byRole, roleThresholds) {
  for (const [role, thresholds] of Object.entries(roleThresholds)) {
    const summary = byRole?.[role];
    if (!summary) {
      continue;
    }
    if (typeof thresholds.peakRssMb === "number" && typeof summary.peakRssMb === "number" &&
      summary.peakRssMb > thresholds.peakRssMb) {
      violations.push({
        kind: "resource",
        metric: `resourceByRole.${role}.peakRssMb`,
        role,
        expected: `<= ${thresholds.peakRssMb}`,
        actual: summary.peakRssMb,
        message: `${role} peak RSS ${summary.peakRssMb} MB exceeded threshold ${thresholds.peakRssMb} MB`
      });
    }
    if (typeof thresholds.maxCpuPercent === "number" && typeof summary.maxCpuPercent === "number" &&
      summary.maxCpuPercent > thresholds.maxCpuPercent) {
      violations.push({
        kind: "resource",
        metric: `resourceByRole.${role}.maxCpuPercent`,
        role,
        expected: `<= ${thresholds.maxCpuPercent}`,
        actual: summary.maxCpuPercent,
        message: `${role} max CPU ${summary.maxCpuPercent}% exceeded threshold ${thresholds.maxCpuPercent}%`
      });
    }
  }
}

function mergeRoleThresholds(base, override) {
  const merged = {};
  for (const [sourceRole, sourceThresholds] of Object.entries(base ?? {})) {
    merged[sourceRole] = { ...sourceThresholds };
  }
  for (const [sourceRole, sourceThresholds] of Object.entries(override ?? {})) {
    merged[sourceRole] = { ...(merged[sourceRole] ?? {}), ...sourceThresholds };
  }
  return merged;
}

function collectResults(record) {
  const results = [];
  for (const phase of record.phases ?? []) {
    for (const result of phase.results ?? []) {
      results.push(result);
    }
  }
  return results;
}

function collectPeakRss(record) {
  let peak = null;
  for (const phase of record.phases ?? []) {
    const rss = phase.metrics?.process?.rssMb;
    if (typeof rss === "number") {
      peak = peak === null ? rss : Math.max(peak, rss);
    }
  }

  const finalRss = record.finalMetrics?.process?.rssMb;
  if (typeof finalRss === "number") {
    peak = peak === null ? finalRss : Math.max(peak, finalRss);
  }

  return peak;
}

function collectResourceSummary(results) {
  let sampleCount = 0;
  let peakTotalRssMb = null;
  let maxTotalCpuPercent = null;
  let peakCommandTreeRssMb = null;
  let peakGatewayRssMb = null;
  let peakRssSample = null;
  let peakCpuSample = null;
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
    peakCommandTreeRssMb = maxNullable(peakCommandTreeRssMb, samples.peakCommandTreeRssMb);
    peakGatewayRssMb = maxNullable(peakGatewayRssMb, samples.peakGatewayRssMb);
    mergeRoleSummaries(byRole, samples.byRole ?? {});
    peakRssSample = maxSample(peakRssSample, samples.peakRssSample, "totalRssMb");
    peakCpuSample = maxSample(peakCpuSample, samples.peakCpuSample, "totalCpuPercent");
    if (samples.artifactPath) {
      artifacts.push(samples.artifactPath);
    }
    for (const process of [...(samples.topByRss ?? []), ...(samples.topByCpu ?? [])]) {
      const existing = byPid.get(process.pid) ?? {
        pid: process.pid,
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
      byPid.set(process.pid, existing);
    }
  }

  const processes = [...byPid.values()];
  const roleSummaries = Object.fromEntries([...byRole.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right)));
  const roleList = Object.entries(roleSummaries).map(([role, summary]) => ({ role, ...summary }));
  return {
    sampleCount,
    peakTotalRssMb,
    maxTotalCpuPercent,
    peakCommandTreeRssMb,
    peakGatewayRssMb,
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
    target.set(role, existing);
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

function collectTimelineSummary(record) {
  const timelines = [];
  for (const phase of record.phases ?? []) {
    if (phase.metrics?.timeline) {
      timelines.push(phase.metrics.timeline);
    }
  }
  if (record.finalMetrics?.timeline) {
    timelines.push(record.finalMetrics.timeline);
  }

  const available = timelines.some((timeline) => timeline.available);
  let eventCount = 0;
  let parseErrorCount = 0;
  let slowestSpan = null;
  let eventLoopMaxMs = null;
  let providerRequestMaxMs = null;
  let childProcessFailedCount = 0;
  let repeatedSpanCount = 0;
  let runtimeDepsStageMaxMs = null;
  let slowestRuntimeDepsPlugin = null;
  let openSpanCount = 0;
  let openSpans = [];
  const keySpans = {};
  const spanTotals = {};

  for (const timeline of timelines) {
    eventCount = Math.max(eventCount, timeline.eventCount ?? 0);
    parseErrorCount = Math.max(parseErrorCount, timeline.parseErrorCount ?? 0);
    childProcessFailedCount = Math.max(childProcessFailedCount, timeline.childProcesses?.failedCount ?? 0);
    repeatedSpanCount = Math.max(repeatedSpanCount, timeline.repeatedSpans?.length ?? 0);
    openSpanCount = Math.max(openSpanCount, timeline.openSpanCount ?? timeline.openSpans?.length ?? 0);
    openSpans = mergeOpenSpans(openSpans, timeline.openSpans ?? []);
    mergeKeySpans(keySpans, timeline.keySpans ?? {});
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

  return {
    available,
    eventCount,
    parseErrorCount,
    slowestSpanName: slowestSpan?.name ?? null,
    slowestSpanMs: slowestSpan?.durationMs ?? null,
    repeatedSpanCount,
    openSpanCount,
    openSpans,
    keySpans,
    spanTotals,
    eventLoopMaxMs,
    providerRequestMaxMs,
    childProcessFailedCount,
    runtimeDepsStageMaxMs,
    runtimeDepsStagePluginId: slowestRuntimeDepsPlugin?.pluginId ?? null
  };
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
    existing.count += summary.count ?? 0;
    existing.errorCount += summary.errorCount ?? 0;
    existing.openCount += summary.openCount ?? 0;
    existing.totalDurationMs = roundNumber(existing.totalDurationMs + (summary.totalDurationMs ?? 0));
    existing.maxDurationMs = maxNullable(existing.maxDurationMs, summary.maxDurationMs);
    if (summary.slowest?.durationMs !== undefined &&
      (!existing.slowest || summary.slowest.durationMs > existing.slowest.durationMs)) {
      existing.slowest = summary.slowest;
    }
    target[name] = existing;
  }
}

function mergeOpenSpans(current, candidate) {
  return [...current, ...candidate]
    .toSorted((left, right) => (right.ageMs ?? -1) - (left.ageMs ?? -1))
    .slice(0, 25);
}

function mergeKeySpans(target, source) {
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
    existing.count += summary.count ?? 0;
    existing.errorCount += summary.errorCount ?? 0;
    existing.openCount += summary.openCount ?? 0;
    existing.totalDurationMs = roundNumber(existing.totalDurationMs + (summary.totalDurationMs ?? 0));
    existing.maxDurationMs = maxNullable(existing.maxDurationMs, summary.maxDurationMs);
    if (summary.slowest?.durationMs !== undefined &&
      (!existing.slowest || summary.slowest.durationMs > existing.slowest.durationMs)) {
      existing.slowest = summary.slowest;
    }
    existing.open = mergeOpenSpans(existing.open, summary.open ?? []).slice(0, 5);
    target[name] = existing;
  }
}

function collectCpuPercentMax(record) {
  const values = [];
  for (const phase of record.phases ?? []) {
    const cpu = phase.metrics?.process?.cpuPercent;
    if (typeof cpu === "number") {
      values.push(cpu);
    }
  }

  const finalCpu = record.finalMetrics?.process?.cpuPercent;
  if (typeof finalCpu === "number") {
    values.push(finalCpu);
  }

  return values.length === 0 ? null : Math.max(...values);
}

function maxNullable(left, right) {
  if (typeof right !== "number") {
    return left;
  }
  return left === null ? right : Math.max(left, right);
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

function countLogMetric(record, key) {
  let count = 0;
  for (const phase of record.phases ?? []) {
    const value = phase.metrics?.logs?.[key];
    if (typeof value === "number") {
      count = Math.max(count, value);
    }
  }

  const finalValue = record.finalMetrics?.logs?.[key];
  if (typeof finalValue === "number") {
    count = Math.max(count, finalValue);
  }
  return count;
}

function countHeapSnapshotBytes(record) {
  let count = 0;
  for (const metrics of allMetricObjects(record)) {
    const value = metrics?.heapSnapshot?.artifactBytes;
    if (typeof value === "number") {
      count = Math.max(count, value);
    }
  }
  return count;
}

function countNodeProfileMetric(record, key) {
  let count = 0;
  for (const phase of record.phases ?? []) {
    const value = phase.metrics?.nodeProfiles?.[key];
    if (typeof value === "number") {
      count = Math.max(count, value);
    }
  }

  const finalValue = record.finalMetrics?.nodeProfiles?.[key];
  if (typeof finalValue === "number") {
    count = Math.max(count, finalValue);
  }
  return count;
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
  let count = 0;
  for (const metrics of allMetricObjects(record)) {
    const value = metrics?.diagnosticReport?.[key];
    if (typeof value === "number") {
      count = Math.max(count, value);
    }
  }
  return count;
}

function buildDiagnosticCorrelation({
  resourceSummary,
  timelineSummary,
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

function allMetricObjects(record) {
  return [
    ...(record.phases ?? []).map((phase) => phase.metrics).filter(Boolean),
    record.finalMetrics,
    record.failureDiagnostics
  ].filter(Boolean);
}

function countDiagnosticMetric(record, key) {
  let count = 0;
  for (const metrics of allMetricObjects(record)) {
    const value = metrics?.diagnostics?.[key];
    if (typeof value === "number") {
      count = Math.max(count, value);
    }
  }
  return count;
}

function isAgentMessageCommand(command) {
  return (command.includes(" -- agent ") && command.includes("--message")) ||
    command.includes("run-concurrent-agent-turns.mjs");
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

  const match = text.match(/"finalAssistant(?:Raw|Visible)Text"\s*:\s*"([^"]+)"/);
  const finalText = match?.[1] ?? null;
  return {
    usable: typeof finalText === "string" && finalText.trim().length > 0 && finalText.trim() !== "NO_REPLY",
    text: finalText?.trim() ?? null
  };
}

function responseContainsExpectedText(response, result, expectedText) {
  if (response.text?.includes(expectedText)) {
    return true;
  }
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`.includes(expectedText);
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
