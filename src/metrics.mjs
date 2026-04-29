import { runCommand } from "./commands.mjs";

export async function collectEnvMetrics(envName, options = {}) {
  const timeoutMs = Math.min(options.timeoutMs ?? 10000, 10000);
  const healthSampleCount = Math.max(1, Number(options.healthSamples ?? 3));
  const healthIntervalMs = Math.max(0, Number(options.healthIntervalMs ?? 250));
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
    health: null,
    healthSamples: [],
    healthSummary: null,
    logs: null,
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
      metrics.health = await collectHealthMetrics(serviceJson.gatewayPort, timeoutMs);
      metrics.healthSamples = [metrics.health];
      metrics.healthSummary = summarizeHealthSamples(metrics.healthSamples);
    }
    metrics.logs = await collectLogMetrics(envName, timeoutMs);
    return metrics;
  }

  const process = await collectProcessMetrics(serviceJson.childPid, timeoutMs);
  metrics.process = process;
  if (serviceJson.gatewayPort) {
    metrics.healthSamples = await collectHealthSamples(serviceJson.gatewayPort, {
      count: healthSampleCount,
      intervalMs: healthIntervalMs,
      timeoutMs
    });
    metrics.health = metrics.healthSamples.at(-1) ?? null;
    metrics.healthSummary = summarizeHealthSamples(metrics.healthSamples);
  }
  metrics.logs = await collectLogMetrics(envName, timeoutMs);
  return metrics;
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
  return {
    commandStatus: result.status,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    missingDependencyErrors: countPattern(text, /cannot find module|missing dependenc|missing runtime dep/i),
    pluginLoadFailures: countPattern(text, /\[plugins\].*failed to load|plugin.*failed to load/i),
    runtimeDependencyMentions: countPattern(text, /runtime dep|runtime dependency|runtime-deps/i),
    metadataScanMentions: countPattern(text, /collectBundledPluginMetadata|bundled plugin metadata|manifest read|readdirSync/i),
    configNormalizationMentions: countPattern(text, /config normal/i),
    errorMentions: countPattern(text, /\berror\b|exception|unhandled/i),
    stdoutSnippet: result.stdout.slice(-4000),
    stderrSnippet: result.stderr.slice(-4000)
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
