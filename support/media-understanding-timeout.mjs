#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const options = parseArgs(process.argv.slice(2));
const envName = requiredString(options.env, "--env");
const artifactDir = requiredString(options.artifactDir, "--artifact-dir");
const timeoutMs = positiveInteger(options.timeoutMs ?? "1200", "--timeout-ms");
const maxCommandMs = positiveInteger(options.maxCommandMs ?? "10000", "--max-command-ms");
const expectedPattern = /timeout|timed out|abort|aborted|deadline/i;

if (!/^kova-[a-z0-9][a-z0-9-]*$/i.test(envName)) {
  failUsage(`refusing to run media understanding smoke against non-Kova env: ${JSON.stringify(envName)}`);
}

await fs.mkdir(artifactDir, { recursive: true });
const mediaDir = path.join(artifactDir, "media-understanding");
await fs.mkdir(mediaDir, { recursive: true });
const imagePath = path.join(mediaDir, "kova-timeout.png");
await fs.writeFile(imagePath, Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64"
));

const configure = await run("ocm", [
  "env",
  "exec",
  envName,
  "--",
  "node",
  supportPath("configure-openclaw-media-understanding.mjs"),
  "--timeout-ms",
  String(timeoutMs)
], { timeoutMs: 15000 });

const startedAtEpochMs = Date.now();
const startedAt = new Date(startedAtEpochMs).toISOString();
const describe = await run("ocm", [
  `@${envName}`,
  "--",
  "capability",
  "image",
  "describe",
  "--file",
  imagePath,
  "--model",
  "openai/gpt-5.5",
  "--prompt",
  "Reply with exact ASCII text KOVA_AGENT_OK only.",
  "--timeout-ms",
  String(timeoutMs),
  "--json"
], { timeoutMs: maxCommandMs + 3000 });
const finishedAtEpochMs = Date.now();

const status = await run("ocm", [`@${envName}`, "--", "status"], { timeoutMs: 15000 });
const timeoutObserved = describe.status !== 0 &&
  describe.timedOut !== true &&
  describe.durationMs <= maxCommandMs &&
  expectedPattern.test(`${describe.stdout}\n${describe.stderr}`);
const statusWorks = status.status === 0 && status.timedOut !== true;
const ok = configure.status === 0 && timeoutObserved && statusWorks;
const summary = {
  schemaVersion: "kova.mediaUnderstandingTimeout.v1",
  ok,
  env: envName,
  imagePath,
  timeoutMs,
  maxCommandMs,
  startedAt,
  startedAtEpochMs,
  finishedAt: new Date(finishedAtEpochMs).toISOString(),
  finishedAtEpochMs,
  durationMs: finishedAtEpochMs - startedAtEpochMs,
  mediaDescribeMs: describe.durationMs,
  mediaTimeoutObserved: timeoutObserved,
  mediaCommandTimedOut: describe.timedOut === true,
  mediaCommandStatus: describe.status,
  mediaStatusAfterTimeoutMs: status.durationMs,
  gatewayStatusWorks: statusWorks,
  configureStatus: configure.status,
  errors: [
    ...(configure.status === 0 ? [] : [`configure failed: ${snippet(configure.stderr || configure.stdout)}`]),
    ...(timeoutObserved ? [] : [`media timeout not observed: status=${describe.status} timedOut=${describe.timedOut} duration=${describe.durationMs} stderr=${snippet(describe.stderr)}`]),
    ...(statusWorks ? [] : [`status after media timeout failed: status=${status.status} stderr=${snippet(status.stderr || status.stdout)}`])
  ],
  commands: {
    configure: compactCommand(configure),
    describe: compactCommand(describe),
    status: compactCommand(status)
  }
};

await fs.writeFile(path.join(mediaDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
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
    timeoutMs: parsed.timeout_ms,
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
  process.stderr.write("usage: media-understanding-timeout.mjs --env <kova-env> --artifact-dir <dir> [--timeout-ms <ms>] [--max-command-ms <ms>]\n");
  process.exit(2);
}
