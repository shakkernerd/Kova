import { spawn, spawnSync } from "node:child_process";
import { startResourceSampler } from "./collectors/resources.mjs";
import { repoRoot } from "./paths.mjs";

const defaultCommandTimeoutMs = 120000;

export function checkCommand(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });

  return {
    command: [command, ...args].join(" "),
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
}

export function runCommand(command, options = {}) {
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
  const startedAtEpochMs = Date.now();
  const startedAt = new Date(startedAtEpochMs).toISOString();
  return new Promise((resolve) => {
    const shell = process.env.SHELL || "/bin/sh";
    const child = spawn(shell, ["-lc", command], {
      cwd: repoRoot,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"]
    });

    const sampler = options.resourceSample
      ? startResourceSampler(child.pid, {
        ...options.resourceSample,
        rootCommand: command
      })
      : null;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
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
      const finishedAtEpochMs = Date.now();
      settle({
        command: redact(command, options.redactValues),
        status: 127,
        signal: null,
        timedOut,
        startedAt,
        startedAtEpochMs,
        finishedAt: new Date(finishedAtEpochMs).toISOString(),
        finishedAtEpochMs,
        durationMs: finishedAtEpochMs - startedAtEpochMs,
        stdout: redact(stdout, options.redactValues),
        stderr: redact(error.message, options.redactValues)
      });
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      const finishedAtEpochMs = Date.now();
      settle({
        command: redact(command, options.redactValues),
        status: timedOut ? 124 : (status ?? 1),
        signal,
        timedOut,
        startedAt,
        startedAtEpochMs,
        finishedAt: new Date(finishedAtEpochMs).toISOString(),
        finishedAtEpochMs,
        durationMs: finishedAtEpochMs - startedAtEpochMs,
        stdout: truncate(redact(stdout, options.redactValues), options.maxOutputChars ?? 20000),
        stderr: truncate(redact(stderr, options.redactValues), options.maxOutputChars ?? 20000)
      });
    });

    async function settle(result) {
      if (settled) {
        return;
      }
      settled = true;
      if (sampler) {
        result.resourceSamples = await sampler.stop();
      }
      resolve(result);
    }
  });
}

export function quoteShell(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function normalizeTimeoutMs(value) {
  const timeoutMs = value === undefined ? defaultCommandTimeoutMs : Number(value);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error(`runCommand timeoutMs must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return timeoutMs;
}

function truncate(value, limit = 20000) {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit)}\n[truncated ${value.length - limit} chars]`;
}

function redact(value, secrets = []) {
  let output = String(value ?? "");
  for (const secret of secrets ?? []) {
    if (typeof secret !== "string" || secret.length === 0) {
      continue;
    }
    output = output.replaceAll(secret, "[REDACTED]");
  }
  return output;
}
