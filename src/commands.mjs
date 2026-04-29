import { spawn, spawnSync } from "node:child_process";
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

export function runCommand(command, options) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn("zsh", ["-lc", command], {
      cwd: repoRoot,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
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
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolve({
        command,
        status: timedOut ? 124 : (status ?? 1),
        signal,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout: truncate(stdout),
        stderr: truncate(stderr)
      });
    });
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

