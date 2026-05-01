import { readFile } from "node:fs/promises";
import { join } from "node:path";

const SCHEMA_VERSION = "openclaw.diagnostics.v1";
export const TIMELINE_COLLECTOR_SCHEMA = "kova.timelineCollector.v1";
export const KEY_OPENCLAW_SPANS = [
  "gateway.startup",
  "gateway.ready",
  "config.normalize",
  "plugins.metadata.scan",
  "runtimeDeps.stage",
  "providers.load",
  "models.catalog",
  "models.catalog.gateway",
  "models.catalog.load",
  "models.discovery",
  "channel.capabilities",
  "channel.plugin.get",
  "channel.plugin.load",
  "agent.prepare",
  "agent.turn",
  "agent.cleanup"
];

export async function collectTimelineMetrics(artifactDir) {
  const startedAt = Date.now();
  const timelinePath = artifactDir ? join(artifactDir, "openclaw", "timeline.jsonl") : null;
  if (!timelinePath) {
    return {
      schemaVersion: TIMELINE_COLLECTOR_SCHEMA,
      commandStatus: 0,
      statusLabel: "INFO",
      durationMs: 0,
      available: false,
      error: "artifact directory unavailable",
      artifacts: []
    };
  }

  const timeline = await loadTimeline(timelinePath);
  return {
    schemaVersion: TIMELINE_COLLECTOR_SCHEMA,
    commandStatus: 0,
    statusLabel: timeline.available ? "PASS" : "INFO",
    durationMs: Date.now() - startedAt,
    timeline: {
      ...timeline
    },
    available: timeline.available,
    eventCount: timeline.eventCount,
    parseErrorCount: timeline.parseErrorCount,
    spanCount: timeline.spanCount,
    slowestSpans: timeline.slowestSpans,
    spanTotals: timeline.spanTotals,
    repeatedSpans: timeline.repeatedSpans,
    openSpans: timeline.openSpans,
    keySpans: timeline.keySpans,
    runtimeDeps: timeline.runtimeDeps,
    eventLoop: timeline.eventLoop,
    providers: timeline.providers,
    childProcesses: timeline.childProcesses,
    events: timeline.events,
    artifacts: timeline.available ? [timelinePath] : [],
    error: timeline.available ? null : (timeline.error ?? (timeline.missing ? "OpenClaw timeline not emitted" : null))
  };
}

export async function loadTimeline(path) {
  try {
    const text = await readFile(path, "utf8");
    return {
      ...parseTimelineText(text),
      path
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return emptyTimeline({ path, missing: true });
    }
    return emptyTimeline({ path, error: error.message });
  }
}

export function parseTimelineText(text) {
  const events = [];
  const parseErrors = [];

  for (const [index, rawLine] of String(text ?? "").split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    try {
      const event = JSON.parse(line);
      if (!isObject(event)) {
        parseErrors.push({ line: index + 1, error: "event is not an object" });
        continue;
      }
      events.push(normalizeEvent(event, index + 1));
    } catch (error) {
      parseErrors.push({ line: index + 1, error: error.message });
    }
  }

  return summarizeTimeline(events, parseErrors);
}

export function summarizeTimeline(events, parseErrors = []) {
  const spanStarts = events.filter((event) => event.type === "span.start");
  const spanEvents = events.filter((event) => event.type === "span.end" || event.type === "span.error");
  const eventLoopSamples = events.filter((event) => event.type === "eventLoop.sample");
  const providerRequests = events.filter((event) => event.type === "provider.request");
  const childProcesses = events.filter((event) => event.type === "childProcess.exit");
  const spanTotals = summarizeSpans(spanEvents);
  const openSpans = summarizeOpenSpans({ starts: spanStarts, terminals: spanEvents, events });
  const runtimeDeps = summarizeRuntimeDeps(spanEvents);
  const slowestSpans = spanEvents
    .filter((event) => typeof event.durationMs === "number")
    .toSorted((left, right) => right.durationMs - left.durationMs)
    .slice(0, 10)
    .map(compactTimedEvent);

  return {
    available: events.length > 0,
    schemaVersion: SCHEMA_VERSION,
    eventCount: events.length,
    parseErrorCount: parseErrors.length,
    parseErrors: parseErrors.slice(0, 20),
    spanStartCount: spanStarts.length,
    spanCount: spanEvents.length,
    slowestSpans,
    spanTotals,
    repeatedSpans: Object.values(spanTotals)
      .filter((span) => span.count > 1)
      .toSorted((left, right) => (right.totalDurationMs - left.totalDurationMs) || (right.count - left.count))
      .slice(0, 10),
    openSpanCount: openSpans.length,
    openSpans,
    keySpans: summarizeKeySpans({ spanEvents, openSpans }),
    runtimeDeps,
    eventLoop: summarizeEventLoop(eventLoopSamples),
    providers: summarizeTimedCollection(providerRequests),
    childProcesses: summarizeChildProcesses(childProcesses),
    events: events.slice(0, 200)
  };
}

function emptyTimeline(extra = {}) {
  return {
    available: false,
    schemaVersion: SCHEMA_VERSION,
    eventCount: 0,
    parseErrorCount: 0,
    parseErrors: [],
    spanCount: 0,
    slowestSpans: [],
    spanTotals: {},
    repeatedSpans: [],
    openSpanCount: 0,
    openSpans: [],
    keySpans: emptyKeySpans(),
    runtimeDeps: {
      count: 0,
      totalDurationMs: 0,
      maxDurationMs: null,
      slowest: null,
      byPlugin: []
    },
    eventLoop: {
      sampleCount: 0,
      p95MaxMs: null,
      p99MaxMs: null,
      maxMs: null,
      slowestSample: null
    },
    providers: {
      count: 0,
      maxDurationMs: null,
      slowest: null
    },
    childProcesses: {
      count: 0,
      failedCount: 0,
      maxDurationMs: null,
      slowest: null
    },
    events: [],
    ...extra
  };
}

function normalizeEvent(event, line) {
  const normalized = {
    ...event,
    line,
    schemaVersion: event.schemaVersion ?? SCHEMA_VERSION,
    type: String(event.type ?? "mark"),
    name: String(event.name ?? event.phase ?? event.operation ?? "unknown"),
    timestamp: event.timestamp ?? event.time ?? null,
    durationMs: numberOrNull(event.durationMs ?? event.elapsedMs ?? event.ms)
  };

  if (normalized.durationMs === null) {
    delete normalized.durationMs;
  }

  if (isObject(event.attributes)) {
    normalized.attributes = event.attributes;
  }

  return normalized;
}

function summarizeSpans(events) {
  const totals = {};
  for (const event of events) {
    const existing = totals[event.name] ?? {
      name: event.name,
      count: 0,
      errorCount: 0,
      totalDurationMs: 0,
      maxDurationMs: null
    };
    existing.count += 1;
    if (event.type === "span.error") {
      existing.errorCount += 1;
    }
    if (typeof event.durationMs === "number") {
      existing.totalDurationMs = round(existing.totalDurationMs + event.durationMs);
      existing.maxDurationMs = existing.maxDurationMs === null ? event.durationMs : Math.max(existing.maxDurationMs, event.durationMs);
    }
    totals[event.name] = existing;
  }
  return totals;
}

function summarizeRuntimeDeps(events) {
  const runtimeDepsEvents = events.filter((event) => event.name === "runtimeDeps.stage");
  const byPlugin = new Map();
  let totalDurationMs = 0;
  let maxDurationMs = null;
  let slowest = null;

  for (const event of runtimeDepsEvents) {
    const durationMs = typeof event.durationMs === "number" ? event.durationMs : null;
    const pluginId = event.pluginId ?? event.attributes?.pluginId ?? "gateway";
    const dependencyCount = numberOrNull(event.dependencyCount ?? event.attributes?.dependencyCount ?? event.attributes?.pluginCount);
    const existing = byPlugin.get(pluginId) ?? {
      pluginId,
      count: 0,
      totalDurationMs: 0,
      maxDurationMs: null,
      dependencyCountMax: null
    };

    existing.count += 1;
    if (durationMs !== null) {
      totalDurationMs = round(totalDurationMs + durationMs);
      maxDurationMs = maxDurationMs === null ? durationMs : Math.max(maxDurationMs, durationMs);
      existing.totalDurationMs = round(existing.totalDurationMs + durationMs);
      existing.maxDurationMs = existing.maxDurationMs === null ? durationMs : Math.max(existing.maxDurationMs, durationMs);
      if (!slowest || durationMs > slowest.durationMs) {
        slowest = compactTimedEvent(event);
      }
    }
    existing.dependencyCountMax = maxNullable(existing.dependencyCountMax, dependencyCount);
    byPlugin.set(pluginId, existing);
  }

  return {
    count: runtimeDepsEvents.length,
    totalDurationMs,
    maxDurationMs,
    slowest,
    byPlugin: [...byPlugin.values()]
      .map((entry) => ({
        ...entry,
        totalDurationMs: round(entry.totalDurationMs),
        maxDurationMs: entry.maxDurationMs === null ? null : round(entry.maxDurationMs)
      }))
      .toSorted((left, right) => (right.totalDurationMs - left.totalDurationMs) || (right.maxDurationMs ?? 0) - (left.maxDurationMs ?? 0))
      .slice(0, 10)
  };
}

function summarizeOpenSpans({ starts, terminals, events }) {
  const terminalKeys = new Set(terminals.map(spanIdentity).filter(Boolean));
  const terminalNames = countNames(terminals);
  const latestTimestamp = latestEventTimestamp(events);
  const open = [];

  for (const start of starts) {
    const key = spanIdentity(start);
    if (key && terminalKeys.has(key)) {
      continue;
    }
    if (!key && (terminalNames.get(start.name) ?? 0) > 0) {
      terminalNames.set(start.name, terminalNames.get(start.name) - 1);
      continue;
    }
    open.push({
      type: start.type,
      name: start.name,
      spanId: start.spanId ?? null,
      parentSpanId: start.parentSpanId ?? null,
      timestamp: start.timestamp ?? null,
      ageMs: spanAgeMs(start, latestTimestamp),
      phase: start.phase ?? null,
      provider: start.provider ?? start.attributes?.provider ?? null,
      operation: start.operation ?? start.attributes?.operation ?? null,
      pluginId: start.pluginId ?? start.attributes?.pluginId ?? null
    });
  }

  return open.toSorted((left, right) => (right.ageMs ?? -1) - (left.ageMs ?? -1)).slice(0, 25);
}

function summarizeKeySpans({ spanEvents, openSpans }) {
  const byName = {};
  for (const name of KEY_OPENCLAW_SPANS) {
    const spans = spanEvents.filter((event) => event.name === name);
    const open = openSpans.filter((event) => event.name === name);
    const durations = spans.map((event) => event.durationMs).filter(isNumber);
    const slowest = spans
      .filter((event) => typeof event.durationMs === "number")
      .toSorted((left, right) => right.durationMs - left.durationMs)
      .at(0);
    byName[name] = {
      name,
      count: spans.length,
      errorCount: spans.filter((event) => event.type === "span.error").length,
      openCount: open.length,
      totalDurationMs: round(durations.reduce((total, value) => total + value, 0)),
      maxDurationMs: maxOrNull(durations),
      slowest: slowest ? compactTimedEvent(slowest) : null,
      open: open.slice(0, 5)
    };
  }
  return byName;
}

function emptyKeySpans() {
  return Object.fromEntries(KEY_OPENCLAW_SPANS.map((name) => [name, {
    name,
    count: 0,
    errorCount: 0,
    openCount: 0,
    totalDurationMs: 0,
    maxDurationMs: null,
    slowest: null,
    open: []
  }]));
}

function summarizeEventLoop(samples) {
  const p95Values = samples.map((sample) => numberOrNull(sample.p95Ms)).filter(isNumber);
  const p99Values = samples.map((sample) => numberOrNull(sample.p99Ms)).filter(isNumber);
  const maxValues = samples.map((sample) => numberOrNull(sample.maxMs ?? sample.eventLoopDelayMs)).filter(isNumber);
  const slowestSample = samples
    .map((sample) => ({
      timestamp: sample.timestamp ?? null,
      p95Ms: numberOrNull(sample.p95Ms),
      p99Ms: numberOrNull(sample.p99Ms),
      maxMs: numberOrNull(sample.maxMs ?? sample.eventLoopDelayMs),
      activeSpanName: sample.activeSpanName ?? sample.spanName ?? null
    }))
    .toSorted((left, right) => (right.maxMs ?? -1) - (left.maxMs ?? -1))
    .at(0) ?? null;

  return {
    sampleCount: samples.length,
    p95MaxMs: maxOrNull(p95Values),
    p99MaxMs: maxOrNull(p99Values),
    maxMs: maxOrNull(maxValues),
    slowestSample
  };
}

function summarizeTimedCollection(events) {
  const timed = events.filter((event) => typeof event.durationMs === "number");
  const slowest = timed.toSorted((left, right) => right.durationMs - left.durationMs).at(0);
  return {
    count: events.length,
    maxDurationMs: slowest?.durationMs ?? null,
    slowest: slowest ? compactTimedEvent(slowest) : null
  };
}

function summarizeChildProcesses(events) {
  const summary = summarizeTimedCollection(events);
  return {
    ...summary,
    failedCount: events.filter((event) => {
      const exitCode = numberOrNull(event.exitCode ?? event.code);
      return exitCode !== null ? exitCode !== 0 : Boolean(event.signal);
    }).length
  };
}

function compactTimedEvent(event) {
  return {
    type: event.type,
    name: event.name,
    spanId: event.spanId ?? null,
    parentSpanId: event.parentSpanId ?? null,
    durationMs: event.durationMs ?? null,
    timestamp: event.timestamp ?? null,
    phase: event.phase ?? null,
    provider: event.provider ?? event.attributes?.provider ?? null,
    operation: event.operation ?? event.attributes?.operation ?? null,
    pluginId: event.pluginId ?? event.attributes?.pluginId ?? null,
    exitCode: event.exitCode ?? event.code ?? null,
    signal: event.signal ?? null,
    errorName: event.errorName ?? event.attributes?.errorName ?? null,
    errorMessage: event.errorMessage ?? event.attributes?.errorMessage ?? null
  };
}

function spanIdentity(event) {
  if (event.spanId !== undefined && event.spanId !== null && String(event.spanId).length > 0) {
    return `id:${event.spanId}`;
  }
  return null;
}

function countNames(events) {
  const counts = new Map();
  for (const event of events) {
    counts.set(event.name, (counts.get(event.name) ?? 0) + 1);
  }
  return counts;
}

function latestEventTimestamp(events) {
  const times = events
    .map((event) => Date.parse(event.timestamp ?? ""))
    .filter((time) => Number.isFinite(time));
  return times.length === 0 ? null : Math.max(...times);
}

function spanAgeMs(event, latestTimestamp) {
  const start = Date.parse(event.timestamp ?? "");
  if (!Number.isFinite(start) || latestTimestamp === null || latestTimestamp < start) {
    return null;
  }
  return latestTimestamp - start;
}

function maxOrNull(values) {
  return values.length === 0 ? null : Math.max(...values);
}

function maxNullable(left, right) {
  if (typeof right !== "number") {
    return left;
  }
  return left === null ? right : Math.max(left, right);
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? round(number) : null;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function isNumber(value) {
  return typeof value === "number";
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
