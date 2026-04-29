import { readFile } from "node:fs/promises";

const SCHEMA_VERSION = "openclaw.diagnostics.v1";

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
  const spanEvents = events.filter((event) => event.type === "span.end" || event.type === "span.error");
  const eventLoopSamples = events.filter((event) => event.type === "eventLoop.sample");
  const providerRequests = events.filter((event) => event.type === "provider.request");
  const childProcesses = events.filter((event) => event.type === "childProcess.exit");
  const spanTotals = summarizeSpans(spanEvents);
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
    spanCount: spanEvents.length,
    slowestSpans,
    spanTotals,
    repeatedSpans: Object.values(spanTotals)
      .filter((span) => span.count > 1)
      .toSorted((left, right) => (right.totalDurationMs - left.totalDurationMs) || (right.count - left.count))
      .slice(0, 10),
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

function maxOrNull(values) {
  return values.length === 0 ? null : Math.max(...values);
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
