export function compareReports(baseline, current) {
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

    regressions.push(...metricRegressions(baselineRecord.measurements ?? {}, currentRecord.measurements ?? {}));

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
    ok: regressionCount === 0,
    regressionCount,
    scenarios
  };
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

function metricRegressions(baseline, current) {
  const regressions = [];
  addIncreaseRegression(regressions, baseline, current, "missingDependencyErrors", 0);
  addIncreaseRegression(regressions, baseline, current, "pluginLoadFailures", 0);
  addIncreaseRegression(regressions, baseline, current, "healthFailures", 0);
  addIncreaseRegression(regressions, baseline, current, "peakRssMb", 100);
  addIncreaseRegression(regressions, baseline, current, "healthP95Ms", 1000);
  addIncreaseRegression(regressions, baseline, current, "metadataScanMentions", 10);
  addIncreaseRegression(regressions, baseline, current, "configNormalizationMentions", 10);
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
    "healthP95Ms",
    "healthFailures",
    "missingDependencyErrors",
    "pluginLoadFailures",
    "metadataScanMentions",
    "configNormalizationMentions"
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
