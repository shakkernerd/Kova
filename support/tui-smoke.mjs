#!/usr/bin/env node

import { spawn } from "node:child_process";

const envName = process.argv[2];
const timeoutMs = Number(process.argv[3] ?? 15000);

if (!envName || !Number.isInteger(timeoutMs) || timeoutMs <= 0) {
  console.error("usage: tui-smoke.mjs <ocm-env> <timeout-ms>");
  process.exit(2);
}

const child = spawn("ocm", [
  `@${envName}`,
  "--",
  "tui",
  "--session",
  "kova-tui-smoke",
  "--history-limit",
  "5"
], {
  stdio: ["pipe", "pipe", "pipe"],
  shell: false
});

let output = "";
let settled = false;

const timer = setTimeout(() => {
  finish(false, `TUI did not render a recognizable connected screen within ${timeoutMs}ms`);
}, timeoutMs);

child.stdout.on("data", onData);
child.stderr.on("data", onData);

child.on("exit", (code, signal) => {
  if (settled) {
    return;
  }
  finish(false, `TUI exited before smoke check passed (code=${code}, signal=${signal ?? "none"})`);
});

child.on("error", (error) => {
  if (settled) {
    return;
  }
  finish(false, error.message);
});

function onData(chunk) {
  output += chunk.toString("utf8");
  if (/openclaw tui|session\s+main|session\s+kova-tui-smoke|local ready|agent\s+main/i.test(output)) {
    finish(true, "TUI rendered a recognizable connected screen");
  }
}

function finish(ok, message) {
  settled = true;
  clearTimeout(timer);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGINT");
  }
  console.log(message);
  if (!ok && output.trim()) {
    console.log(output.slice(-4000));
  }
  process.exit(ok ? 0 : 1);
}
