import { createConnection } from "node:net";

export const READINESS_SCHEMA = "kova.readiness.v1";
export const HEALTH_SAMPLES_SCHEMA = "kova.healthSamples.v1";

export async function collectReadinessMetrics(port, options) {
  const startedAt = Date.now();
  const deadline = startedAt + options.timeoutMs;
  const thresholdMs = Math.max(0, Number(options.thresholdMs ?? options.timeoutMs ?? 0));
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
    schemaVersion: READINESS_SCHEMA,
    deadlineMs: options.timeoutMs,
    thresholdMs,
    intervalMs: options.intervalMs,
    attempts: Math.max(listeningAttempts.length, healthAttempts.length),
    ready: healthReadyAtMs !== null,
    listeningReady: listeningReadyAtMs !== null,
    listeningReadyAtMs,
    healthReadyAtMs,
    classification: classifyReadiness({
      thresholdMs,
      listeningReadyAtMs,
      healthReadyAtMs
    }),
    listening: lastListening,
    health: lastHealth,
    listeningAttempts,
    healthAttempts
  };
}

export function classifyReadiness({ thresholdMs, listeningReadyAtMs, healthReadyAtMs }) {
  if (listeningReadyAtMs === null) {
    return {
      state: "hard-failure",
      severity: "fail",
      reason: "gateway TCP socket never accepted connections before the hard deadline"
    };
  }
  if (healthReadyAtMs === null) {
    return {
      state: "unhealthy",
      severity: "fail",
      reason: "gateway TCP socket opened but health never became ready before the hard deadline"
    };
  }
  if (thresholdMs > 0 && healthReadyAtMs > thresholdMs) {
    return {
      state: "slow-startup",
      severity: "fail",
      reason: `gateway became healthy after ${healthReadyAtMs}ms, beyond the ${thresholdMs}ms threshold`
    };
  }
  return {
    state: "ready",
    severity: "pass",
    reason: "gateway became healthy within the readiness threshold"
  };
}

export function collectListeningMetrics(port, timeoutMs) {
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

export async function collectHealthMetrics(port, timeoutMs) {
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

export async function collectHealthSamples(port, options) {
  const samples = [];
  for (let index = 0; index < options.count; index += 1) {
    samples.push(await collectHealthMetrics(port, options.timeoutMs));
    if (index < options.count - 1 && options.intervalMs > 0) {
      await sleep(options.intervalMs);
    }
  }
  return samples;
}

export function summarizeHealthSamples(samples) {
  if (!Array.isArray(samples) || samples.length === 0) {
    return null;
  }

  const durations = samples.map((sample) => sample.durationMs).filter((duration) => typeof duration === "number").sort((a, b) => a - b);
  return {
    schemaVersion: HEALTH_SAMPLES_SCHEMA,
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
