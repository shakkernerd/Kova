#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import {
  extractText,
  failJson,
  finishJson,
  importOpenClawDistModule,
  parseSupportArgs,
  readTimeoutMs,
  sleep
} from "./openclaw-runtime.mjs";

const startedAtEpochMs = Date.now();

try {
  const args = parseSupportArgs(process.argv.slice(2));
  const message = args.message ?? "Reply with exact ASCII text KOVA_AGENT_OK only.";
  const expectedText = args["expected-text"] ?? "KOVA_AGENT_OK";
  const timeoutMs = readTimeoutMs(args.timeout, 120000);
  const sessionKey = args["session-key"] ?? `kova-dashboard-${randomUUID()}`;
  const { callGateway } = await importOpenClawDistModule("gateway/call.js");

  const created = await callGateway({
    method: "sessions.create",
    params: {
      agentId: "main",
      key: sessionKey,
      label: "Kova Dashboard Session Send"
    },
    timeoutMs: Math.min(timeoutMs, 30000)
  });
  const canonicalKey = created?.key ?? sessionKey;
  const sendStartedAtEpochMs = Date.now();
  const sent = await callGateway({
    method: "sessions.send",
    params: {
      key: canonicalKey,
      message,
      thinking: "off",
      timeoutMs,
      idempotencyKey: `kova-dashboard-${randomUUID()}`
    },
    timeoutMs: Math.min(timeoutMs, 30000)
  });
  const runId = typeof sent?.runId === "string" ? sent.runId : null;

  const history = await waitForAssistantText({
    callGateway,
    sessionKey: canonicalKey,
    expectedText,
    timeoutMs,
    minAssistantCount: 1
  });

  finishJson({
    ok: true,
    surface: "dashboard-session-send-turn",
    method: "sessions.send",
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

async function waitForAssistantText({ callGateway, sessionKey, expectedText, timeoutMs, minAssistantCount }) {
  const deadline = Date.now() + timeoutMs;
  let lastAssistantText = "";
  let assistantTexts = [];
  while (Date.now() < deadline) {
    const history = await callGateway({
      method: "chat.history",
      params: { sessionKey, limit: 16 },
      timeoutMs: 15000
    });
    assistantTexts = extractAssistantTexts(history?.messages ?? []);
    lastAssistantText = assistantTexts.at(-1) ?? "";
    const matchedAssistantText = assistantTexts
      .slice(Math.max(0, minAssistantCount - 1))
      .find((text) => text.includes(expectedText));
    if (matchedAssistantText) {
      return { assistantTexts, lastAssistantText, matchedAssistantText };
    }
    await sleep(500);
  }
  throw new Error(
    `timed out waiting for dashboard assistant text ${JSON.stringify(expectedText)}; last=${JSON.stringify(lastAssistantText)}`
  );
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
