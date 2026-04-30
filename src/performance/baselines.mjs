import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { baselinesDir } from "../paths.mjs";
import {
  DEFAULT_REGRESSION_THRESHOLDS,
  PERFORMANCE_METRICS,
  performanceIdentity,
  performanceRecordKey
} from "./stats.mjs";

export const BASELINE_SCHEMA = "kova.baselines.v1";
export const BASELINE_COMPARISON_SCHEMA = "kova.baselineComparison.v1";

export function defaultBaselinePath() {
  return join(baselinesDir, "baselines.json");
}

export function resolveBaselinePath(value) {
  if (value === undefined || value === null || value === false) {
    return null;
  }
  if (value === true || value === "default") {
    return defaultBaselinePath();
  }
  return String(value).startsWith("/") ? String(value) : join(process.cwd(), String(value));
}

export async function loadBaselineStore(path) {
  if (!path) {
    return null;
  }
  try {
    const store = JSON.parse(await readFile(path, "utf8"));
    if (store.schemaVersion !== BASELINE_SCHEMA || !store.entries || typeof store.entries !== "object") {
      throw new Error(`invalid Kova baseline store: ${path}`);
    }
    return store;
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        schemaVersion: BASELINE_SCHEMA,
        createdAt: new Date().toISOString(),
        updatedAt: null,
        entries: {}
      };
    }
    throw error;
  }
}

export async function saveBaselineStore(path, store) {
  if (!path) {
    return null;
  }
  await mkdir(dirname(path), { recursive: true });
  const output = {
    schemaVersion: BASELINE_SCHEMA,
    createdAt: store.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    entries: store.entries ?? {}
  };
  await writeFile(path, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  return {
    schemaVersion: "kova.baselineSave.v1",
    path,
    entryCount: Object.keys(output.entries).length,
    updatedAt: output.updatedAt
  };
}

export function updateBaselineStore(store, report, options = {}) {
  const next = {
    schemaVersion: BASELINE_SCHEMA,
    createdAt: store?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    entries: { ...(store?.entries ?? {}) }
  };

  for (const group of report.performance?.groups ?? []) {
    const representative = (report.records ?? []).find((record) =>
      record.scenario === group.scenario && record.state?.id === group.state && record.surface === group.surface
    );
    if (!representative) {
      continue;
    }
    const key = performanceRecordKey(representative, report.platform, options.targetPlan);
    next.entries[key] = {
      schemaVersion: "kova.baselineEntry.v1",
      key,
      identity: performanceIdentity(representative, report.platform, options.targetPlan),
      source: {
        runId: report.runId,
        generatedAt: report.generatedAt,
        target: report.target,
        mode: report.mode,
        profile: report.profile?.id ?? null
      },
      aggregate: group
    };
  }

  return next;
}

export function comparePerformanceToBaseline(report, store, options = {}) {
  if (!store) {
    return null;
  }
  const thresholds = normalizeRegressionThresholds(options.regressionThresholds);
  const groups = [];
  const regressions = [];
  const missing = [];

  for (const group of report.performance?.groups ?? []) {
    const representative = (report.records ?? []).find((record) =>
      record.scenario === group.scenario && record.state?.id === group.state && record.surface === group.surface
    );
    if (!representative) {
      continue;
    }
    const key = performanceRecordKey(representative, report.platform, options.targetPlan);
    const baseline = store.entries?.[key] ?? null;
    if (!baseline) {
      missing.push({
        key,
        scenario: group.scenario,
        surface: group.surface,
        state: group.state,
        message: `no baseline for ${group.scenario}/${group.state ?? "none"} on ${report.platform?.os}/${report.platform?.arch}`
      });
      groups.push({
        key,
        scenario: group.scenario,
        surface: group.surface,
        state: group.state,
        status: "NO_BASELINE",
        regressions: []
      });
      continue;
    }

    const groupRegressions = metricRegressions(baseline.aggregate?.metrics ?? {}, group.metrics ?? {}, thresholds);
    regressions.push(...groupRegressions.map((regression) => ({
      ...regression,
      key,
      scenario: group.scenario,
      surface: group.surface,
      state: group.state
    })));
    groups.push({
      key,
      scenario: group.scenario,
      surface: group.surface,
      state: group.state,
      status: groupRegressions.length > 0 ? "REGRESSED" : "OK",
      baselineSource: baseline.source,
      regressions: groupRegressions
    });
  }

  return {
    schemaVersion: BASELINE_COMPARISON_SCHEMA,
    generatedAt: new Date().toISOString(),
    baselineEntryCount: Object.keys(store.entries ?? {}).length,
    thresholds,
    ok: regressions.length === 0,
    regressionCount: regressions.length,
    missingBaselineCount: missing.length,
    groups,
    regressions,
    missing
  };
}

export function normalizeRegressionThresholds(input = null) {
  const thresholds = { ...DEFAULT_REGRESSION_THRESHOLDS };
  const raw = input?.metrics && typeof input.metrics === "object" ? input.metrics : input;
  if (!raw || typeof raw !== "object") {
    return thresholds;
  }
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      thresholds[key] = value;
    }
  }
  return thresholds;
}

function metricRegressions(baselineMetrics, currentMetrics, thresholds) {
  const regressions = [];
  for (const metric of PERFORMANCE_METRICS) {
    const baseline = baselineMetrics[metric.id];
    const current = currentMetrics[metric.id];
    if (!baseline || !current || typeof baseline.median !== "number" || typeof current.median !== "number") {
      continue;
    }
    const limit = thresholds[metric.regressionKey];
    if (typeof limit !== "number") {
      continue;
    }
    const baselineValue = Math.max(baseline.median, thresholds.minimumBaselineValue);
    const increasePercent = ((current.median - baseline.median) / baselineValue) * 100;
    if (increasePercent <= limit) {
      continue;
    }
    regressions.push({
      kind: "performance-regression",
      metric: metric.id,
      title: metric.title,
      unit: metric.unit,
      thresholdPercent: limit,
      baselineMedian: baseline.median,
      currentMedian: current.median,
      baselineP95: baseline.p95 ?? null,
      currentP95: current.p95 ?? null,
      increasePercent: round(increasePercent),
      message: `${metric.title} median regressed ${round(increasePercent)}% (${baseline.median}${metric.unit} -> ${current.median}${metric.unit}), over ${limit}%`
    });
  }
  return regressions;
}

function round(value) {
  return Math.round(value * 100) / 100;
}
