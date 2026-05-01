#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import {
  extractText,
  failJson,
  finishJson,
  parseSupportArgs,
  prepareOpenClawRuntimeFromOcmEnv,
  readTimeoutMs,
  runOcmJson,
  sleep
} from "./openclaw-runtime.mjs";

const startedAtEpochMs = Date.now();

try {
  const args = parseSupportArgs(process.argv.slice(2));
  const runtimeContext = prepareOpenClawRuntimeFromOcmEnv(args.env);
  const message = args.message ?? "Reply with exact ASCII text KOVA_AGENT_OK only.";
  const expectedText = args["expected-text"] ?? "KOVA_AGENT_OK";
  const timeoutMs = readTimeoutMs(args.timeout, 120000);
  const sessionKey = args["session-key"] ?? `kova-dashboard-${randomUUID()}`;

  const created = gatewayCall(runtimeContext.envName, "sessions.create", {
      agentId: "main",
      key: sessionKey,
      label: "Kova Dashboard Session Send"
    }, Math.min(timeoutMs, 30000));
  const canonicalKey = created?.key ?? sessionKey;
  const sendStartedAtEpochMs = Date.now();
  const sent = gatewayCall(runtimeContext.envName, "sessions.send", {
      key: canonicalKey,
      message,
      thinking: "off",
      timeoutMs,
      idempotencyKey: `kova-dashboard-${randomUUID()}`
    }, Math.min(timeoutMs, 30000));
  const runId = typeof sent?.runId === "string" ? sent.runId : null;

  const history = await waitForAssistantText({
    envName: runtimeContext.envName,
    sessionKey: canonicalKey,
    expectedText,
    timeoutMs,
    minAssistantCount: 1
  });

  finishJson({
    ok: true,
    surface: "dashboard-session-send-turn",
    method: "sessions.send",
    envName: runtimeContext.envName,
    runtime: runtimeContext.runtime,
    sessionKey: canonicalKey,
    runId,
    startedAtEpochMs,
    sendStartedAtEpochMs,
    finishedAtEpochMs: Date.now(),
    finalAssistantVisibleText: history.matchedAssistantText,
    finalAssistantRawText: history.lastAssistantText,
    assistantMessageCount: history.assistantTexts.length,
    expectedTextPresent: history.matchedAssistantText.includes(expectedText)
  });
} catch (error) {
  failJson(error, { surface: "dashboard-session-send-turn", finishedAtEpochMs: Date.now() });
}

async function waitForAssistantText({ envName, sessionKey, expectedText, timeoutMs, minAssistantCount }) {
  const deadline = Date.now() + timeoutMs;
  let lastAssistantText = "";
  let lastHistoryError = null;
  let assistantTexts = [];
  while (Date.now() < deadline) {
    try {
      const history = gatewayCall(envName, "chat.history", { sessionKey, limit: 16 }, Math.min(15000, Math.max(1000, deadline - Date.now())));
      lastHistoryError = null;
      assistantTexts = extractAssistantTexts(history?.messages ?? []);
      lastAssistantText = assistantTexts.at(-1) ?? "";
      const matchedAssistantText = assistantTexts
        .slice(Math.max(0, minAssistantCount - 1))
        .find((text) => text.includes(expectedText));
      if (matchedAssistantText) {
        return { assistantTexts, lastAssistantText, matchedAssistantText };
      }
    } catch (error) {
      lastHistoryError = error;
    }
    await sleep(500);
  }
  throw new Error(
    `timed out waiting for dashboard assistant text ${JSON.stringify(expectedText)}; last=${JSON.stringify(lastAssistantText)}; lastHistoryError=${JSON.stringify(lastHistoryError?.message ?? null)}`
  );
}

function gatewayCall(envName, method, params, timeoutMs) {
  return runOcmJson([
    `@${envName}`,
    "--",
    "gateway",
    "call",
    method,
    "--params",
    JSON.stringify(params),
    "--timeout",
    String(timeoutMs),
    "--json"
  ]);
}

function extractAssistantTexts(messages) {
  if (!Array.isArray(messages)) {
    return [];
  }
  return messages
    .filter((message) => {
      const role = String(message?.role ?? message?.sender ?? message?.type ?? "").toLowerCase();
      return role.includes("assistant") || role.includes("agent");
    })
    .map((message) => extractText(message))
    .map((text) => text.trim())
    .filter(Boolean);
}
