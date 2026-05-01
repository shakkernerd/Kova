#!/usr/bin/env node

import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SCHEMA_VERSION = "kova.mcpBridgeSmoke.v1";

const args = parseArgs(process.argv.slice(2));
const envName = requiredArg(args, "env");
const artifactDir = requiredArg(args, "artifact-dir");
const timeoutMs = positiveInt(args["timeout-ms"] ?? 30000, "timeout-ms");
assertKovaEnvName(envName);

const startedAtEpochMs = Date.now();
const summary = {
  schemaVersion: SCHEMA_VERSION,
  env: envName,
  startedAt: new Date(startedAtEpochMs).toISOString(),
  finishedAt: null,
  durationMs: null,
  gateway: null,
  initializeMs: null,
  toolsListMs: null,
  shutdownMs: null,
  toolCount: null,
  toolNames: [],
  processExited: false,
  exitStatus: null,
  exitSignal: null,
  errors: [],
  stderrSnippet: ""
};

let child;
let tokenFile;

try {
  const envInfo = await readOcmEnvInfo(envName, timeoutMs);
  const config = JSON.parse(await readFile(envInfo.configPath, "utf8"));
  const token = config?.gateway?.auth?.token;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error(`gateway.auth.token missing in ${envInfo.configPath}`);
  }

  await mkdir(artifactDir, { recursive: true });
  tokenFile = join(artifactDir, "mcp-gateway-token");
  await writeFile(tokenFile, token, { encoding: "utf8", mode: 0o600 });
  await chmod(tokenFile, 0o600);

  const gatewayPort = Number(envInfo.gatewayPort ?? config?.gateway?.port);
  if (!Number.isInteger(gatewayPort) || gatewayPort <= 0) {
    throw new Error("gateway port missing from OCM env metadata and OpenClaw config");
  }
  const gatewayUrl = `ws://127.0.0.1:${gatewayPort}`;
  summary.gateway = { port: gatewayPort, url: gatewayUrl };

  child = spawn("ocm", [
    `@${envName}`,
    "--",
    "mcp",
    "serve",
    "--url",
    gatewayUrl,
    "--token-file",
    tokenFile,
    "--claude-channel-mode",
    "off"
  ], {
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    env: process.env
  });

  const transport = createJsonLineTransport(child);
  await transport.waitForSpawn();

  const initializeStarted = Date.now();
  await transport.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "kova-mcp-bridge-smoke", version: "1.0.0" }
  }, timeoutMs);
  summary.initializeMs = Date.now() - initializeStarted;

  transport.notify("notifications/initialized", {});

  const listStarted = Date.now();
  const tools = await transport.request("tools/list", {}, timeoutMs);
  summary.toolsListMs = Date.now() - listStarted;
  const toolList = Array.isArray(tools?.tools) ? tools.tools : [];
  summary.toolCount = toolList.length;
  summary.toolNames = toolList.map((tool) => tool?.name).filter((name) => typeof name === "string").sort();

  const shutdownStarted = Date.now();
  child.stdin.end();
  const exit = await waitForExit(child, Math.min(timeoutMs, 5000));
  summary.shutdownMs = Date.now() - shutdownStarted;
  summary.processExited = true;
  summary.exitStatus = exit.status;
  summary.exitSignal = exit.signal;
} catch (error) {
  summary.errors.push(formatError(error));
  if (child && !summary.processExited) {
    child.kill("SIGTERM");
    try {
      const exit = await waitForExit(child, 3000);
      summary.processExited = true;
      summary.exitStatus = exit.status;
      summary.exitSignal = exit.signal;
    } catch {
      child.kill("SIGKILL");
    }
  }
} finally {
  if (child?.stderrText) {
    summary.stderrSnippet = child.stderrText.slice(-4000);
  }
  if (tokenFile) {
    await rm(tokenFile, { force: true });
  }
  const finishedAtEpochMs = Date.now();
  summary.finishedAt = new Date(finishedAtEpochMs).toISOString();
  summary.durationMs = finishedAtEpochMs - startedAtEpochMs;
  console.log(JSON.stringify(summary, null, 2));
}

process.exit(summary.errors.length === 0 && summary.processExited ? 0 : 1);

function createJsonLineTransport(processHandle) {
  let nextId = 1;
  let stdout = "";
  const pending = new Map();
  let spawnError;
  let spawned = false;

  processHandle.stderrText = "";

  processHandle.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
    for (;;) {
      const newline = stdout.indexOf("\n");
      if (newline < 0) {
        break;
      }
      const line = stdout.slice(0, newline).replace(/\r$/, "");
      stdout = stdout.slice(newline + 1);
      if (line.trim().length === 0) {
        continue;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const waiter = pending.get(message.id);
      if (!waiter) {
        continue;
      }
      pending.delete(message.id);
      if (message.error) {
        waiter.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      } else {
        waiter.resolve(message.result);
      }
    }
  });

  processHandle.stderr.on("data", (chunk) => {
    processHandle.stderrText += chunk.toString("utf8");
  });
  processHandle.stdin.on("error", (error) => {
    for (const waiter of pending.values()) {
      waiter.reject(error);
    }
    pending.clear();
  });

  processHandle.on("spawn", () => {
    spawned = true;
  });
  processHandle.on("error", (error) => {
    spawnError = error;
    for (const waiter of pending.values()) {
      waiter.reject(error);
    }
    pending.clear();
  });
  processHandle.on("exit", (status, signal) => {
    const error = new Error(`MCP bridge exited before reply (status=${status ?? "null"}, signal=${signal ?? "none"})`);
    for (const waiter of pending.values()) {
      waiter.reject(error);
    }
    pending.clear();
  });

  return {
    async waitForSpawn() {
      const deadline = Date.now() + 5000;
      while (!spawned) {
        if (spawnError) {
          throw spawnError;
        }
        if (Date.now() >= deadline) {
          throw new Error("MCP bridge process did not spawn");
        }
        await sleep(25);
      }
    },
    request(method, params, requestTimeoutMs) {
      const id = nextId;
      nextId += 1;
      const payload = { jsonrpc: "2.0", id, method, params };
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timed out after ${requestTimeoutMs}ms`));
        }, requestTimeoutMs);
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          }
        });
        processHandle.stdin.write(`${JSON.stringify(payload)}\n`);
      });
    },
    notify(method, params) {
      processHandle.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    }
  };
}

async function readOcmEnvInfo(env, timeoutMs) {
  const result = await runProcess("ocm", ["env", "show", env, "--json"], timeoutMs);
  if (result.status !== 0) {
    throw new Error(`ocm env show failed: ${firstLine(result.stderr) || firstLine(result.stdout) || result.status}`);
  }
  return JSON.parse(result.stdout);
}

function runProcess(command, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3000).unref();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
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

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ status: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`process did not exit within ${timeoutMs}ms`)), timeoutMs);
    child.once("exit", (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal });
    });
  });
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

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function firstLine(value) {
  return String(value ?? "").trim().split(/\r?\n/)[0] ?? "";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
