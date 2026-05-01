#!/usr/bin/env node

import { spawn } from "node:child_process";
import { failJson, finishJson, parseSupportArgs, readTimeoutMs } from "./openclaw-runtime.mjs";

const startedAtEpochMs = Date.now();

try {
  const args = parseSupportArgs(process.argv.slice(2));
  const envName = args.env;
  if (!envName) {
    throw new Error("--env is required");
  }
  const message = args.message ?? "Reply with exact ASCII text KOVA_AGENT_OK only.";
  const expectedText = args["expected-text"] ?? "KOVA_AGENT_OK";
  const timeoutMs = readTimeoutMs(args.timeout, 120000);
  const session = args.session ?? "kova-tui-message";
  const result = await runTuiTurn({ envName, message, expectedText, timeoutMs, session });
  finishJson({
    ok: true,
    surface: "tui-message-turn",
    method: "tui stdin/stdout",
    session,
    startedAtEpochMs,
    inputAcceptedAtEpochMs: result.inputAcceptedAtEpochMs,
    finishedAtEpochMs: Date.now(),
    finalAssistantVisibleText: result.finalAssistantText,
    finalAssistantRawText: result.finalAssistantText,
    expectedTextPresent: result.finalAssistantText.includes(expectedText),
    outputTail: result.outputTail
  });
} catch (error) {
  failJson(error, { surface: "tui-message-turn", finishedAtEpochMs: Date.now() });
}

function runTuiTurn({ envName, message, expectedText, timeoutMs, session }) {
  return new Promise((resolve, reject) => {
    const child = spawn("ocm", [
      `@${envName}`,
      "--",
      "tui",
      "--session",
      session,
      "--history-limit",
      "5"
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false
    });

    let output = "";
    let inputSent = false;
    let settled = false;
    let inputAcceptedAtEpochMs = null;

    const timer = setTimeout(() => {
      finish(new Error(`TUI turn did not complete within ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", finish);
    child.on("exit", (code, signal) => {
      if (!settled) {
        finish(new Error(`TUI exited before message turn completed (code=${code}, signal=${signal ?? "none"})`));
      }
    });

    function onData(chunk) {
      output += chunk.toString("utf8");
      if (!inputSent && /openclaw tui|local ready|agent\s+main|session\s+/i.test(output)) {
        inputSent = true;
        inputAcceptedAtEpochMs = Date.now();
        child.stdin.write(`${message}\n`);
      }
      if (output.includes(expectedText)) {
        finish(null, {
          inputAcceptedAtEpochMs,
          finalAssistantText: expectedText,
          outputTail: output.slice(-4000)
        });
      }
    }

    function finish(error, value) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGINT");
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
          }
        }, 1000).unref?.();
      }
      if (error) {
        reject(new Error(`${error.message}; outputTail=${JSON.stringify(output.slice(-4000))}`));
      } else {
        resolve(value);
      }
    }
  });
}
