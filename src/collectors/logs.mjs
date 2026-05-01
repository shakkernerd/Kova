import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCommand } from "../commands.mjs";
import { ocmLogs } from "../ocm/commands.mjs";

export const LOG_METRICS_SCHEMA = "kova.logMetrics.v1";

export async function collectLogMetrics(envName, timeoutMs, artifactDir) {
  const result = await runCommand(ocmLogs(envName, { tail: 200 }), { timeoutMs });
  const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const timestamps = collectTimestamps(text);
  const artifacts = [];
  if (artifactDir) {
    await mkdir(join(artifactDir, "collectors"), { recursive: true });
    const logPath = join(artifactDir, "collectors", "gateway-tail.log");
    await writeFile(logPath, text, "utf8");
    artifacts.push(logPath);
  }
  return {
    schemaVersion: LOG_METRICS_SCHEMA,
    commandStatus: result.status,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    firstTimestamp: timestamps.first,
    lastTimestamp: timestamps.last,
    observedWindowMs: timestamps.windowMs,
    missingDependencyErrors: countPattern(text, /cannot find (module|package)|missing dependenc|missing runtime dep/i),
    pluginLoadFailures: countPattern(text, /\[plugins\].*failed to load|plugin.*failed to load|\[plugins\].*plugin service failed|plugin service failed/i),
    runtimeDependencyMentions: countPattern(text, /runtime dep|runtime dependency|runtime-deps/i),
    metadataScanMentions: countPattern(text, /collectBundledPluginMetadata|bundled plugin metadata|manifest read|readdirSync/i),
    configNormalizationMentions: countPattern(text, /config normal/i),
    gatewayRestartMentions: countPattern(text, /gateway.*restart|restart.*gateway|service restart|restarting/i),
    listeningMentions: countPattern(text, /listening|server started|gateway ready|ready on|websocket/i),
    providerLoadMentions: countPattern(text, /provider.*load|load.*provider|provider registry|auth provider/i),
    modelCatalogMentions: countPattern(text, /model catalog|models list|loading models|available models/i),
    providerTimeoutMentions: countPattern(text, /provider.*timeout|model.*timeout|timeout.*provider|timeout.*model/i),
    eventLoopDelayMentions: countPattern(text, /event loop|event-loop|blocked loop|loop delay/i),
    v8DiagnosticMentions: countPattern(text, /v8|diagnostic report|heapsnapshot|heap snapshot/i),
    errorMentions: countPattern(text, /\berror\b|exception|unhandled/i),
    runtimeDeps: summarizeRuntimeDepsLogs(text),
    embeddedRuns: summarizeEmbeddedRunTraces(text),
    livenessWarnings: summarizeLivenessWarnings(text),
    structuredEvents: extractStructuredDiagnosticEvents(text),
    artifacts,
    stdoutSnippet: result.stdout.slice(-4000),
    stderrSnippet: result.stderr.slice(-4000)
  };
}

export function summarizeEmbeddedRunTraces(text) {
  const events = parseEmbeddedRunTraceEvents(text);
  const stageTotals = {};
  let totalMaxMs = null;

  for (const event of events) {
    totalMaxMs = maxNumber(totalMaxMs, event.totalMs);
    for (const stage of event.stages) {
      const current = stageTotals[stage.name] ?? {
        name: stage.name,
        count: 0,
        totalDurationMs: 0,
        maxDurationMs: null,
        maxOffsetMs: null,
        traceKinds: []
      };
      current.count += 1;
      current.totalDurationMs = round(current.totalDurationMs + stage.durationMs);
      current.maxDurationMs = maxNumber(current.maxDurationMs, stage.durationMs);
      current.maxOffsetMs = maxNumber(current.maxOffsetMs, stage.offsetMs);
      current.traceKinds = [...new Set([...current.traceKinds, event.traceKind])].sort();
      stageTotals[stage.name] = current;
    }
  }

  const topStages = Object.values(stageTotals)
    .toSorted((left, right) => (right.totalDurationMs - left.totalDurationMs) || left.name.localeCompare(right.name))
    .slice(0, 12);

  return {
    schemaVersion: "kova.embeddedRunTraceSummary.v1",
    available: events.length > 0,
    eventCount: events.length,
    startupCount: events.filter((event) => event.traceKind === "startup").length,
    prepCount: events.filter((event) => event.traceKind === "prep").length,
    totalMaxMs,
    stageTotals,
    topStages,
    events: events.slice(-20)
  };
}

export function parseEmbeddedRunTraceEvents(text) {
  const events = [];
  const tracePattern = /\[agent\/embedded\]\s+\[trace:embedded-run\]\s+([a-z0-9_-]+)\s+stages:\s+runId=([^\s]+)\s+sessionId=([^\s]+)\s+phase=([^\s]+)\s+totalMs=(\d+(?:\.\d+)?)\s+stages=(.*)$/i;
  for (const [index, line] of String(text ?? "").split(/\r?\n/).entries()) {
    const match = line.match(tracePattern);
    if (!match) {
      continue;
    }
    const stages = [];
    const stageText = match[6] ?? "";
    const stagePattern = /([^:,]+):(\d+(?:\.\d+)?)ms@(\d+(?:\.\d+)?)ms/g;
    for (const stageMatch of stageText.matchAll(stagePattern)) {
      stages.push({
        name: stageMatch[1],
        durationMs: Number(stageMatch[2]),
        offsetMs: Number(stageMatch[3])
      });
    }
    events.push({
      kind: "embedded-run-trace",
      line: index + 1,
      traceKind: match[1],
      runId: match[2],
      sessionId: match[3],
      phase: match[4],
      totalMs: Number(match[5]),
      stages,
      text: compactLine(line)
    });
  }
  return events;
}

export function summarizeLivenessWarnings(text) {
  const events = parseLivenessWarningEvents(text);
  return {
    schemaVersion: "kova.livenessWarningSummary.v1",
    available: events.length > 0,
    count: events.length,
    maxEventLoopDelayP99Ms: numericMax(events, "eventLoopDelayP99Ms"),
    maxEventLoopDelayMaxMs: numericMax(events, "eventLoopDelayMaxMs"),
    maxEventLoopUtilization: numericMax(events, "eventLoopUtilization"),
    maxCpuCoreRatio: numericMax(events, "cpuCoreRatio"),
    events: events.slice(-20)
  };
}

export function parseLivenessWarningEvents(text) {
  const events = [];
  for (const [index, line] of String(text ?? "").split(/\r?\n/).entries()) {
    if (!/\[diagnostic\]\s+liveness warning:/i.test(line)) {
      continue;
    }
    events.push({
      kind: "liveness-warning",
      line: index + 1,
      reasons: parseReasonList(extractValue(line, "reasons")),
      intervalMs: numberFromValue(extractValue(line, "interval")),
      eventLoopDelayP99Ms: numberFromValue(extractValue(line, "eventLoopDelayP99Ms")),
      eventLoopDelayMaxMs: numberFromValue(extractValue(line, "eventLoopDelayMaxMs")),
      eventLoopUtilization: numberFromValue(extractValue(line, "eventLoopUtilization")),
      cpuCoreRatio: numberFromValue(extractValue(line, "cpuCoreRatio")),
      active: numberFromValue(extractValue(line, "active")),
      waiting: numberFromValue(extractValue(line, "waiting")),
      queued: numberFromValue(extractValue(line, "queued")),
      text: compactLine(line)
    });
  }
  return events;
}

export function summarizeRuntimeDepsLogs(text) {
  const events = parseRuntimeDepsLogEvents(text);
  const installEvents = events.filter((event) => event.kind === "install");
  const stageEvents = events.filter((event) => event.kind === "stage");
  const postbuildEvents = events.filter((event) => event.kind === "postbuild");

  return {
    schemaVersion: "kova.runtimeDepsLogSummary.v1",
    eventCount: events.length,
    stageCount: stageEvents.length,
    installCount: installEvents.length,
    installMaxMs: maxDuration(installEvents),
    postbuildCount: postbuildEvents.length,
    postbuildMaxMs: maxDuration(postbuildEvents),
    pluginIds: [...new Set(events.map((event) => event.pluginId).filter(Boolean))].sort(),
    events: events.slice(0, 50)
  };
}

export function parseRuntimeDepsLogEvents(text) {
  const events = [];
  for (const [index, line] of String(text ?? "").split(/\r?\n/).entries()) {
    const stage = line.match(/\[plugins\]\s+([a-z0-9._-]+)\s+staging bundled runtime deps\s+\((\d+)\s+specs?\)/i);
    if (stage) {
      events.push({
        kind: "stage",
        line: index + 1,
        pluginId: stage[1],
        dependencyCount: Number(stage[2]),
        durationMs: null,
        text: compactLine(line)
      });
      continue;
    }

    const install = line.match(/\[plugins\]\s+([a-z0-9._-]+)\s+installed bundled runtime deps in\s+(\d+(?:\.\d+)?)ms/i);
    if (install) {
      events.push({
        kind: "install",
        line: index + 1,
        pluginId: install[1],
        dependencyCount: null,
        durationMs: Number(install[2]),
        text: compactLine(line)
      });
      continue;
    }

    const postbuild = line.match(/runtime-postbuild:\s+bundled plugin runtime deps completed in\s+(\d+(?:\.\d+)?)ms/i);
    if (postbuild) {
      events.push({
        kind: "postbuild",
        line: index + 1,
        pluginId: "postbuild",
        dependencyCount: null,
        durationMs: Number(postbuild[1]),
        text: compactLine(line)
      });
    }
  }
  return events;
}

export function collectTimestamps(text) {
  const values = [];
  const patterns = [
    /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\b/g,
    /\b(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?)\b/g
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const time = Date.parse(match[1].replace(" ", "T"));
      if (!Number.isNaN(time)) {
        values.push(time);
      }
    }
  }

  values.sort((a, b) => a - b);
  const first = values.at(0) ?? null;
  const last = values.at(-1) ?? null;
  return {
    first: first === null ? null : new Date(first).toISOString(),
    last: last === null ? null : new Date(last).toISOString(),
    windowMs: first !== null && last !== null ? last - first : null
  };
}

export function extractStructuredDiagnosticEvents(text) {
  const events = [];
  for (const line of text.split("\n")) {
    const candidate = line.slice(line.indexOf("{"));
    if (!candidate.startsWith("{")) {
      continue;
    }
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && (
        parsed.openclawDiagnostic === true ||
        parsed.diagnosticType ||
        parsed.category ||
        parsed.startupPhase ||
        parsed.eventLoopDelayMs !== undefined ||
        parsed.runtimeDepsStagingMs !== undefined
      )) {
        events.push(parsed);
      }
    } catch {
      // Non-JSON log lines are expected; structured diagnostics are optional.
    }
  }
  return events;
}

function countPattern(text, pattern) {
  let count = 0;
  for (const line of text.split("\n")) {
    if (pattern.test(line)) {
      count += 1;
    }
  }
  return count;
}

function maxDuration(events) {
  const values = events.map((event) => event.durationMs).filter((value) => typeof value === "number");
  if (values.length === 0) {
    return null;
  }
  return Math.max(...values);
}

function maxNumber(left, right) {
  if (typeof left !== "number") {
    return typeof right === "number" ? right : null;
  }
  if (typeof right !== "number") {
    return left;
  }
  return Math.max(left, right);
}

function numericMax(items, field) {
  const values = items.map((item) => item[field]).filter((value) => typeof value === "number" && Number.isFinite(value));
  return values.length > 0 ? Math.max(...values) : null;
}

function extractValue(line, key) {
  const match = String(line ?? "").match(new RegExp(`${key}=([^\\s]+)`));
  return match?.[1] ?? null;
}

function parseReasonList(value) {
  if (!value) {
    return [];
  }
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function numberFromValue(value) {
  if (!value) {
    return null;
  }
  const match = String(value).match(/-?\d+(?:\.\d+)?/);
  if (!match) {
    return null;
  }
  const number = Number(match[0]);
  return Number.isFinite(number) ? number : null;
}

function round(value) {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value * 1000) / 1000 : value;
}

function compactLine(line) {
  return String(line ?? "").trim().slice(0, 300);
}
