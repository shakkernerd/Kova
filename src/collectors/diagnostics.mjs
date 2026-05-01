import { cp, mkdir, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { runCommand } from "../commands.mjs";
import { ocmEnvExecShell } from "../ocm/commands.mjs";

export const OPENCLAW_DIAGNOSTICS_SCHEMA = "kova.openclawDiagnostics.v1";
export const DIAGNOSTIC_ARTIFACTS_SCHEMA = "kova.diagnosticArtifacts.v1";
export const HEAP_SNAPSHOT_SCHEMA = "kova.heapSnapshot.v1";
export const DIAGNOSTIC_REPORT_SCHEMA = "kova.diagnosticReport.v1";

export function collectOpenClawDiagnostics(logs) {
  const events = logs?.structuredEvents ?? [];
  const startupEvents = events.filter((event) => event.category === "startup" || event.phase || event.startupPhase);
  const pluginEvents = events.filter((event) => event.category === "plugins" || event.plugin || event.pluginId);
  const configEvents = events.filter((event) => event.category === "config" || event.config || event.normalization);
  const runtimeDepEvents = events.filter((event) => event.category === "runtime-deps" || event.runtimeDeps || event.runtimeDependency);
  const providerEvents = events.filter((event) => event.category === "providers" || event.provider || event.modelProvider);
  const eventLoopEvents = events.filter((event) => event.eventLoopDelayMs !== undefined || event.eventLoop !== undefined);

  return {
    schemaVersion: OPENCLAW_DIAGNOSTICS_SCHEMA,
    available: events.length > 0,
    source: events.length > 0 ? "structured-log-events" : "log-pattern-fallback",
    eventCount: events.length,
    startupTimeline: summarizeTimedEvents(startupEvents),
    pluginMetadataScanCount: numericSum(pluginEvents, ["metadataScanCount", "scanCount"]) ?? fallbackCount(logs, "metadataScanMentions"),
    configNormalizationCount: numericSum(configEvents, ["normalizationCount", "configNormalizationCount"]) ?? fallbackCount(logs, "configNormalizationMentions"),
    runtimeDepsStagingMs: numericMax(runtimeDepEvents, ["durationMs", "runtimeDepsStagingMs", "stagingMs"]),
    eventLoopDelayMs: numericMax(eventLoopEvents, ["eventLoopDelayMs", "delayMs", "maxMs"]),
    providerModelTimingMs: numericMax(providerEvents, ["durationMs", "providerModelTimingMs", "modelCatalogMs"]),
    events: events.slice(0, 50)
  };
}

export async function collectDiagnosticMetrics(envName, timeoutMs, artifactDir) {
  const command = ocmEnvExecShell(
    envName,
    'find "$OPENCLAW_HOME" -maxdepth 6 -type f \\( -name "report.*.json" -o -name "*.heapsnapshot" -o -name "*heap*.json" -o -name "*diagnostic*.json" \\) -print 2>/dev/null | head -100'
  );
  const result = await runCommand(command, { timeoutMs, maxOutputChars: 100000 });
  const files = result.status === 0
    ? result.stdout.split("\n").map((line) => line.trim()).filter(Boolean)
    : [];
  files.push(...await collectLocalDiagnosticReports(artifactDir));
  const uniqueFiles = [...new Set(files)];
  const artifacts = [];

  let artifactBytes = 0;
  if (artifactDir && uniqueFiles.length > 0) {
    const diagnosticsDir = join(artifactDir, "diagnostics");
    await mkdir(diagnosticsDir, { recursive: true });
    for (const file of uniqueFiles.slice(0, 25)) {
      if (!existsSync(file)) {
        continue;
      }
      const target = join(diagnosticsDir, basename(file));
      await cp(file, target, { force: true });
      artifactBytes += await fileSize(target);
      artifacts.push(target);
    }
  }

  return {
    schemaVersion: DIAGNOSTIC_ARTIFACTS_SCHEMA,
    commandStatus: result.status,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    fileCount: uniqueFiles.length,
    v8ReportCount: uniqueFiles.filter((file) => /report\..*\.json$|diagnostic.*\.json$/i.test(file)).length,
    heapSnapshotCount: uniqueFiles.filter((file) => /\.heapsnapshot$|heap.*\.json$/i.test(file)).length,
    artifactBytes,
    files: uniqueFiles.slice(0, 25),
    artifacts,
    error: result.status === 0 ? null : firstOutputLine(result.stderr) || firstOutputLine(result.stdout) || "diagnostic artifact scan unavailable"
  };
}

export async function triggerHeapSnapshot(envName, pid, timeoutMs, artifactDir) {
  const command = ocmEnvExecShell(
    envName,
    `kill -USR2 ${Number(pid)} 2>/dev/null || true; sleep 1; find "$OPENCLAW_HOME" -maxdepth 6 -type f -name "*.heapsnapshot" -print 2>/dev/null | head -25`
  );
  const result = await runCommand(command, { timeoutMs, maxOutputChars: 100000 });
  const files = result.status === 0
    ? result.stdout.split("\n").map((line) => line.trim()).filter(Boolean)
    : [];
  const artifacts = [];

  let artifactBytes = 0;
  if (artifactDir && files.length > 0) {
    const heapDir = join(artifactDir, "heap");
    await mkdir(heapDir, { recursive: true });
    for (const file of files) {
      if (!existsSync(file)) {
        continue;
      }
      await waitForStableFile(file, Math.min(timeoutMs, 5000));
      const target = join(heapDir, basename(file));
      await cp(file, target, { force: true });
      artifactBytes += await fileSize(target);
      artifacts.push(target);
    }
  }

  return {
    schemaVersion: HEAP_SNAPSHOT_SCHEMA,
    commandStatus: result.status,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    requested: true,
    fileCount: files.length,
    artifactBytes,
    files,
    artifacts,
    error: result.status === 0 ? null : firstOutputLine(result.stderr) || firstOutputLine(result.stdout) || "heap snapshot trigger unavailable"
  };
}

export async function triggerDiagnosticReport(envName, pid, timeoutMs, artifactDir, options = {}) {
  const signalCommand = options.signalAlreadySent === true ? ":" : `kill -USR2 ${Number(pid)} 2>/dev/null || true`;
  const command = ocmEnvExecShell(
    envName,
    `${signalCommand}; sleep 1; find "$OPENCLAW_HOME" -maxdepth 6 -type f \\( -name "report.*.json" -o -name "*diagnostic*.json" \\) -print 2>/dev/null | head -25`
  );
  const result = await runCommand(command, { timeoutMs, maxOutputChars: 100000 });
  const files = result.status === 0
    ? result.stdout.split("\n").map((line) => line.trim()).filter(Boolean)
    : [];
  files.push(...await collectLocalDiagnosticReports(artifactDir));
  const uniqueFiles = [...new Set(files)];
  const artifacts = [];

  let artifactBytes = 0;
  if (artifactDir && uniqueFiles.length > 0) {
    const reportDir = join(artifactDir, "diagnostic-reports");
    await mkdir(reportDir, { recursive: true });
    for (const file of uniqueFiles) {
      if (!existsSync(file)) {
        continue;
      }
      const target = join(reportDir, basename(file));
      await cp(file, target, { force: true });
      artifactBytes += await fileSize(target);
      artifacts.push(target);
    }
  }

  return {
    schemaVersion: DIAGNOSTIC_REPORT_SCHEMA,
    commandStatus: result.status,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    requested: true,
    fileCount: uniqueFiles.length,
    artifactBytes,
    files: uniqueFiles,
    artifacts,
    error: result.status === 0 ? null : firstOutputLine(result.stderr) || firstOutputLine(result.stdout) || "diagnostic report trigger unavailable"
  };
}

async function collectLocalDiagnosticReports(artifactDir) {
  const profileDir = artifactDir ? join(artifactDir, "node-profiles") : null;
  if (!profileDir) {
    return [];
  }

  try {
    const entries = await readdir(profileDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => join(profileDir, entry.name))
      .filter((path) => /report\..*\.json$|diagnostic.*\.json$/i.test(path));
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function waitForStableFile(path, timeoutMs) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let lastSize = -1;
  let stableCount = 0;

  while (Date.now() <= deadline) {
    const size = await fileSize(path);
    if (size > 0 && size === lastSize) {
      stableCount += 1;
      if (stableCount >= 2) {
        return size;
      }
    } else {
      stableCount = 0;
      lastSize = size;
    }
    await sleep(250);
  }

  return lastSize;
}

async function fileSize(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

function summarizeTimedEvents(events) {
  return events
    .map((event) => ({
      phase: event.phase ?? event.startupPhase ?? event.name ?? event.category ?? "unknown",
      durationMs: firstNumber(event, ["durationMs", "elapsedMs", "ms"]),
      timestamp: event.timestamp ?? event.time ?? null
    }))
    .slice(0, 50);
}

function fallbackCount(logs, key) {
  const value = logs?.[key];
  return typeof value === "number" ? value : null;
}

function numericSum(events, keys) {
  let total = 0;
  let found = false;
  for (const event of events) {
    const value = firstNumber(event, keys);
    if (typeof value === "number") {
      total += value;
      found = true;
    }
  }
  return found ? total : null;
}

function numericMax(events, keys) {
  const values = events.map((event) => firstNumber(event, keys)).filter((value) => typeof value === "number");
  return values.length === 0 ? null : Math.max(...values);
}

function firstNumber(value, keys) {
  for (const key of keys) {
    if (typeof value?.[key] === "number") {
      return value[key];
    }
  }
  return null;
}

function firstOutputLine(value) {
  return value.trim().split("\n").find(Boolean);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
