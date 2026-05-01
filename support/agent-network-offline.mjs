#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const options = parseArgs(process.argv.slice(2));
const envName = requiredString(options.env, "--env");
const artifactDir = requiredString(options.artifactDir, "--artifact-dir");
const timeoutSeconds = positiveInteger(options.timeoutSeconds ?? "20", "--timeout-seconds");
const maxCommandMs = positiveInteger(options.maxCommandMs ?? "45000", "--max-command-ms");
const networkFailurePattern = /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|fetch failed|network|connection refused|provider.*fail|failed to fetch|socket/i;

if (!/^kova-[a-z0-9][a-z0-9-]*$/i.test(envName)) {
  failUsage(`refusing to run network offline smoke against non-Kova env: ${JSON.stringify(envName)}`);
}

await fs.mkdir(artifactDir, { recursive: true });
const networkDir = path.join(artifactDir, "network-offline");
await fs.mkdir(networkDir, { recursive: true });

const configure = await run("ocm", [
  "env",
  "exec",
  envName,
  "--",
  "node",
  supportPath("configure-openclaw-provider-blackhole.mjs")
], { timeoutMs: 15000 });

const startedAtEpochMs = Date.now();
const startedAt = new Date(startedAtEpochMs).toISOString();
const agent = await run("ocm", [
  `@${envName}`,
  "--",
  "agent",
  "--local",
  "--agent",
  "main",
  "--session-id",
  "kova-agent-network-offline",
  "--message",
  "Reply with exact ASCII text KOVA_AGENT_OK only.",
  "--thinking",
  "off",
  "--timeout",
  String(timeoutSeconds),
  "--json"
], { timeoutMs: maxCommandMs + 3000 });
const finishedAtEpochMs = Date.now();

const status = await run("ocm", [`@${envName}`, "--", "status"], { timeoutMs: 15000 });
const combinedOutput = `${agent.stdout}\n${agent.stderr}`;
const networkFailureObserved = agent.status !== 0 &&
  networkFailurePattern.test(combinedOutput);
const statusWorks = status.status === 0 && status.timedOut !== true;
const ok = configure.status === 0 && networkFailureObserved && agent.timedOut !== true && statusWorks;
const summary = {
  schemaVersion: "kova.agentNetworkOffline.v1",
  ok,
  env: envName,
  timeoutSeconds,
  maxCommandMs,
  startedAt,
  startedAtEpochMs,
  finishedAt: new Date(finishedAtEpochMs).toISOString(),
  finishedAtEpochMs,
  durationMs: finishedAtEpochMs - startedAtEpochMs,
  networkTurnMs: agent.durationMs,
  networkFailureObserved,
  networkCommandTimedOut: agent.timedOut === true,
  networkCommandStatus: agent.status,
  networkStatusAfterFailureMs: status.durationMs,
  gatewayStatusWorks: statusWorks,
  configureStatus: configure.status,
  errors: [
    ...(configure.status === 0 ? [] : [`configure failed: ${snippet(configure.stderr || configure.stdout)}`]),
    ...(networkFailureObserved ? [] : [`network failure not observed: status=${agent.status} timedOut=${agent.timedOut} duration=${agent.durationMs} stderr=${snippet(agent.stderr)}`]),
    ...(agent.timedOut ? [`network failure command did not exit before ${maxCommandMs}ms; stderr=${snippet(agent.stderr)}`] : []),
    ...(statusWorks ? [] : [`status after network failure failed: status=${status.status} stderr=${snippet(status.stderr || status.stdout)}`])
  ],
  commands: {
    configure: compactCommand(configure),
    agent: compactCommand(agent),
    status: compactCommand(status)
  }
};

await fs.writeFile(path.join(networkDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(summary)}\n`);
process.exit(ok ? 0 : 1);

function run(command, args, options = {}) {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3000).unref();
    }, options.timeoutMs ?? 30000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        command: [command, ...args].join(" "),
        status: 127,
        signal: null,
        timedOut,
        durationMs: Date.now() - started,
        stdout: "",
        stderr: error.message
      });
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolve({
        command: [command, ...args].join(" "),
        status: timedOut ? 124 : (status ?? 1),
        signal,
        timedOut,
        durationMs: Date.now() - started,
        stdout: truncate(stdout),
        stderr: truncate(stderr)
      });
    });
  });
}

function compactCommand(result) {
  return {
    command: result.command,
    status: result.status,
    signal: result.signal,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    stdout: truncate(result.stdout, 1200),
    stderr: truncate(result.stderr, 1200)
  };
}

function supportPath(file) {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), file);
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      failUsage(`unexpected positional argument ${JSON.stringify(arg)}`);
    }
    const key = arg.slice(2).replaceAll("-", "_");
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      failUsage(`${arg} requires a value`);
    }
    parsed[key] = value;
    index += 1;
  }
  return {
    env: parsed.env,
    artifactDir: parsed.artifact_dir,
    timeoutSeconds: parsed.timeout_seconds,
    maxCommandMs: parsed.max_command_ms
  };
}

function requiredString(value, flag) {
  if (typeof value !== "string" || value.length === 0) {
    failUsage(`${flag} is required`);
  }
  return value;
}

function positiveInteger(value, flag) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    failUsage(`${flag} must be a positive integer`);
  }
  return number;
}

function truncate(value, limit = 4000) {
  const text = String(value ?? "");
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}\n[truncated ${text.length - limit} chars]`;
}

function snippet(value) {
  return truncate(String(value ?? "").replace(/\s+/g, " ").trim(), 500);
}

function failUsage(message) {
  process.stderr.write(`${message}\n`);
  process.stderr.write("usage: agent-network-offline.mjs --env <kova-env> --artifact-dir <dir> [--timeout-seconds <seconds>] [--max-command-ms <ms>]\n");
  process.exit(2);
}
