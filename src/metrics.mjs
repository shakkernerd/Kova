import { runCommand } from "./commands.mjs";
import { loadTimeline } from "./timeline.mjs";
import { createConnection } from "node:net";
import { cp, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { existsSync } from "node:fs";

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
  const service = await runCommand(`ocm service status ${envName} --json`, { timeoutMs });
  const metrics = {
    collectedAt: new Date().toISOString(),
    artifactDir: options.artifactDir ?? null,
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

  if (!serviceJson.childPid) {
    if (serviceJson.gatewayPort) {
      const readinessStarted = Date.now();
      metrics.readiness = await collectReadinessMetrics(serviceJson.gatewayPort, {
        timeoutMs: readinessTimeoutMs,
        intervalMs: readinessIntervalMs,
        probeTimeoutMs: timeoutMs
      });
      recordCollector(collectors, "readiness", {
        commandStatus: metrics.readiness.ready ? 0 : 1,
        durationMs: Date.now() - readinessStarted,
        timedOut: !metrics.readiness.ready && readinessTimeoutMs > 0,
        error: metrics.readiness.ready ? null : "readiness deadline expired"
      });
      metrics.listening = metrics.readiness.listening;
      metrics.health = metrics.readiness.health;
      metrics.healthSamples = metrics.readiness.healthAttempts;
      metrics.healthSummary = summarizeHealthSamples(metrics.healthSamples);
    }
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
    metrics.diagnostics = await collectDiagnosticMetrics(envName, timeoutMs, options.artifactDir);
    recordCollector(collectors, "diagnostics", metrics.diagnostics, metrics.diagnostics.artifacts);
    metrics.nodeProfiles = await collectNodeProfileMetrics(options.artifactDir);
    recordCollector(collectors, "node-profiles", metrics.nodeProfiles, metrics.nodeProfiles.artifacts);
    return metrics;
  }

  const process = await collectProcessMetrics(serviceJson.childPid, timeoutMs);
  metrics.process = process;
  recordCollector(collectors, "process", process);
  if (serviceJson.gatewayPort) {
    const readinessStarted = Date.now();
    metrics.readiness = await collectReadinessMetrics(serviceJson.gatewayPort, {
      timeoutMs: readinessTimeoutMs,
      intervalMs: readinessIntervalMs,
      probeTimeoutMs: timeoutMs
    });
    recordCollector(collectors, "readiness", {
      commandStatus: metrics.readiness.ready ? 0 : 1,
      durationMs: Date.now() - readinessStarted,
      timedOut: !metrics.readiness.ready && readinessTimeoutMs > 0,
      error: metrics.readiness.ready ? null : "readiness deadline expired"
    });
    metrics.listening = metrics.readiness.listening;
    metrics.healthSamples = await collectHealthSamples(serviceJson.gatewayPort, {
      count: healthSampleCount,
      intervalMs: healthIntervalMs,
      timeoutMs
    });
    metrics.health = metrics.healthSamples.at(-1) ?? null;
    metrics.healthSummary = summarizeHealthSamples(metrics.healthSamples);
  }
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
  if (options.heapSnapshot === true && serviceJson.childPid) {
    metrics.heapSnapshot = await triggerHeapSnapshot(envName, serviceJson.childPid, timeoutMs, options.artifactDir);
    recordCollector(collectors, "heap-snapshot", metrics.heapSnapshot, metrics.heapSnapshot.artifacts);
  }
  metrics.diagnostics = await collectDiagnosticMetrics(envName, timeoutMs, options.artifactDir);
  recordCollector(collectors, "diagnostics", metrics.diagnostics, metrics.diagnostics.artifacts);
  metrics.nodeProfiles = await collectNodeProfileMetrics(options.artifactDir);
  recordCollector(collectors, "node-profiles", metrics.nodeProfiles, metrics.nodeProfiles.artifacts);
  return metrics;
}

async function collectTimelineMetrics(artifactDir) {
  const startedAt = Date.now();
  const timelinePath = artifactDir ? join(artifactDir, "openclaw", "timeline.jsonl") : null;
  if (!timelinePath) {
    return {
      commandStatus: 0,
      statusLabel: "INFO",
      durationMs: 0,
      available: false,
      error: "artifact directory unavailable",
      artifacts: []
    };
  }

  const timeline = await loadTimeline(timelinePath);
  return {
    commandStatus: 0,
    statusLabel: timeline.available ? "PASS" : "INFO",
    durationMs: Date.now() - startedAt,
    ...timeline,
    artifacts: timeline.available ? [timelinePath] : [],
    error: timeline.available ? null : (timeline.error ?? (timeline.missing ? "OpenClaw timeline not emitted" : null))
  };
}

function recordCollector(collectors, id, result, artifacts = []) {
  const status = result.statusLabel ?? collectorStatus(result);
  collectors.push({
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

async function collectReadinessMetrics(port, options) {
  const startedAt = Date.now();
  const deadline = startedAt + options.timeoutMs;
  const listeningAttempts = [];
  const healthAttempts = [];
  let listeningReadyAtMs = null;
  let healthReadyAtMs = null;
  let lastListening = null;
  let lastHealth = null;

  do {
    lastListening = await collectListeningMetrics(port, options.probeTimeoutMs);
    lastListening.elapsedMs = Date.now() - startedAt;
    listeningAttempts.push(lastListening);
    if (lastListening.ok && listeningReadyAtMs === null) {
      listeningReadyAtMs = lastListening.elapsedMs;
    }

    lastHealth = await collectHealthMetrics(port, options.probeTimeoutMs);
    lastHealth.elapsedMs = Date.now() - startedAt;
    healthAttempts.push(lastHealth);
    if (lastHealth.ok) {
      healthReadyAtMs = lastHealth.elapsedMs;
      break;
    }

    if (options.timeoutMs === 0 || Date.now() >= deadline) {
      break;
    }

    await sleep(Math.min(options.intervalMs, Math.max(0, deadline - Date.now())));
  } while (Date.now() <= deadline);

  return {
    deadlineMs: options.timeoutMs,
    intervalMs: options.intervalMs,
    attempts: Math.max(listeningAttempts.length, healthAttempts.length),
    ready: healthReadyAtMs !== null,
    listeningReady: listeningReadyAtMs !== null,
    listeningReadyAtMs,
    healthReadyAtMs,
    listening: lastListening,
    health: lastHealth,
    listeningAttempts,
    healthAttempts
  };
}

function collectListeningMetrics(port, timeoutMs) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port: Number(port) });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({
        host: "127.0.0.1",
        port: Number(port),
        ok: false,
        durationMs: Date.now() - startedAt,
        error: "tcp connect timed out"
      });
    }, Math.min(timeoutMs, 5000));

    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve({
        host: "127.0.0.1",
        port: Number(port),
        ok: true,
        durationMs: Date.now() - startedAt
      });
    });

    socket.once("error", (error) => {
      clearTimeout(timer);
      resolve({
        host: "127.0.0.1",
        port: Number(port),
        ok: false,
        durationMs: Date.now() - startedAt,
        error: error.message
      });
    });
  });
}

async function collectProcessMetrics(pid, timeoutMs) {
  const result = await runCommand(`ps -p ${Number(pid)} -o pid= -o rss= -o %cpu= -o comm=`, { timeoutMs });
  const metrics = {
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

async function collectHealthMetrics(port, timeoutMs) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, 5000));

  try {
    const response = await fetch(`http://127.0.0.1:${Number(port)}/health`, {
      signal: controller.signal
    });
    const text = await response.text();
    return {
      url: `http://127.0.0.1:${Number(port)}/health`,
      ok: response.ok,
      status: response.status,
      durationMs: Date.now() - startedAt,
      bodySnippet: text.slice(0, 500)
    };
  } catch (error) {
    return {
      url: `http://127.0.0.1:${Number(port)}/health`,
      ok: false,
      status: null,
      durationMs: Date.now() - startedAt,
      error: error.name === "AbortError" ? "health request timed out" : error.message
    };
  } finally {
    clearTimeout(timer);
  }
}

async function collectHealthSamples(port, options) {
  const samples = [];
  for (let index = 0; index < options.count; index += 1) {
    samples.push(await collectHealthMetrics(port, options.timeoutMs));
    if (index < options.count - 1 && options.intervalMs > 0) {
      await sleep(options.intervalMs);
    }
  }
  return samples;
}

function summarizeHealthSamples(samples) {
  if (!Array.isArray(samples) || samples.length === 0) {
    return null;
  }

  const durations = samples.map((sample) => sample.durationMs).filter((duration) => typeof duration === "number").sort((a, b) => a - b);
  return {
    count: samples.length,
    okCount: samples.filter((sample) => sample.ok).length,
    failureCount: samples.filter((sample) => !sample.ok).length,
    minMs: durations.at(0) ?? null,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    maxMs: durations.at(-1) ?? null
  };
}

function percentile(values, percentileValue) {
  if (values.length === 0) {
    return null;
  }

  const index = Math.ceil(values.length * percentileValue) - 1;
  return values[Math.min(Math.max(index, 0), values.length - 1)];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function collectLogMetrics(envName, timeoutMs, artifactDir) {
  const result = await runCommand(`ocm logs ${envName} --tail 200`, { timeoutMs });
  const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const timestamps = collectTimestamps(text);
  const artifacts = [];
  if (artifactDir) {
    await mkdir(join(artifactDir, "collectors"), { recursive: true });
    const logPath = join(artifactDir, "collectors", "gateway-tail.log");
    await writeFile(logPath, text, "utf8");
    artifacts.push(logPath);
  }
  return {
    commandStatus: result.status,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    firstTimestamp: timestamps.first,
    lastTimestamp: timestamps.last,
    observedWindowMs: timestamps.windowMs,
    missingDependencyErrors: countPattern(text, /cannot find module|missing dependenc|missing runtime dep/i),
    pluginLoadFailures: countPattern(text, /\[plugins\].*failed to load|plugin.*failed to load/i),
    runtimeDependencyMentions: countPattern(text, /runtime dep|runtime dependency|runtime-deps/i),
    metadataScanMentions: countPattern(text, /collectBundledPluginMetadata|bundled plugin metadata|manifest read|readdirSync/i),
    configNormalizationMentions: countPattern(text, /config normal/i),
    gatewayRestartMentions: countPattern(text, /gateway.*restart|restart.*gateway|service restart|restarting/i),
    listeningMentions: countPattern(text, /listening|server started|gateway ready|ready on|websocket/i),
    providerLoadMentions: countPattern(text, /provider.*load|load.*provider|provider registry|auth provider/i),
    modelCatalogMentions: countPattern(text, /model catalog|models list|loading models|available models/i),
    providerTimeoutMentions: countPattern(text, /provider.*timeout|model.*timeout|timeout.*provider|timeout.*model/i),
    eventLoopDelayMentions: countPattern(text, /event loop|event-loop|blocked loop|loop delay/i),
    v8DiagnosticMentions: countPattern(text, /v8|diagnostic report|heapsnapshot|heap snapshot/i),
    errorMentions: countPattern(text, /\berror\b|exception|unhandled/i),
    structuredEvents: extractStructuredDiagnosticEvents(text),
    artifacts,
    stdoutSnippet: result.stdout.slice(-4000),
    stderrSnippet: result.stderr.slice(-4000)
  };
}

async function collectDiagnosticMetrics(envName, timeoutMs, artifactDir) {
  const command = "ocm env exec " + envName + " -- sh -lc 'find \"$OPENCLAW_HOME\" -maxdepth 6 -type f \\( -name \"report.*.json\" -o -name \"*.heapsnapshot\" -o -name \"*heap*.json\" -o -name \"*diagnostic*.json\" \\) -print 2>/dev/null | head -100'";
  const result = await runCommand(command, { timeoutMs, maxOutputChars: 100000 });
  const files = result.status === 0
    ? result.stdout.split("\n").map((line) => line.trim()).filter(Boolean)
    : [];
  const artifacts = [];

  let artifactBytes = 0;
  if (artifactDir && files.length > 0) {
    const diagnosticsDir = join(artifactDir, "diagnostics");
    await mkdir(diagnosticsDir, { recursive: true });
    for (const file of files.slice(0, 25)) {
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
    commandStatus: result.status,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    fileCount: files.length,
    v8ReportCount: files.filter((file) => /report\..*\.json$|diagnostic.*\.json$/i.test(file)).length,
    heapSnapshotCount: files.filter((file) => /\.heapsnapshot$|heap.*\.json$/i.test(file)).length,
    artifactBytes,
    files: files.slice(0, 25),
    artifacts,
    error: result.status === 0 ? null : firstOutputLine(result.stderr) || firstOutputLine(result.stdout) || "diagnostic artifact scan unavailable"
  };
}

async function collectNodeProfileMetrics(artifactDir) {
  const startedAt = Date.now();
  const profileDir = artifactDir ? join(artifactDir, "node-profiles") : null;
  if (!profileDir) {
    return {
      commandStatus: 0,
      statusLabel: "INFO",
      durationMs: 0,
      fileCount: 0,
      cpuProfileCount: 0,
      heapProfileCount: 0,
      traceEventCount: 0,
      artifactBytes: 0,
      artifacts: [],
      error: "artifact directory unavailable"
    };
  }

  let entries = [];
  try {
    entries = await readdir(profileDir, { withFileTypes: true });
  } catch (error) {
    if (error.code !== "ENOENT") {
      return {
        commandStatus: 0,
        statusLabel: "WARN",
        durationMs: Date.now() - startedAt,
        fileCount: 0,
        cpuProfileCount: 0,
        heapProfileCount: 0,
        traceEventCount: 0,
        artifactBytes: 0,
        artifacts: [],
        error: error.message
      };
    }
  }

  const artifacts = entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(profileDir, entry.name))
    .filter((path) => /\.(cpuprofile|heapprofile)$|node-trace.*\.(json|log)$/i.test(path))
    .slice(0, 100);

  let artifactBytes = 0;
  for (const artifact of artifacts) {
    artifactBytes += await fileSize(artifact);
  }

  return {
    commandStatus: 0,
    statusLabel: artifacts.length > 0 ? "PASS" : "INFO",
    durationMs: Date.now() - startedAt,
    fileCount: artifacts.length,
    cpuProfileCount: artifacts.filter((path) => /\.cpuprofile$/i.test(path)).length,
    heapProfileCount: artifacts.filter((path) => /\.heapprofile$/i.test(path)).length,
    traceEventCount: artifacts.filter((path) => /node-trace.*\.(json|log)$/i.test(path)).length,
    artifactBytes,
    artifacts,
    error: artifacts.length > 0 ? null : "node profile artifacts not emitted"
  };
}

async function triggerHeapSnapshot(envName, pid, timeoutMs, artifactDir) {
  const command = `ocm env exec ${envName} -- sh -lc 'kill -USR2 ${Number(pid)} 2>/dev/null || true; sleep 1; find "$OPENCLAW_HOME" -maxdepth 6 -type f -name "*.heapsnapshot" -print 2>/dev/null | head -25'`;
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
      const target = join(heapDir, basename(file));
      await cp(file, target, { force: true });
      artifactBytes += await fileSize(target);
      artifacts.push(target);
    }
  }

  return {
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

async function fileSize(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

function collectOpenClawDiagnostics(logs) {
  const events = logs?.structuredEvents ?? [];
  const startupEvents = events.filter((event) => event.category === "startup" || event.phase || event.startupPhase);
  const pluginEvents = events.filter((event) => event.category === "plugins" || event.plugin || event.pluginId);
  const configEvents = events.filter((event) => event.category === "config" || event.config || event.normalization);
  const runtimeDepEvents = events.filter((event) => event.category === "runtime-deps" || event.runtimeDeps || event.runtimeDependency);
  const providerEvents = events.filter((event) => event.category === "providers" || event.provider || event.modelProvider);
  const eventLoopEvents = events.filter((event) => event.eventLoopDelayMs !== undefined || event.eventLoop !== undefined);

  return {
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

function fallbackCount(logs, key) {
  const value = logs?.[key];
  return typeof value === "number" ? value : null;
}

function extractStructuredDiagnosticEvents(text) {
  const events = [];
  for (const line of text.split("\n")) {
    const candidate = line.slice(line.indexOf("{"));
    if (!candidate.startsWith("{")) {
      continue;
    }
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && (
        parsed.openclawDiagnostic === true ||
        parsed.diagnosticType ||
        parsed.category ||
        parsed.startupPhase ||
        parsed.eventLoopDelayMs !== undefined ||
        parsed.runtimeDepsStagingMs !== undefined
      )) {
        events.push(parsed);
      }
    } catch {
      // Non-JSON log lines are expected; structured diagnostics are optional.
    }
  }
  return events;
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

function collectTimestamps(text) {
  const values = [];
  const patterns = [
    /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\b/g,
    /\b(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?)\b/g
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const time = Date.parse(match[1].replace(" ", "T"));
      if (!Number.isNaN(time)) {
        values.push(time);
      }
    }
  }

  values.sort((a, b) => a - b);
  const first = values.at(0) ?? null;
  const last = values.at(-1) ?? null;
  return {
    first: first === null ? null : new Date(first).toISOString(),
    last: last === null ? null : new Date(last).toISOString(),
    windowMs: first !== null && last !== null ? last - first : null
  };
}

function countPattern(text, pattern) {
  let count = 0;
  for (const line of text.split("\n")) {
    if (pattern.test(line)) {
      count += 1;
    }
  }
  return count;
}

function firstOutputLine(value) {
  return value.trim().split("\n").find(Boolean);
}
