const defaultThresholds = {
  missingDependencyErrors: 0,
  pluginLoadFailures: 0,
  healthFailures: 0,
  peakRssMb: 100,
  cpuPercentMax: 25,
  coldReadyMs: 5000,
  warmReadyMs: 3000,
  upgradeMs: 10000,
  statusMs: 1000,
  pluginsListMs: 1000,
  modelsListMs: 3000,
  agentTurnMs: 10000,
  tcpConnectMaxMs: 250,
  timeToListeningMs: 3000,
  timeToHealthReadyMs: 5000,
  readinessFailures: 0,
  healthP95Ms: 1000,
  gatewayRestartCount: 0,
  providerTimeoutMentions: 0,
  eventLoopDelayMentions: 0,
  metadataScanMentions: 10,
  configNormalizationMentions: 10,
  pluginMetadataScanCount: 10,
  configNormalizationCount: 10,
  runtimeDepsStagingMs: 5000,
  eventLoopDelayMs: 250,
  providerModelTimingMs: 5000,
  diagnosticArtifactBytes: 25 * 1024 * 1024,
  heapSnapshotBytes: 50 * 1024 * 1024,
  resourcePeakCommandTreeRssMb: 100,
  resourcePeakGatewayRssMb: 100,
  openclawTimelineParseErrors: 0,
  openclawSlowestSpanMs: 5000,
  openclawEventLoopMaxMs: 250,
  openclawProviderRequestMaxMs: 5000,
  openclawChildProcessFailedCount: 0,
  nodeProfileArtifactBytes: 100 * 1024 * 1024,
  nodeProfileTopFunctionMs: 5000
};

export function compareReports(baseline, current, options = {}) {
  const thresholds = resolveThresholds(options.thresholds);
  const baselineRecords = indexRecords(baseline.records ?? []);
  const currentRecords = current.records ?? [];
  const scenarios = [];

  for (const currentRecord of currentRecords) {
    const key = recordKey(currentRecord);
    const baselineRecord = baselineRecords.get(key);
    if (!baselineRecord) {
      scenarios.push({
        key,
        scenario: currentRecord.scenario,
        state: currentRecord.state?.id ?? null,
        status: "NEW",
        currentStatus: currentRecord.status,
        baselineStatus: null,
        regressions: [],
        metrics: metricDeltas(null, currentRecord.measurements ?? {})
      });
      continue;
    }

    const regressions = [];
    if (statusRank(currentRecord.status) > statusRank(baselineRecord.status)) {
      regressions.push({
        kind: "status",
        metric: "status",
        baseline: baselineRecord.status,
        current: currentRecord.status,
        message: `status regressed from ${baselineRecord.status} to ${currentRecord.status}`
      });
    }

    regressions.push(...metricRegressions(baselineRecord.measurements ?? {}, currentRecord.measurements ?? {}, thresholds));

    scenarios.push({
      key,
      scenario: currentRecord.scenario,
      state: currentRecord.state?.id ?? null,
      status: regressions.length > 0 ? "REGRESSED" : "OK",
      currentStatus: currentRecord.status,
      baselineStatus: baselineRecord.status,
      regressions,
      metrics: metricDeltas(baselineRecord.measurements ?? {}, currentRecord.measurements ?? {})
    });
  }

  for (const [key, baselineRecord] of baselineRecords.entries()) {
    if (currentRecords.some((record) => recordKey(record) === key)) {
      continue;
    }
    scenarios.push({
      key,
      scenario: baselineRecord.scenario,
      state: baselineRecord.state?.id ?? null,
      status: "MISSING",
      currentStatus: null,
      baselineStatus: baselineRecord.status,
      regressions: [{
        kind: "coverage",
        metric: "scenario",
        baseline: "present",
        current: "missing",
        message: "scenario/state entry missing from current report"
      }],
      metrics: {}
    });
  }

  const regressionCount = scenarios.reduce((count, scenario) => count + scenario.regressions.length, 0);
  return {
    schemaVersion: "kova.compare.v1",
    generatedAt: new Date().toISOString(),
    baseline: reportSummary(baseline),
    current: reportSummary(current),
    thresholds,
    ok: regressionCount === 0,
    regressionCount,
    scenarios
  };
}

export function renderCompareFixerSummary(comparison) {
  const lines = [
    "Kova OpenClaw Regression Summary",
    "",
    `Baseline: ${comparison.baseline.runId ?? "unknown"} (${comparison.baseline.target ?? "unknown"})`,
    `Current: ${comparison.current.runId ?? "unknown"} (${comparison.current.target ?? "unknown"})`,
    `Result: ${comparison.ok ? "OK" : "REGRESSED"}`,
    ""
  ];

  if (comparison.ok) {
    lines.push("No blocking regressions were detected.");
    return lines.join("\n");
  }

  for (const scenario of comparison.scenarios.filter((item) => item.regressions.length > 0)) {
    lines.push(`Scenario: ${scenario.key}`);
    lines.push(`Status: ${scenario.baselineStatus ?? "missing"} -> ${scenario.currentStatus ?? "missing"}`);
    lines.push("Fixer notes:");
    for (const regression of scenario.regressions) {
      lines.push(`- ${regression.message}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

export function renderCompareSummary(comparison) {
  const lines = [
    `Baseline: ${comparison.baseline.runId ?? "unknown"} (${comparison.baseline.target ?? "unknown"})`,
    `Current: ${comparison.current.runId ?? "unknown"} (${comparison.current.target ?? "unknown"})`,
    `Result: ${comparison.ok ? "OK" : "REGRESSED"}`,
    `Regressions: ${comparison.regressionCount}`,
    "",
    "Scenarios:"
  ];

  for (const scenario of comparison.scenarios) {
    lines.push(`- ${scenario.status} ${scenario.key}`);
    for (const regression of scenario.regressions) {
      lines.push(`  ${regression.message}`);
    }
  }

  return lines.join("\n");
}

function indexRecords(records) {
  const index = new Map();
  for (const record of records) {
    index.set(recordKey(record), record);
  }
  return index;
}

function recordKey(record) {
  return `${record.scenario}:${record.state?.id ?? "none"}`;
}

function reportSummary(report) {
  return {
    runId: report.runId ?? null,
    mode: report.mode ?? null,
    profile: report.profile?.id ?? null,
    target: report.target ?? null,
    generatedAt: report.generatedAt ?? null,
    statuses: report.summary?.statuses ?? {}
  };
}

function statusRank(status) {
  const ranks = {
    PASS: 0,
    "DRY-RUN": 0,
    SKIPPED: 1,
    FAIL: 2,
    BLOCKED: 3
  };
  return ranks[status] ?? 2;
}

function metricRegressions(baseline, current, thresholds) {
  const regressions = [];
  for (const [metric, tolerance] of Object.entries(thresholds)) {
    addIncreaseRegression(regressions, baseline, current, metric, tolerance);
  }
  return regressions;
}

function addIncreaseRegression(regressions, baseline, current, metric, tolerance) {
  const baselineValue = baseline[metric];
  const currentValue = current[metric];
  if (typeof baselineValue !== "number" || typeof currentValue !== "number") {
    return;
  }

  const delta = currentValue - baselineValue;
  if (delta <= tolerance) {
    return;
  }

  regressions.push({
    kind: "metric",
    metric,
    baseline: baselineValue,
    current: currentValue,
    delta,
    tolerance,
    message: `${metric} increased by ${delta} (${baselineValue} -> ${currentValue}), over tolerance ${tolerance}`
  });
}

function metricDeltas(baseline, current) {
  const metrics = {};
  for (const metric of [
    "peakRssMb",
    "cpuPercentMax",
    "coldReadyMs",
    "warmReadyMs",
    "upgradeMs",
    "statusMs",
    "pluginsListMs",
    "modelsListMs",
    "agentTurnMs",
    "tcpConnectMaxMs",
    "timeToListeningMs",
    "timeToHealthReadyMs",
    "healthP95Ms",
    "healthFailures",
    "readinessFailures",
    "missingDependencyErrors",
    "pluginLoadFailures",
    "gatewayRestartCount",
    "metadataScanMentions",
    "configNormalizationMentions",
    "providerLoadMentions",
    "modelCatalogMentions",
    "providerTimeoutMentions",
    "eventLoopDelayMentions",
    "v8ReportCount",
    "heapSnapshotCount",
    "diagnosticArtifactBytes",
    "nodeCpuProfileCount",
    "nodeHeapProfileCount",
    "nodeTraceEventCount",
    "nodeProfileArtifactBytes",
    "nodeProfileTopFunctionMs",
    "heapSnapshotBytes",
    "resourceSampleCount",
    "resourcePeakCommandTreeRssMb",
    "resourcePeakGatewayRssMb",
    "openclawTimelineEventCount",
    "openclawTimelineParseErrors",
    "openclawSlowestSpanMs",
    "openclawRepeatedSpanCount",
    "openclawEventLoopMaxMs",
    "openclawProviderRequestMaxMs",
    "openclawChildProcessFailedCount",
    "pluginMetadataScanCount",
    "configNormalizationCount",
    "runtimeDepsStagingMs",
    "eventLoopDelayMs",
    "providerModelTimingMs"
  ]) {
    const currentValue = current?.[metric] ?? null;
    const baselineValue = baseline?.[metric] ?? null;
    metrics[metric] = {
      baseline: baselineValue,
      current: currentValue,
      delta: typeof baselineValue === "number" && typeof currentValue === "number" ? currentValue - baselineValue : null
    };
  }
  return metrics;
}

function resolveThresholds(raw) {
  if (!raw) {
    return { ...defaultThresholds };
  }
  const overrides = raw.metrics && typeof raw.metrics === "object" ? raw.metrics : raw;
  const thresholds = { ...defaultThresholds };
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      thresholds[key] = value;
    }
  }
  return thresholds;
}
