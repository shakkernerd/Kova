import { spawn, spawnSync } from "node:child_process";
import { startResourceSampler } from "./collectors/resources.mjs";
import { repoRoot } from "./paths.mjs";

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
  const startedAt = Date.now();
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
    }, options.timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      settle({
        command,
        status: 127,
        signal: null,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr: error.message
      });
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      settle({
        command,
        status: timedOut ? 124 : (status ?? 1),
        signal,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout: truncate(stdout, options.maxOutputChars ?? 20000),
        stderr: truncate(stderr, options.maxOutputChars ?? 20000)
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

function truncate(value, limit = 20000) {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit)}\n[truncated ${value.length - limit} chars]`;
}
