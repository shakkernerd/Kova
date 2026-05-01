import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { collectorArtifactDirs } from "./artifacts.mjs";

export const PROVIDER_EVIDENCE_SCHEMA = "kova.providerEvidence.v1";

export async function collectProviderEvidence(artifactDir, options = {}) {
  const startedAt = Date.now();
  const requestLogPath = options.requestLogPath ?? join(artifactDir, "mock-openai", "requests.jsonl");
  const timelinePath = options.timelinePath ?? join(artifactDir, "openclaw", "timeline.jsonl");
  const authMode = options.authPolicy?.mode ?? options.authMode ?? null;
  const dirs = collectorArtifactDirs(artifactDir);
  const summaryPath = join(dirs.provider, "provider-evidence.json");
  const evidence = {
    schemaVersion: PROVIDER_EVIDENCE_SCHEMA,
    collectedAt: new Date().toISOString(),
    available: false,
    source: null,
    authMode,
    deterministic: authMode === "mock",
    environmentDependent: authMode === "live",
    requestLogPath,
    timelinePath,
    summaryPath,
    requestCount: 0,
    firstRequestStartAt: null,
    firstRequestStartEpochMs: null,
    lastResponseEndAt: null,
    lastResponseEndEpochMs: null,
    providerDurationMs: null,
    firstByteLatencyMs: null,
    firstChunkLatencyMs: null,
    routes: [],
    models: [],
    statuses: [],
    errors: [],
    requests: [],
    artifacts: [],
    commandStatus: 0,
    durationMs: 0,
    error: null
  };

  try {
    const text = await readFile(requestLogPath, "utf8");
    const parsed = parseProviderRequestLog(text);
    Object.assign(evidence, parsed, {
      source: "mock-provider-log",
      available: parsed.requestCount > 0,
      artifacts: [requestLogPath, summaryPath]
    });
  } catch (error) {
    if (error.code === "ENOENT") {
      await applyTimelineProviderEvidence(evidence, timelinePath, summaryPath);
    } else {
      evidence.error = error.message;
      evidence.commandStatus = 1;
      evidence.statusLabel = "WARN";
    }
  }

  evidence.durationMs = Date.now() - startedAt;
  await mkdir(dirs.provider, { recursive: true });
  await writeFile(summaryPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  if (!evidence.artifacts.includes(summaryPath)) {
    evidence.artifacts.push(summaryPath);
  }
  return evidence;
}

async function applyTimelineProviderEvidence(evidence, timelinePath, summaryPath) {
  try {
    const text = await readFile(timelinePath, "utf8");
    const parsed = parseTimelineProviderRequestLog(text);
    Object.assign(evidence, parsed, {
      source: "openclaw-timeline",
      available: parsed.requestCount > 0,
      artifacts: parsed.requestCount > 0 ? [timelinePath, summaryPath] : []
    });
    if (parsed.requestCount === 0) {
      evidence.error = "provider request log not found and OpenClaw timeline contained no provider.request events";
      evidence.statusLabel = "INFO";
    }
  } catch (timelineError) {
    if (timelineError.code === "ENOENT") {
      evidence.error = "provider request log not found";
      evidence.statusLabel = "INFO";
      evidence.artifacts = [];
      return;
    }
    evidence.error = timelineError.message;
    evidence.commandStatus = 1;
    evidence.statusLabel = "WARN";
  }
}

export function parseProviderRequestLog(text) {
  const requests = [];
  const parseErrors = [];
  const lines = String(text ?? "").split(/\r?\n/);

  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    try {
      const raw = JSON.parse(line);
      requests.push(normalizeProviderRequest(raw, index + 1));
    } catch (error) {
      parseErrors.push({
        kind: "parse",
        line: index + 1,
        error: error.message
      });
    }
  }

  const sorted = requests
    .filter((request) => typeof request.receivedAtEpochMs === "number")
    .toSorted((left, right) => left.receivedAtEpochMs - right.receivedAtEpochMs);
  const first = sorted[0] ?? null;
  const last = sorted
    .filter((request) => typeof request.respondedAtEpochMs === "number")
    .toSorted((left, right) => left.respondedAtEpochMs - right.respondedAtEpochMs)
    .at(-1) ?? null;
  const firstByte = sorted
    .filter((request) => typeof request.firstByteLatencyMs === "number")
    .toSorted((left, right) => left.firstByteLatencyMs - right.firstByteLatencyMs)[0] ?? null;
  const firstChunk = sorted
    .filter((request) => typeof request.firstChunkLatencyMs === "number")
    .toSorted((left, right) => left.firstChunkLatencyMs - right.firstChunkLatencyMs)[0] ?? null;

  return {
    requestCount: requests.length,
    firstRequestStartAt: first?.receivedAt ?? null,
    firstRequestStartEpochMs: first?.receivedAtEpochMs ?? null,
    lastResponseEndAt: last?.respondedAt ?? null,
    lastResponseEndEpochMs: last?.respondedAtEpochMs ?? null,
    providerDurationMs: first && last ? Math.max(0, last.respondedAtEpochMs - first.receivedAtEpochMs) : null,
    firstByteLatencyMs: firstByte?.firstByteLatencyMs ?? null,
    firstChunkLatencyMs: firstChunk?.firstChunkLatencyMs ?? null,
    routes: summarizeBy(requests, "route"),
    models: summarizeBy(requests, "model"),
    modes: summarizeBy(requests, "mode"),
    outcomes: summarizeBy(requests, "outcome"),
    errorClasses: summarizeBy(requests, "errorClass"),
    statuses: summarizeBy(requests, "status"),
    errors: [...parseErrors, ...requestErrors(requests)],
    requests
  };
}

export function parseTimelineProviderRequestLog(text) {
  const requests = [];
  const parseErrors = [];
  for (const [index, rawLine] of String(text ?? "").split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    try {
      const event = JSON.parse(line);
      if (!event || typeof event !== "object" || Array.isArray(event)) {
        parseErrors.push({ kind: "parse", line: index + 1, error: "event is not an object" });
        continue;
      }
      if (event.type !== "provider.request" && event.name !== "provider.request") {
        continue;
      }
      requests.push(normalizeTimelineProviderRequest(event, index + 1));
    } catch (error) {
      parseErrors.push({
        kind: "parse",
        line: index + 1,
        error: error.message
      });
    }
  }
  const summary = summarizeProviderRequests(requests);
  return {
    ...summary,
    errors: [...parseErrors, ...summary.errors],
    requests
  };
}

export function computeProviderTurnAttribution(result, providerEvidence) {
  if (!result) {
    return null;
  }
  const commandStartedAt = result.startedAtEpochMs;
  const commandFinishedAt = result.finishedAtEpochMs;
  const requests = providerEvidence?.available === true
    ? requestsWithinCommand(providerEvidence.requests ?? [], commandStartedAt, commandFinishedAt)
    : [];
  const firstRequest = requests[0] ?? null;
  const lastResponse = requests
    .filter((request) => typeof request.respondedAtEpochMs === "number")
    .toSorted((left, right) => left.respondedAtEpochMs - right.respondedAtEpochMs)
    .at(-1) ?? null;
  const firstProviderRequestAt = firstRequest?.receivedAtEpochMs;
  const lastProviderResponseAt = lastResponse?.respondedAtEpochMs;
  if (![commandStartedAt, commandFinishedAt, firstProviderRequestAt, lastProviderResponseAt].every((value) => typeof value === "number")) {
    return {
      schemaVersion: "kova.providerTurnAttribution.v1",
      command: result.command,
      commandStartedAt: result.startedAt,
      commandStartedAtEpochMs: commandStartedAt,
      commandFinishedAt: result.finishedAt,
      commandFinishedAtEpochMs: commandFinishedAt,
      totalTurnMs: typeof commandStartedAt === "number" && typeof commandFinishedAt === "number" ? Math.max(0, commandFinishedAt - commandStartedAt) : null,
      preProviderMs: null,
      providerFinalMs: null,
      postProviderMs: null,
      firstProviderRequestAt: null,
      firstProviderRequestAtEpochMs: null,
      lastProviderResponseAt: null,
      lastProviderResponseAtEpochMs: null,
      requestCount: 0,
      firstByteLatencyMs: null,
      firstChunkLatencyMs: null,
      routes: [],
      models: [],
      statuses: [],
      modes: [],
      outcomes: [],
      errorClasses: [],
      errors: [],
      providerDominates: null,
      preProviderDominates: null,
      missingProviderRequest: true,
      providerEvidenceAvailable: providerEvidence?.available === true
    };
  }
  const firstByte = requests
    .filter((request) => typeof request.firstByteLatencyMs === "number")
    .toSorted((left, right) => left.firstByteLatencyMs - right.firstByteLatencyMs)[0] ?? null;
  const firstChunk = requests
    .filter((request) => typeof request.firstChunkLatencyMs === "number")
    .toSorted((left, right) => left.firstChunkLatencyMs - right.firstChunkLatencyMs)[0] ?? null;
  return {
    schemaVersion: "kova.providerTurnAttribution.v1",
    command: result.command,
    commandStartedAt: result.startedAt,
    commandStartedAtEpochMs: commandStartedAt,
    commandFinishedAt: result.finishedAt,
    commandFinishedAtEpochMs: commandFinishedAt,
    totalTurnMs: Math.max(0, commandFinishedAt - commandStartedAt),
    preProviderMs: Math.max(0, firstProviderRequestAt - commandStartedAt),
    providerFinalMs: Math.max(0, lastProviderResponseAt - firstProviderRequestAt),
    postProviderMs: Math.max(0, commandFinishedAt - lastProviderResponseAt),
    firstProviderRequestAt: firstRequest.receivedAt,
    firstProviderRequestAtEpochMs: firstProviderRequestAt,
    lastProviderResponseAt: lastResponse.respondedAt,
    lastProviderResponseAtEpochMs: lastProviderResponseAt,
    requestCount: requests.length,
    firstByteLatencyMs: firstByte?.firstByteLatencyMs ?? null,
    firstChunkLatencyMs: firstChunk?.firstChunkLatencyMs ?? null,
    routes: summarizeBy(requests, "route"),
    models: summarizeBy(requests, "model"),
    statuses: summarizeBy(requests, "status"),
    modes: summarizeBy(requests, "mode"),
    outcomes: summarizeBy(requests, "outcome"),
    errorClasses: summarizeBy(requests, "errorClass"),
    errors: requestErrors(requests),
    providerDominates: dominanceRatio(Math.max(0, lastProviderResponseAt - firstProviderRequestAt), Math.max(0, commandFinishedAt - commandStartedAt)),
    preProviderDominates: dominanceRatio(Math.max(0, firstProviderRequestAt - commandStartedAt), Math.max(0, commandFinishedAt - commandStartedAt)),
    missingProviderRequest: false,
    providerEvidenceAvailable: true
  };
}

function requestsWithinCommand(requests, commandStartedAt, commandFinishedAt) {
  if (typeof commandStartedAt !== "number" || typeof commandFinishedAt !== "number") {
    return [];
  }
  return requests
    .filter((request) =>
      typeof request.receivedAtEpochMs === "number" &&
      request.receivedAtEpochMs >= commandStartedAt &&
      request.receivedAtEpochMs <= commandFinishedAt
    )
    .toSorted((left, right) => left.receivedAtEpochMs - right.receivedAtEpochMs);
}

function normalizeTimelineProviderRequest(event, line) {
  const receivedAtEpochMs = numberOrParsedTime(event.receivedAtEpochMs, event.receivedAt ?? event.timestamp ?? event.time);
  const durationMs = numberOrNull(event.durationMs ?? event.elapsedMs ?? event.ms);
  const respondedAtEpochMs = numberOrParsedTime(event.respondedAtEpochMs, event.respondedAt) ??
    (typeof receivedAtEpochMs === "number" && typeof durationMs === "number" ? receivedAtEpochMs + durationMs : null);
  const provider = event.provider ?? event.attributes?.provider ?? null;
  const operation = event.operation ?? event.attributes?.operation ?? null;
  const route = event.route ?? event.path ?? operation ?? "provider.request";
  const ok = typeof event.ok === "boolean" ? event.ok : event.status === undefined || Number(event.status) < 400;
  return {
    schemaVersion: "kova.provider.request.fromTimeline.v1",
    line,
    requestId: event.requestId ?? event.spanId ?? `timeline-provider-${line}`,
    receivedAt: event.receivedAt ?? event.timestamp ?? isoOrNull(receivedAtEpochMs),
    receivedAtEpochMs,
    respondedAt: event.respondedAt ?? isoOrNull(respondedAtEpochMs),
    respondedAtEpochMs,
    durationMs: durationMs ?? durationBetween(receivedAtEpochMs, respondedAtEpochMs),
    firstByteAt: null,
    firstByteAtEpochMs: null,
    firstByteLatencyMs: null,
    firstChunkAt: null,
    firstChunkAtEpochMs: null,
    firstChunkLatencyMs: null,
    method: event.method ?? null,
    mode: event.mode ?? null,
    behavior: event.behavior ?? event.mode ?? null,
    outcome: event.outcome ?? (ok ? "completed" : "error"),
    errorClass: event.errorClass ?? (ok ? null : "provider-error"),
    providerCallIndex: numberOrNull(event.providerCallIndex),
    route,
    path: event.path ?? route,
    operation,
    provider,
    model: event.model ?? event.modelId ?? event.attributes?.model ?? null,
    stream: typeof event.stream === "boolean" ? event.stream : null,
    status: numberOrNull(event.status),
    statusClass: typeof event.status === "number" ? `${Math.floor(event.status / 100)}xx` : null,
    bodyBytes: null,
    parseError: null
  };
}

function summarizeProviderRequests(requests) {
  const sorted = requests
    .filter((request) => typeof request.receivedAtEpochMs === "number")
    .toSorted((left, right) => left.receivedAtEpochMs - right.receivedAtEpochMs);
  const first = sorted[0] ?? null;
  const last = sorted
    .filter((request) => typeof request.respondedAtEpochMs === "number")
    .toSorted((left, right) => left.respondedAtEpochMs - right.respondedAtEpochMs)
    .at(-1) ?? null;
  const firstByte = sorted
    .filter((request) => typeof request.firstByteLatencyMs === "number")
    .toSorted((left, right) => left.firstByteLatencyMs - right.firstByteLatencyMs)[0] ?? null;
  const firstChunk = sorted
    .filter((request) => typeof request.firstChunkLatencyMs === "number")
    .toSorted((left, right) => left.firstChunkLatencyMs - right.firstChunkLatencyMs)[0] ?? null;

  return {
    requestCount: requests.length,
    firstRequestStartAt: first?.receivedAt ?? null,
    firstRequestStartEpochMs: first?.receivedAtEpochMs ?? null,
    lastResponseEndAt: last?.respondedAt ?? null,
    lastResponseEndEpochMs: last?.respondedAtEpochMs ?? null,
    providerDurationMs: first && last ? Math.max(0, last.respondedAtEpochMs - first.receivedAtEpochMs) : null,
    firstByteLatencyMs: firstByte?.firstByteLatencyMs ?? null,
    firstChunkLatencyMs: firstChunk?.firstChunkLatencyMs ?? null,
    routes: summarizeBy(requests, "route"),
    models: summarizeBy(requests, "model"),
    modes: summarizeBy(requests, "mode"),
    outcomes: summarizeBy(requests, "outcome"),
    errorClasses: summarizeBy(requests, "errorClass"),
    statuses: summarizeBy(requests, "status"),
    errors: requestErrors(requests)
  };
}

function normalizeProviderRequest(raw, line) {
  const receivedAtEpochMs = numberOrParsedTime(raw.receivedAtEpochMs, raw.receivedAt);
  const respondedAtEpochMs = numberOrParsedTime(raw.respondedAtEpochMs, raw.respondedAt);
  const firstByteAtEpochMs = numberOrParsedTime(raw.firstByteAtEpochMs, raw.firstByteAt);
  const firstChunkAtEpochMs = numberOrParsedTime(raw.firstChunkAtEpochMs, raw.firstChunkAt);
  const route = raw.route ?? raw.path ?? null;
  return {
    schemaVersion: raw.schemaVersion ?? "kova.mockProvider.request.legacy",
    line,
    requestId: raw.requestId ?? `${basename(route ?? "request")}-${line}`,
    receivedAt: raw.receivedAt ?? isoOrNull(receivedAtEpochMs),
    receivedAtEpochMs,
    respondedAt: raw.respondedAt ?? isoOrNull(respondedAtEpochMs),
    respondedAtEpochMs,
    durationMs: numberOrNull(raw.durationMs) ?? durationBetween(receivedAtEpochMs, respondedAtEpochMs),
    firstByteAt: raw.firstByteAt ?? isoOrNull(firstByteAtEpochMs),
    firstByteAtEpochMs,
    firstByteLatencyMs: numberOrNull(raw.firstByteLatencyMs) ?? durationBetween(receivedAtEpochMs, firstByteAtEpochMs),
    firstChunkAt: raw.firstChunkAt ?? isoOrNull(firstChunkAtEpochMs),
    firstChunkAtEpochMs,
    firstChunkLatencyMs: numberOrNull(raw.firstChunkLatencyMs) ?? durationBetween(receivedAtEpochMs, firstChunkAtEpochMs),
    method: raw.method ?? null,
    mode: raw.mode ?? raw.behavior ?? null,
    behavior: raw.behavior ?? raw.mode ?? null,
    outcome: raw.outcome ?? null,
    errorClass: raw.errorClass ?? null,
    providerCallIndex: numberOrNull(raw.providerCallIndex),
    route,
    path: raw.path ?? route,
    model: raw.model ?? modelFromBody(raw.body),
    stream: typeof raw.stream === "boolean" ? raw.stream : streamFromBody(raw.body),
    status: numberOrNull(raw.status),
    statusClass: raw.statusClass ?? (typeof raw.status === "number" ? `${Math.floor(raw.status / 100)}xx` : null),
    bodyBytes: numberOrNull(raw.bodyBytes) ?? (typeof raw.body === "string" ? Buffer.byteLength(raw.body) : null),
    parseError: raw.parseError ?? null
  };
}

function summarizeBy(requests, key) {
  const counts = new Map();
  for (const request of requests) {
    const value = request[key] ?? "unknown";
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .toSorted((left, right) => right.count - left.count || String(left.value).localeCompare(String(right.value)));
}

function requestErrors(requests) {
  const errors = [];
  for (const request of requests) {
    if (typeof request.status === "number" && request.status >= 400) {
      errors.push({
        kind: "http",
        line: request.line,
        requestId: request.requestId,
        route: request.route,
        status: request.status,
        statusClass: request.statusClass
      });
    }
    if (request.errorClass) {
      errors.push({
        kind: request.errorClass,
        line: request.line,
        requestId: request.requestId,
        route: request.route,
        status: request.status,
        mode: request.mode,
        outcome: request.outcome
      });
    }
    if (request.outcome === "aborted") {
      errors.push({
        kind: "provider-aborted",
        line: request.line,
        requestId: request.requestId,
        route: request.route,
        status: request.status,
        mode: request.mode
      });
    }
    if (request.parseError) {
      errors.push({
        kind: "body-parse",
        line: request.line,
        requestId: request.requestId,
        route: request.route,
        error: request.parseError
      });
    }
  }
  return errors;
}

function modelFromBody(body) {
  const parsed = parseBody(body);
  return typeof parsed?.model === "string" ? parsed.model : null;
}

function streamFromBody(body) {
  const parsed = parseBody(body);
  return typeof parsed?.stream === "boolean" ? parsed.stream : null;
}

function parseBody(body) {
  if (typeof body !== "string" || body.length === 0) {
    return null;
  }
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function durationBetween(start, end) {
  return typeof start === "number" && typeof end === "number" ? Math.max(0, end - start) : null;
}

function numberOrParsedTime(numberValue, dateValue) {
  return numberOrNull(numberValue) ?? parseTime(dateValue);
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseTime(value) {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isoOrNull(epochMs) {
  return typeof epochMs === "number" ? new Date(epochMs).toISOString() : null;
}

function dominanceRatio(part, total) {
  if (typeof part !== "number" || typeof total !== "number" || total <= 0) {
    return null;
  }
  return Math.round((part / total) * 1000) / 1000;
}
