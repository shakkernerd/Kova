import { runCommand } from "./commands.mjs";
import { createConnection } from "node:net";

export async function collectEnvMetrics(envName, options = {}) {
  const timeoutMs = Math.min(options.timeoutMs ?? 10000, 10000);
  const healthSampleCount = Math.max(1, Number(options.healthSamples ?? 3));
  const healthIntervalMs = Math.max(0, Number(options.healthIntervalMs ?? 250));
  const readinessTimeoutMs = Math.min(
    Math.max(0, Number(options.readinessTimeoutMs ?? 0)),
    Math.max(timeoutMs, Number(options.timeoutMs ?? timeoutMs))
  );
  const readinessIntervalMs = Math.max(50, Number(options.readinessIntervalMs ?? 250));
  const service = await runCommand(`ocm service status ${envName} --json`, { timeoutMs });
  const metrics = {
    collectedAt: new Date().toISOString(),
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
    error: null
  };

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
      metrics.readiness = await collectReadinessMetrics(serviceJson.gatewayPort, {
        timeoutMs: readinessTimeoutMs,
        intervalMs: readinessIntervalMs,
        probeTimeoutMs: timeoutMs
      });
      metrics.listening = metrics.readiness.listening;
      metrics.health = metrics.readiness.health;
      metrics.healthSamples = metrics.readiness.healthAttempts;
      metrics.healthSummary = summarizeHealthSamples(metrics.healthSamples);
    }
    metrics.logs = await collectLogMetrics(envName, timeoutMs);
    metrics.diagnostics = await collectDiagnosticMetrics(envName, timeoutMs);
    return metrics;
  }

  const process = await collectProcessMetrics(serviceJson.childPid, timeoutMs);
  metrics.process = process;
  if (serviceJson.gatewayPort) {
    metrics.readiness = await collectReadinessMetrics(serviceJson.gatewayPort, {
      timeoutMs: readinessTimeoutMs,
      intervalMs: readinessIntervalMs,
      probeTimeoutMs: timeoutMs
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
  metrics.logs = await collectLogMetrics(envName, timeoutMs);
  metrics.diagnostics = await collectDiagnosticMetrics(envName, timeoutMs);
  return metrics;
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

async function collectLogMetrics(envName, timeoutMs) {
  const result = await runCommand(`ocm logs ${envName} --tail 200`, { timeoutMs });
  const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const timestamps = collectTimestamps(text);
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
    stdoutSnippet: result.stdout.slice(-4000),
    stderrSnippet: result.stderr.slice(-4000)
  };
}

async function collectDiagnosticMetrics(envName, timeoutMs) {
  const command = "ocm env exec " + envName + " -- sh -lc 'find \"$OPENCLAW_HOME\" -maxdepth 6 -type f \\( -name \"report.*.json\" -o -name \"*.heapsnapshot\" -o -name \"*heap*.json\" -o -name \"*diagnostic*.json\" \\) -print 2>/dev/null | head -100'";
  const result = await runCommand(command, { timeoutMs, maxOutputChars: 100000 });
  const files = result.status === 0
    ? result.stdout.split("\n").map((line) => line.trim()).filter(Boolean)
    : [];

  return {
    commandStatus: result.status,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    fileCount: files.length,
    v8ReportCount: files.filter((file) => /report\..*\.json$|diagnostic.*\.json$/i.test(file)).length,
    heapSnapshotCount: files.filter((file) => /\.heapsnapshot$|heap.*\.json$/i.test(file)).length,
    files: files.slice(0, 25),
    error: result.status === 0 ? null : firstOutputLine(result.stderr) || firstOutputLine(result.stdout) || "diagnostic artifact scan unavailable"
  };
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
