#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SCHEMA_VERSION = "kova.browserAutomationSmoke.v1";

const args = parseArgs(process.argv.slice(2));
const envName = requiredArg(args, "env");
const artifactDir = requiredArg(args, "artifact-dir");
const timeoutMs = positiveInt(args["timeout-ms"] ?? 45000, "timeout-ms");
const profile = args.profile ?? "openclaw";
assertKovaEnvName(envName);

const startedAtEpochMs = Date.now();
const summary = {
  schemaVersion: SCHEMA_VERSION,
  env: envName,
  profile,
  startedAt: new Date(startedAtEpochMs).toISOString(),
  finishedAt: null,
  durationMs: null,
  browserDoctorMs: null,
  browserStartMs: null,
  browserTabsMs: null,
  browserOpenMs: null,
  browserSnapshotMs: null,
  browserStopMs: null,
  browserTabCount: null,
  browserSnapshotOk: false,
  browserStopped: false,
  commands: [],
  errors: []
};

try {
  await mkdir(artifactDir, { recursive: true });

  const doctor = await runBrowserCommand("doctor", ["doctor"], { allowFailure: true });
  summary.browserDoctorMs = doctor.durationMs;

  const start = await runBrowserCommand("start", ["start", "--headless"]);
  summary.browserStartMs = start.durationMs;

  const open = await runBrowserCommand("open", ["open", "about:blank", "--label", "kova-smoke"]);
  summary.browserOpenMs = open.durationMs;

  const tabs = await runBrowserCommand("tabs", ["tabs"]);
  summary.browserTabsMs = tabs.durationMs;
  summary.browserTabCount = countTabs(tabs);

  const snapshot = await runBrowserCommand("snapshot", ["snapshot"]);
  summary.browserSnapshotMs = snapshot.durationMs;
  summary.browserSnapshotOk = snapshot.status === 0;
} catch (error) {
  summary.errors.push(formatError(error));
} finally {
  try {
    const stop = await runBrowserCommand("stop", ["stop"], { allowFailure: true });
    summary.browserStopMs = stop.durationMs;
    summary.browserStopped = stop.status === 0;
  } catch (error) {
    summary.errors.push(`browser stop failed: ${formatError(error)}`);
  }
  const finishedAtEpochMs = Date.now();
  summary.finishedAt = new Date(finishedAtEpochMs).toISOString();
  summary.durationMs = finishedAtEpochMs - startedAtEpochMs;
  await writeFile(join(artifactDir, "browser-automation-smoke.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(summary, null, 2));
}

process.exit(summary.errors.length === 0 && summary.browserStopped ? 0 : 1);

async function runBrowserCommand(label, browserArgs, options = {}) {
  const result = await runProcess("ocm", [
    `@${envName}`,
    "--",
    "browser",
    "--json",
    "--browser-profile",
    profile,
    ...browserArgs
  ], timeoutMs);
  const commandRecord = {
    label,
    args: ["browser", "--json", "--browser-profile", profile, ...browserArgs],
    status: result.status,
    signal: result.signal,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    stdoutPath: join(artifactDir, `browser-${safeSegment(label)}.stdout.txt`),
    stderrPath: join(artifactDir, `browser-${safeSegment(label)}.stderr.txt`),
    stdoutSnippet: result.stdout.slice(0, 4000),
    stderrSnippet: result.stderr.slice(0, 4000),
    parsed: parseJsonOutput(result.stdout)
  };
  await writeFile(commandRecord.stdoutPath, result.stdout, "utf8");
  await writeFile(commandRecord.stderrPath, result.stderr, "utf8");
  summary.commands.push(commandRecord);

  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`${label} failed: ${firstLine(result.stderr) || firstLine(result.stdout) || result.status}`);
  }
  return commandRecord;
}

function runProcess(command, values, commandTimeoutMs) {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, values, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3000).unref();
    }, commandTimeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        status: 127,
        signal: null,
        timedOut,
        durationMs: Date.now() - started,
        stdout,
        stderr: error.message
      });
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolve({
        status: timedOut ? 124 : (status ?? 1),
        signal,
        timedOut,
        durationMs: Date.now() - started,
        stdout,
        stderr
      });
    });
  });
}

function countTabs(result) {
  const parsed = result.parsed;
  if (Array.isArray(parsed)) {
    return parsed.length;
  }
  if (Array.isArray(parsed?.tabs)) {
    return parsed.tabs.length;
  }
  const text = `${result.stdoutSnippet}\n${result.stderrSnippet}`;
  const matches = text.match(/\bt\d+\b/g);
  return matches ? new Set(matches).size : null;
}

function parseJsonOutput(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) {
      throw new Error(`unexpected positional argument '${value}'`);
    }
    const key = value.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) {
      throw new Error(`missing value for --${key}`);
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

function requiredArg(values, key) {
  const value = values[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`missing --${key}`);
  }
  return value;
}

function positiveInt(value, key) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`--${key} must be a positive integer`);
  }
  return number;
}

function assertKovaEnvName(value) {
  if (!/^kova-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(`unsafe Kova env name '${value}'`);
  }
}

function safeSegment(value) {
  return String(value ?? "command").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "command";
}

function firstLine(value) {
  return String(value ?? "").trim().split(/\r?\n/)[0] ?? "";
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
