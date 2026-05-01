#!/usr/bin/env node

import { spawn } from "node:child_process";

const options = parseArgs(process.argv.slice(2));
const envName = requiredString(options.env, "--env");
const count = positiveInteger(options.count ?? "3", "--count");
const sessionPrefix = requiredString(options.sessionPrefix ?? "kova-agent-concurrent", "--session-prefix");
const message = requiredString(options.message, "--message");
const expectedText = requiredString(options.expectedText ?? "KOVA_AGENT_OK", "--expected-text");
const timeoutSeconds = positiveInteger(options.timeout ?? "120", "--timeout");

if (!/^kova-[a-z0-9][a-z0-9-]*$/i.test(envName)) {
  failUsage(`refusing to run concurrent agent turns against non-Kova env: ${JSON.stringify(envName)}`);
}

const startedAtEpochMs = Date.now();
const startedAt = new Date(startedAtEpochMs).toISOString();
const turns = await Promise.all(
  Array.from({ length: count }, (_, index) => runTurn(index + 1))
);
const finishedAtEpochMs = Date.now();
const failed = turns.filter((turn) => turn.ok !== true);
const summary = {
  schemaVersion: "kova.concurrentAgentTurns.v1",
  ok: failed.length === 0,
  env: envName,
  count,
  successCount: turns.length - failed.length,
  failedCount: failed.length,
  expectedText,
  startedAt,
  startedAtEpochMs,
  finishedAt: new Date(finishedAtEpochMs).toISOString(),
  finishedAtEpochMs,
  durationMs: finishedAtEpochMs - startedAtEpochMs,
  finalAssistantVisibleText: failed.length === 0 ? expectedText : null,
  turns
};

process.stdout.write(`${JSON.stringify(summary)}\n`);
process.exit(summary.ok ? 0 : 1);

function runTurn(index) {
  const sessionId = `${sessionPrefix}-${index}`;
  const command = "ocm";
  const args = [
    `@${envName}`,
    "--",
    "agent",
    "--local",
    "--agent",
    "main",
    "--session-id",
    sessionId,
    "--message",
    message,
    "--thinking",
    "off",
    "--timeout",
    String(timeoutSeconds),
    "--json"
  ];
  const commandText = [command, ...args].join(" ");
  const turnStartedAtEpochMs = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      const turnFinishedAtEpochMs = Date.now();
      resolve({
        index,
        sessionId,
        ok: false,
        command: commandText,
        status: 127,
        signal: null,
        durationMs: turnFinishedAtEpochMs - turnStartedAtEpochMs,
        startedAt: new Date(turnStartedAtEpochMs).toISOString(),
        startedAtEpochMs: turnStartedAtEpochMs,
        finishedAt: new Date(turnFinishedAtEpochMs).toISOString(),
        finishedAtEpochMs: turnFinishedAtEpochMs,
        responseText: null,
        expectedTextPresent: false,
        error: error.message,
        stdout: "",
        stderr: truncate(error.message)
      });
    });
    child.on("close", (status, signal) => {
      const turnFinishedAtEpochMs = Date.now();
      const responseText = extractResponseText(stdout);
      const expectedTextPresent = responseText?.includes(expectedText) || stdout.includes(expectedText) || stderr.includes(expectedText);
      resolve({
        index,
        sessionId,
        ok: status === 0 && !signal && expectedTextPresent === true,
        command: commandText,
        status: status ?? 1,
        signal,
        durationMs: turnFinishedAtEpochMs - turnStartedAtEpochMs,
        startedAt: new Date(turnStartedAtEpochMs).toISOString(),
        startedAtEpochMs: turnStartedAtEpochMs,
        finishedAt: new Date(turnFinishedAtEpochMs).toISOString(),
        finishedAtEpochMs: turnFinishedAtEpochMs,
        responseText,
        expectedTextPresent,
        stdout: truncate(stdout),
        stderr: truncate(stderr)
      });
    });
  });
}

function extractResponseText(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    const found = findFirstString(parsed, [
      "finalAssistantVisibleText",
      "finalAssistantRawText",
      "text",
      "reply"
    ]);
    return typeof found === "string" && found.trim() ? found.trim() : null;
  } catch {
    const match = text.match(/"finalAssistant(?:Raw|Visible)Text"\s*:\s*"([^"]+)"/);
    return match?.[1]?.trim() ?? null;
  }
}

function findFirstString(value, keys) {
  if (!value || typeof value !== "object") {
    return null;
  }
  for (const key of keys) {
    if (typeof value[key] === "string") {
      return value[key];
    }
  }
  for (const child of Object.values(value)) {
    const nested = findFirstString(child, keys);
    if (typeof nested === "string") {
      return nested;
    }
  }
  return null;
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      failUsage(`unexpected positional argument ${JSON.stringify(arg)}`);
    }
    const key = arg.slice(2).replaceAll("-", "_");
    const next = args[index + 1];
    if (next === undefined || next.startsWith("--")) {
      failUsage(`${arg} requires a value`);
    }
    parsed[key] = next;
    index += 1;
  }
  return {
    env: parsed.env,
    count: parsed.count,
    sessionPrefix: parsed.session_prefix,
    message: parsed.message,
    expectedText: parsed.expected_text,
    timeout: parsed.timeout
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

function failUsage(message) {
  process.stderr.write(`${message}\n`);
  process.stderr.write("usage: run-concurrent-agent-turns.mjs --env <kova-env> --count <n> --message <text> [--expected-text <text>] [--session-prefix <prefix>] [--timeout <seconds>]\n");
  process.exit(2);
}
