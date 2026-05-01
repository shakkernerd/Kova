#!/usr/bin/env node
import { spawn } from "node:child_process";

const SCHEMA_VERSION = "kova.soakLoop.v1";

const args = parseArgs(process.argv.slice(2));
const envName = requiredArg(args, "env");
assertKovaEnvName(envName);

const durationMs = positiveInt(args["duration-ms"] ?? 60000, "duration-ms");
const intervalMs = nonNegativeInt(args["interval-ms"] ?? 1000, "interval-ms");
const commandTimeoutMs = positiveInt(args["timeout-ms"] ?? 30000, "timeout-ms");
const startedAtEpochMs = Date.now();
const startedAt = new Date(startedAtEpochMs).toISOString();
const deadline = startedAtEpochMs + durationMs;
const commandRuns = [];
const healthSamples = [];
const errors = [];

const commandPlan = [
  { id: "status", command: "ocm", args: [`@${envName}`, "--", "status"] },
  { id: "plugins-list", command: "ocm", args: [`@${envName}`, "--", "plugins", "list"] },
  { id: "models-list", command: "ocm", args: [`@${envName}`, "--", "models", "list"] }
];

let iteration = 0;
do {
  iteration += 1;
  for (const planned of commandPlan) {
    commandRuns.push(await runTimedCommand(planned, commandTimeoutMs, iteration));
  }
  healthSamples.push(await collectGatewayHealth(envName, commandTimeoutMs, iteration));
  if (Date.now() < deadline && intervalMs > 0) {
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }
} while (Date.now() < deadline);

const finishedAtEpochMs = Date.now();
const result = {
  schemaVersion: SCHEMA_VERSION,
  env: envName,
  startedAt,
  finishedAt: new Date(finishedAtEpochMs).toISOString(),
  durationMs: finishedAtEpochMs - startedAtEpochMs,
  requestedDurationMs: durationMs,
  intervalMs,
  iterations: iteration,
  commandSummary: summarizeCommands(commandRuns),
  healthSummary: summarizeHealth(healthSamples),
  commandRuns,
  healthSamples,
  errors
};

console.log(JSON.stringify(result, null, 2));
process.exit(commandRuns.every((run) => run.status === 0 && run.timedOut !== true) ? 0 : 1);

async function collectGatewayHealth(env, timeoutMs, iterationIndex) {
  const status = await runProcess("ocm", ["service", "status", env, "--json"], timeoutMs);
  const base = {
    iteration: iterationIndex,
    serviceStatus: status.status,
    durationMs: null,
    ok: false,
    status: null,
    error: null
  };

  if (status.status !== 0) {
    return {
      ...base,
      error: firstLine(status.stderr) || firstLine(status.stdout) || "ocm service status failed"
    };
  }

  let service;
  try {
    service = JSON.parse(status.stdout);
  } catch (error) {
    return {
      ...base,
      error: `service status JSON parse failed: ${error.message}`
    };
  }

  if (!service.gatewayPort) {
    return {
      ...base,
      error: "gateway port missing from service status"
    };
  }

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, 5000));
  try {
    const response = await fetch(`http://127.0.0.1:${Number(service.gatewayPort)}/health`, {
      signal: controller.signal
    });
    await response.text();
    return {
      ...base,
      gatewayPort: Number(service.gatewayPort),
      ok: response.ok,
      status: response.status,
      durationMs: Date.now() - started
    };
  } catch (error) {
    return {
      ...base,
      gatewayPort: Number(service.gatewayPort),
      durationMs: Date.now() - started,
      error: error.name === "AbortError" ? "health request timed out" : error.message
    };
  } finally {
    clearTimeout(timer);
  }
}

async function runTimedCommand(planned, timeoutMs, iterationIndex) {
  const startedAtEpochMs = Date.now();
  const result = await runProcess(planned.command, planned.args, timeoutMs);
  const finishedAtEpochMs = Date.now();
  return {
    id: planned.id,
    iteration: iterationIndex,
    command: [planned.command, ...planned.args].join(" "),
    startedAt: new Date(startedAtEpochMs).toISOString(),
    finishedAt: new Date(finishedAtEpochMs).toISOString(),
    durationMs: finishedAtEpochMs - startedAtEpochMs,
    status: result.status,
    signal: result.signal,
    timedOut: result.timedOut,
    stdoutSnippet: result.stdout.slice(-500),
    stderrSnippet: result.stderr.slice(-500)
  };
}

function runProcess(command, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3000).unref();
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ status: 127, signal: null, timedOut, stdout, stderr: error.message });
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ status: timedOut ? 124 : (status ?? 1), signal, timedOut, stdout, stderr });
    });
  });
}

function summarizeCommands(runs) {
  const byId = {};
  for (const id of [...new Set(runs.map((run) => run.id))].sort()) {
    const matching = runs.filter((run) => run.id === id);
    const durations = matching.map((run) => run.durationMs).filter(isNumber).sort((a, b) => a - b);
    byId[id] = {
      count: matching.length,
      okCount: matching.filter((run) => run.status === 0 && run.timedOut !== true).length,
      failureCount: matching.filter((run) => run.status !== 0 || run.timedOut === true).length,
      p50Ms: percentile(durations, 0.5),
      p95Ms: percentile(durations, 0.95),
      maxMs: durations.at(-1) ?? null
    };
  }
  const durations = runs.map((run) => run.durationMs).filter(isNumber).sort((a, b) => a - b);
  return {
    count: runs.length,
    okCount: runs.filter((run) => run.status === 0 && run.timedOut !== true).length,
    failureCount: runs.filter((run) => run.status !== 0 || run.timedOut === true).length,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    maxMs: durations.at(-1) ?? null,
    byId
  };
}

function summarizeHealth(samples) {
  const durations = samples.map((sample) => sample.durationMs).filter(isNumber).sort((a, b) => a - b);
  return {
    count: samples.length,
    okCount: samples.filter((sample) => sample.ok === true).length,
    failureCount: samples.filter((sample) => sample.ok !== true).length,
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

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) {
      throw new Error(`unexpected argument ${value}`);
    }
    const key = value.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

function requiredArg(argsObject, name) {
  const value = argsObject[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`--${name} is required`);
  }
  return value;
}

function positiveInt(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return number;
}

function nonNegativeInt(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`--${name} must be a non-negative integer`);
  }
  return number;
}

function assertKovaEnvName(value) {
  if (!/^kova-[a-z0-9][a-z0-9-]*$/i.test(value)) {
    throw new Error(`refusing to run soak loop against non-Kova env '${value}'`);
  }
}

function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function firstLine(value) {
  return String(value ?? "").trim().split(/\r?\n/).find(Boolean);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
