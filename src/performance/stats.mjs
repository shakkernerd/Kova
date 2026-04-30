export const PERFORMANCE_SCHEMA = "kova.performance.v1";

export const PERFORMANCE_METRICS = [
  { id: "timeToHealthReadyMs", title: "Health Ready", unit: "ms", regressionKey: "startupRegressionPercent" },
  { id: "timeToListeningMs", title: "TCP Listening", unit: "ms", regressionKey: "startupRegressionPercent" },
  { id: "peakRssMb", title: "Peak RSS", unit: "MB", regressionKey: "rssRegressionPercent" },
  { id: "resourcePeakGatewayRssMb", title: "Gateway RSS", unit: "MB", regressionKey: "rssRegressionPercent" },
  { id: "cpuPercentMax", title: "Max CPU", unit: "%", regressionKey: "cpuRegressionPercent" },
  { id: "openclawEventLoopMaxMs", title: "Event Loop Max", unit: "ms", regressionKey: "eventLoopRegressionPercent" },
  { id: "eventLoopDelayMs", title: "Event Loop Delay", unit: "ms", regressionKey: "eventLoopRegressionPercent" },
  { id: "agentTurnMs", title: "Agent Turn", unit: "ms", regressionKey: "agentLatencyRegressionPercent" },
  { id: "healthP95Ms", title: "Health p95", unit: "ms", regressionKey: "startupRegressionPercent" },
  { id: "runtimeDepsStagingMs", title: "Runtime Deps Staging", unit: "ms", regressionKey: "startupRegressionPercent" }
];

export const DEFAULT_REGRESSION_THRESHOLDS = {
  startupRegressionPercent: 25,
  rssRegressionPercent: 15,
  cpuRegressionPercent: 25,
  eventLoopRegressionPercent: 25,
  agentLatencyRegressionPercent: 20,
  minimumBaselineValue: 1,
  noisyRelativeStddevPercent: 35,
  noisyAbsoluteSpreadPercent: 50
};

export function buildPerformanceSummary(records, options = {}) {
  const groups = [];
  for (const groupRecords of groupRecordsForPerformance(records).values()) {
    groups.push(summarizeGroup(groupRecords, options));
  }

  const unstableGroups = groups.filter((group) =>
    Object.values(group.metrics).some((metric) => metric.classification === "unstable")
  );

  return {
    schemaVersion: PERFORMANCE_SCHEMA,
    generatedAt: new Date().toISOString(),
    repeat: options.repeat ?? null,
    metricCatalog: PERFORMANCE_METRICS.map(({ id, title, unit }) => ({ id, title, unit })),
    groupCount: groups.length,
    unstableGroupCount: unstableGroups.length,
    groups
  };
}

export function performanceRecordKey(record, platform, targetPlan) {
  const key = performanceIdentity(record, platform, targetPlan);
  return [
    key.platform.os,
    key.platform.arch,
    key.targetKind,
    key.surface,
    key.state,
    key.scenario
  ].join("|");
}

export function performanceIdentity(record, platform, targetPlan) {
  return {
    scenario: record.scenario ?? null,
    surface: record.surface ?? null,
    state: record.state?.id ?? null,
    targetKind: targetPlan?.kind ?? targetKindFromSelector(record.target),
    platform: {
      os: platform?.os ?? null,
      arch: platform?.arch ?? null
    }
  };
}

export function summarizeMetricValues(values, thresholds = DEFAULT_REGRESSION_THRESHOLDS) {
  const effectiveThresholds = {
    ...DEFAULT_REGRESSION_THRESHOLDS,
    ...((thresholds?.metrics && typeof thresholds.metrics === "object") ? thresholds.metrics : thresholds ?? {})
  };
  const sorted = values.filter(isFiniteNumber).toSorted((left, right) => left - right);
  if (sorted.length === 0) {
    return null;
  }
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const mean = sorted.reduce((total, value) => total + value, 0) / sorted.length;
  const variance = sorted.reduce((total, value) => total + ((value - mean) ** 2), 0) / sorted.length;
  const stddev = Math.sqrt(variance);
  const relativeStddevPercent = mean === 0 ? 0 : (stddev / Math.abs(mean)) * 100;
  const absoluteSpreadPercent = min === 0 ? (max === 0 ? 0 : 100) : ((max - min) / Math.abs(min)) * 100;
  const classification = relativeStddevPercent > effectiveThresholds.noisyRelativeStddevPercent ||
    absoluteSpreadPercent > effectiveThresholds.noisyAbsoluteSpreadPercent
    ? "unstable"
    : "stable";

  return {
    count: sorted.length,
    min: round(min),
    median: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
    max: round(max),
    mean: round(mean),
    variance: round(variance),
    stddev: round(stddev),
    relativeStddevPercent: round(relativeStddevPercent),
    absoluteSpreadPercent: round(absoluteSpreadPercent),
    classification,
    samples: sorted.map(round)
  };
}

function groupRecordsForPerformance(records) {
  const groups = new Map();
  for (const record of records ?? []) {
    const key = [
      record.scenario ?? "unknown",
      record.surface ?? "unknown",
      record.state?.id ?? "none"
    ].join("|");
    const existing = groups.get(key) ?? [];
    existing.push(record);
    groups.set(key, existing);
  }
  return groups;
}

function summarizeGroup(records, options) {
  const first = records[0] ?? {};
  const metrics = {};
  for (const metric of PERFORMANCE_METRICS) {
    const values = records
      .map((record) => record.measurements?.[metric.id])
      .filter(isFiniteNumber);
    const summary = summarizeMetricValues(values, options.regressionThresholds);
    if (summary) {
      metrics[metric.id] = {
        ...summary,
        unit: metric.unit,
        title: metric.title
      };
    }
  }

  return {
    key: [
      first.scenario ?? "unknown",
      first.surface ?? "unknown",
      first.state?.id ?? "none"
    ].join("|"),
    scenario: first.scenario ?? null,
    surface: first.surface ?? null,
    state: first.state?.id ?? null,
    title: first.title ?? null,
    sampleCount: records.length,
    statuses: statusCounts(records),
    repeatIndexes: records.map((record) => record.repeat?.index ?? null).filter((value) => value !== null),
    metrics
  };
}

function statusCounts(records) {
  const counts = {};
  for (const record of records) {
    counts[record.status] = (counts[record.status] ?? 0) + 1;
  }
  return counts;
}

function percentile(sortedValues, percentileValue) {
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
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

function targetKindFromSelector(selector) {
  const string = String(selector ?? "");
  return string.includes(":") ? string.split(":", 1)[0] : null;
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function round(value) {
  return Math.round(value * 100) / 100;
}
