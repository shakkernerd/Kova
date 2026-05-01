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
  coldAgentTurnMs: 10000,
  warmAgentTurnMs: 5000,
  agentColdWarmDeltaMs: 10000,
  coldPreProviderMs: 5000,
  warmPreProviderMs: 2500,
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
  const sourceRelease = compareSourceReleaseDiagnostics(baseline, current);
  const sourceReleaseBlockingCount = sourceRelease?.blockingCount ?? 0;
  return {
    schemaVersion: "kova.compare.v1",
    generatedAt: new Date().toISOString(),
    baseline: reportSummary(baseline),
    current: reportSummary(current),
    thresholds,
    sourceRelease,
    ok: regressionCount === 0 && sourceReleaseBlockingCount === 0,
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

  if (comparison.sourceRelease && comparison.sourceRelease.blockingCount > 0) {
    lines.push("Source/release diagnostic comparison:");
    for (const finding of comparison.sourceRelease.findings.filter((item) => item.severity === "blocking")) {
      lines.push(`- ${finding.message}`);
    }
    lines.push("");
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

  if (comparison.sourceRelease) {
    lines.push("");
    lines.push("Source/release diagnostics:");
    lines.push(`- Status: ${comparison.sourceRelease.ok ? "OK" : "NEEDS_WORK"}`);
    lines.push(`- Pairs: ${comparison.sourceRelease.pairCount}`);
    lines.push(`- Blocking: ${comparison.sourceRelease.blockingCount}`);
    for (const finding of comparison.sourceRelease.findings.slice(0, 8)) {
      lines.push(`- ${finding.severity.toUpperCase()} ${finding.key ?? "comparison"}: ${finding.message}`);
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
    targetKind: targetKind(report.target),
    generatedAt: report.generatedAt ?? null,
    statuses: report.summary?.statuses ?? {}
  };
}

function compareSourceReleaseDiagnostics(leftReport, rightReport) {
  const leftLane = targetLane(leftReport.target);
  const rightLane = targetLane(rightReport.target);
  if (!leftLane || !rightLane || leftLane === rightLane) {
    return null;
  }

  const sourceReport = leftLane === "source-build" ? leftReport : rightReport;
  const releaseReport = leftLane === "release-runtime" ? leftReport : rightReport;
  const sourceRecords = indexRecords(sourceReport.records ?? []);
  const releaseRecords = indexRecords(releaseReport.records ?? []);
  const keys = [...sourceRecords.keys()].filter((key) => releaseRecords.has(key)).sort();
  const findings = [];
  const pairs = [];

  if (keys.length === 0) {
    findings.push({
      severity: "blocking",
      key: null,
      message: "source-build and release-runtime reports have no shared scenario/state records, so diagnostic parity cannot be evaluated"
    });
  }

  for (const key of keys) {
    const source = sourceRecords.get(key);
    const release = releaseRecords.get(key);
    const pair = sourceReleasePair(key, source, release);
    pairs.push(pair);
    if (!pair.source.timelineAvailable) {
      findings.push({
        severity: "blocking",
        key,
        message: `${key} source-build report did not include OpenClaw timeline diagnostics`
      });
    }
    if (!pair.release.timelineAvailable) {
      findings.push({
        severity: "info",
        key,
        message: `${key} release-runtime report has no timeline; use outside-in timings for released packages`
      });
    }
    if (typeof pair.source.agentPreProviderMs === "number" && typeof pair.release.agentPreProviderMs === "number") {
      const delta = pair.release.agentPreProviderMs - pair.source.agentPreProviderMs;
      if (delta > defaultThresholds.coldPreProviderMs) {
        findings.push({
          severity: "warning",
          key,
          message: `${key} release pre-provider latency exceeded source-build by ${delta}ms (${pair.source.agentPreProviderMs}ms -> ${pair.release.agentPreProviderMs}ms)`
        });
      }
    }
  }

  const blockingCount = findings.filter((finding) => finding.severity === "blocking").length;
  const warningCount = findings.filter((finding) => finding.severity === "warning").length;
  const infoCount = findings.filter((finding) => finding.severity === "info").length;
  return {
    schemaVersion: "kova.sourceReleaseComparison.v1",
    sourceTarget: sourceReport.target ?? null,
    releaseTarget: releaseReport.target ?? null,
    ok: blockingCount === 0,
    pairCount: pairs.length,
    blockingCount,
    warningCount,
    infoCount,
    pairs,
    findings
  };
}

function sourceReleasePair(key, source, release) {
  return {
    key,
    scenario: source.scenario ?? release.scenario ?? null,
    state: source.state?.id ?? release.state?.id ?? null,
    surface: source.surface ?? release.surface ?? source.measurements?.surface ?? release.measurements?.surface ?? null,
    source: diagnosticRecordSummary(source),
    release: diagnosticRecordSummary(release)
  };
}

function diagnosticRecordSummary(record) {
  const measurements = record?.measurements ?? {};
  return {
    status: record?.status ?? null,
    timelineAvailable: measurements.openclawTimelineAvailable === true,
    timelineEventCount: measurements.openclawTimelineEventCount ?? null,
    slowestSpanName: measurements.openclawSlowestSpanName ?? null,
    slowestSpanMs: measurements.openclawSlowestSpanMs ?? null,
    openRequiredSpanCount: measurements.openclawOpenRequiredSpanCount ?? null,
    agentTurnMs: measurements.agentTurnMs ?? measurements.coldAgentTurnMs ?? null,
    agentPreProviderMs: measurements.agentPreProviderMs ?? measurements.coldPreProviderMs ?? null,
    providerFinalMs: measurements.agentProviderFinalMs ?? measurements.coldProviderFinalMs ?? null,
    runtimeDepsStagingMs: measurements.runtimeDepsStagingMs ?? null,
    timeToHealthReadyMs: measurements.timeToHealthReadyMs ?? null,
    peakRssMb: measurements.peakRssMb ?? null
  };
}

function targetLane(target) {
  const kind = targetKind(target);
  if (kind === "local-build") {
    return "source-build";
  }
  if (["npm", "channel", "runtime"].includes(kind)) {
    return "release-runtime";
  }
  return null;
}

function targetKind(target) {
  if (typeof target !== "string" || !target.includes(":")) {
    return null;
  }
  return target.split(":", 1)[0];
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
    "coldAgentTurnMs",
    "warmAgentTurnMs",
    "agentColdWarmDeltaMs",
    "coldPreProviderMs",
    "warmPreProviderMs",
    "agentColdWarmPreProviderDeltaMs",
    "coldProviderFinalMs",
    "warmProviderFinalMs",
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
