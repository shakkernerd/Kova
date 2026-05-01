import { runCommand } from "./commands.mjs";
import { ocmServiceStatusJson } from "./ocm/commands.mjs";
import { collectDiagnosticMetrics, collectOpenClawDiagnostics, triggerDiagnosticReport, triggerHeapSnapshot } from "./collectors/diagnostics.mjs";
import { collectHealthSamples, collectReadinessMetrics, summarizeHealthSamples } from "./collectors/readiness.mjs";
import { collectLogMetrics } from "./collectors/logs.mjs";
import { collectNodeProfileMetrics } from "./collectors/node-profiles.mjs";
import { collectTimelineMetrics } from "./collectors/timeline.mjs";

export { collectNodeProfileMetrics };

export const ENV_METRICS_SCHEMA = "kova.envMetrics.v1";
export const PROCESS_METRICS_SCHEMA = "kova.processMetrics.v1";

export async function collectEnvMetrics(envName, options = {}) {
  const timeoutMs = Math.min(options.timeoutMs ?? 10000, 10000);
  const healthSampleCount = Math.max(1, Number(options.healthSamples ?? 3));
  const healthIntervalMs = Math.max(0, Number(options.healthIntervalMs ?? 250));
  const readinessTimeoutMs = Math.min(
    Math.max(0, Number(options.readinessTimeoutMs ?? 0)),
    Math.max(timeoutMs, Number(options.timeoutMs ?? timeoutMs))
  );
  const readinessIntervalMs = Math.max(50, Number(options.readinessIntervalMs ?? 250));
  const collectors = [];
  const service = await runCommand(ocmServiceStatusJson(envName), { timeoutMs });
  const metrics = {
    schemaVersion: ENV_METRICS_SCHEMA,
    collectedAt: new Date().toISOString(),
    artifactDir: options.artifactDir ?? null,
    collectorArtifactDirs: options.collectorArtifactDirs ?? null,
    collectors,
    serviceCommand: {
      status: service.status,
      durationMs: service.durationMs,
      timedOut: service.timedOut
    },
    service: null,
    process: null,
    readiness: null,
    listening: null,
    health: null,
    healthSamples: [],
    healthSummary: null,
    logs: null,
    diagnostics: null,
    heapSnapshot: null,
    diagnosticReport: null,
    nodeProfiles: null,
    openclawDiagnostics: null,
    timeline: null,
    error: null
  };
  recordCollector(collectors, "service", service);

  if (service.status !== 0) {
    metrics.error = firstOutputLine(service.stderr) || firstOutputLine(service.stdout) || "service status unavailable";
    return metrics;
  }

  let serviceJson;
  try {
    serviceJson = JSON.parse(service.stdout);
  } catch (error) {
    metrics.error = `service status JSON parse failed: ${error.message}`;
    return metrics;
  }

  metrics.service = {
    gatewayState: serviceJson.gatewayState ?? null,
    running: serviceJson.running ?? null,
    desiredRunning: serviceJson.desiredRunning ?? null,
    childPid: serviceJson.childPid ?? null,
    gatewayPort: serviceJson.gatewayPort ?? null,
    runtimeReleaseVersion: serviceJson.runtimeReleaseVersion ?? null,
    runtimeReleaseChannel: serviceJson.runtimeReleaseChannel ?? null,
    issue: serviceJson.issue ?? null
  };

  if (serviceJson.childPid) {
    metrics.process = await collectProcessMetrics(serviceJson.childPid, timeoutMs);
    recordCollector(collectors, "process", metrics.process);
  }

  if (serviceJson.gatewayPort) {
    await collectReadinessAndHealth(metrics, collectors, serviceJson.gatewayPort, {
      readinessTimeoutMs,
      readinessThresholdMs: options.readinessThresholdMs,
      readinessIntervalMs,
      probeTimeoutMs: timeoutMs,
      healthSampleCount,
      healthIntervalMs,
      timeoutMs,
      sampleHealthAfterReady: Boolean(serviceJson.childPid)
    });
  }

  await collectLogAndTimelineMetrics(metrics, collectors, envName, timeoutMs, options);

  if (options.heapSnapshot === true && serviceJson.childPid) {
    metrics.heapSnapshot = await triggerHeapSnapshot(envName, serviceJson.childPid, timeoutMs, options.artifactDir);
    recordCollector(collectors, "heap-snapshot", metrics.heapSnapshot, metrics.heapSnapshot.artifacts);
  }
  if (options.diagnosticReport === true && serviceJson.childPid) {
    metrics.diagnosticReport = await triggerDiagnosticReport(envName, serviceJson.childPid, timeoutMs, options.artifactDir, {
      signalAlreadySent: options.heapSnapshot === true
    });
    recordCollector(collectors, "diagnostic-report", metrics.diagnosticReport, metrics.diagnosticReport.artifacts);
  }
  await collectDiagnosticArtifactMetrics(metrics, collectors, envName, timeoutMs, options);

  return metrics;
}

async function collectReadinessAndHealth(metrics, collectors, port, options) {
  const readinessStarted = Date.now();
  metrics.readiness = await collectReadinessMetrics(port, {
    timeoutMs: options.readinessTimeoutMs,
    thresholdMs: options.readinessThresholdMs,
    intervalMs: options.readinessIntervalMs,
    probeTimeoutMs: options.probeTimeoutMs
  });
  recordCollector(collectors, "readiness", {
    commandStatus: metrics.readiness.ready ? 0 : 1,
    durationMs: Date.now() - readinessStarted,
    timedOut: !metrics.readiness.ready && options.readinessTimeoutMs > 0,
    error: metrics.readiness.ready ? null : "readiness deadline expired"
  });

  metrics.listening = metrics.readiness.listening;
  if (options.sampleHealthAfterReady) {
    metrics.healthSamples = await collectHealthSamples(port, {
      count: options.healthSampleCount,
      intervalMs: options.healthIntervalMs,
      timeoutMs: options.timeoutMs
    });
    metrics.health = metrics.healthSamples.at(-1) ?? null;
  } else {
    metrics.health = metrics.readiness.health;
    metrics.healthSamples = metrics.readiness.healthAttempts;
  }
  metrics.healthSummary = summarizeHealthSamples(metrics.healthSamples);
}

async function collectLogAndTimelineMetrics(metrics, collectors, envName, timeoutMs, options) {
  metrics.logs = await collectLogMetrics(envName, timeoutMs, options.artifactDir);
  recordCollector(collectors, "logs", metrics.logs, metrics.logs.artifacts);

  metrics.openclawDiagnostics = collectOpenClawDiagnostics(metrics.logs);
  recordCollector(collectors, "openclaw-diagnostics", {
    commandStatus: 0,
    durationMs: 0,
    statusLabel: metrics.openclawDiagnostics.available ? "PASS" : "INFO",
    error: metrics.openclawDiagnostics.available ? null : "structured diagnostics unavailable; using log-pattern fallback"
  });

  metrics.timeline = await collectTimelineMetrics(options.artifactDir);
  recordCollector(collectors, "timeline", metrics.timeline, metrics.timeline.artifacts);
}

async function collectDiagnosticArtifactMetrics(metrics, collectors, envName, timeoutMs, options) {
  metrics.diagnostics = await collectDiagnosticMetrics(envName, timeoutMs, options.artifactDir);
  recordCollector(collectors, "diagnostics", metrics.diagnostics, metrics.diagnostics.artifacts);

  metrics.nodeProfiles = await collectNodeProfileMetrics(options.artifactDir);
  recordCollector(collectors, "node-profiles", metrics.nodeProfiles, metrics.nodeProfiles.artifacts);
}

function recordCollector(collectors, id, result, artifacts = []) {
  const status = result.statusLabel ?? collectorStatus(result);
  collectors.push({
    schemaVersion: "kova.collectorReceipt.v1",
    id,
    status,
    durationMs: typeof result.durationMs === "number" ? result.durationMs : 0,
    commandStatus: result.commandStatus ?? result.status ?? null,
    timedOut: result.timedOut === true,
    artifactCount: artifacts?.length ?? 0,
    artifacts: artifacts ?? [],
    error: result.error ?? null
  });
}

function collectorStatus(result) {
  if (result.timedOut === true) {
    return "FAIL";
  }
  const status = result.commandStatus ?? result.status;
  if (typeof status === "number" && status !== 0) {
    return "FAIL";
  }
  if (result.error) {
    return "WARN";
  }
  return "PASS";
}

async function collectProcessMetrics(pid, timeoutMs) {
  const result = await runCommand(`ps -p ${Number(pid)} -o pid= -o rss= -o %cpu= -o comm=`, { timeoutMs });
  const metrics = {
    schemaVersion: PROCESS_METRICS_SCHEMA,
    pid,
    commandStatus: result.status,
    durationMs: result.durationMs,
    rssKb: null,
    rssMb: null,
    cpuPercent: null,
    command: null,
    error: null
  };

  if (result.status !== 0) {
    metrics.error = firstOutputLine(result.stderr) || firstOutputLine(result.stdout) || "process metrics unavailable";
    return metrics;
  }

  const line = result.stdout.trim().split("\n").at(-1);
  if (!line) {
    metrics.error = "empty ps output";
    return metrics;
  }

  const match = line.trim().match(/^(\d+)\s+(\d+)\s+([0-9.]+)\s+(.+)$/);
  if (!match) {
    metrics.error = `unexpected ps output: ${line}`;
    return metrics;
  }

  const rssKb = Number(match[2]);
  metrics.rssKb = rssKb;
  metrics.rssMb = Math.round((rssKb / 1024) * 10) / 10;
  metrics.cpuPercent = Number(match[3]);
  metrics.command = match[4];
  return metrics;
}

function firstOutputLine(value) {
  return String(value ?? "").trim().split("\n").find(Boolean);
}
