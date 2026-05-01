export const AGENT_TURN_BREAKDOWN_SCHEMA = "kova.agentTurnBreakdown.v1";

const SOURCE_SPAN_GROUPS = [
  {
    id: "agentPrepare",
    label: "agent.prepare",
    bucket: "preProviderOpenClawMs",
    matches: (name) => name === "agent.prepare"
  },
  {
    id: "modelCatalog",
    label: "models.catalog.*",
    bucket: "preProviderOpenClawMs",
    matches: (name) => name === "models.catalog" || name.startsWith("models.catalog.") || name.startsWith("models.discovery")
  },
  {
    id: "channelPlugin",
    label: "channel.plugin.*",
    bucket: "preProviderOpenClawMs",
    matches: (name) => name.startsWith("channel.plugin.") || name === "channel.capabilities"
  },
  {
    id: "runtimeDepsStage",
    label: "runtimeDeps.stage",
    bucket: "preProviderOpenClawMs",
    matches: (name) => name === "runtimeDeps.stage"
  },
  {
    id: "agentCleanup",
    label: "agent.cleanup",
    bucket: "cleanupMs",
    matches: (name) => name === "agent.cleanup"
  }
];

export function buildAgentTurnBreakdown({ result, attribution, timelineSummary = null }) {
  const commandStartedAtEpochMs = numberOrNull(result?.startedAtEpochMs ?? attribution?.commandStartedAtEpochMs);
  const commandFinishedAtEpochMs = numberOrNull(result?.finishedAtEpochMs ?? attribution?.commandFinishedAtEpochMs);
  const totalMs = numberOrNull(result?.durationMs ?? attribution?.totalTurnMs ?? durationBetween(commandStartedAtEpochMs, commandFinishedAtEpochMs));
  const sourceSpanSummary = summarizeSourceSpans(timelineSummary);
  const preProviderOpenClawMs = numberOrNull(attribution?.preProviderMs);
  const providerMs = numberOrNull(attribution?.providerFinalMs);
  const postProviderMs = numberOrNull(attribution?.postProviderMs);
  const cleanupMs = sourceSpanSummary.categories.agentCleanup.totalDurationMs > 0
    ? sourceSpanSummary.categories.agentCleanup.totalDurationMs
    : null;
  const knownPreProviderMs = sourceSpanSummary.knownPreProviderMs;
  const unknownMs = computeUnknownMs({ totalMs, preProviderOpenClawMs, providerMs, postProviderMs, knownPreProviderMs });

  return {
    schemaVersion: AGENT_TURN_BREAKDOWN_SCHEMA,
    evidenceQuality: sourceSpanSummary.available ? "source-spans" : "outside-in-only",
    command: {
      startedAt: result?.startedAt ?? attribution?.commandStartedAt ?? null,
      startedAtEpochMs: commandStartedAtEpochMs,
      finishedAt: result?.finishedAt ?? attribution?.commandFinishedAt ?? null,
      finishedAtEpochMs: commandFinishedAtEpochMs,
      outputCompleteAt: result?.finishedAt ?? attribution?.commandFinishedAt ?? null,
      outputCompleteAtEpochMs: commandFinishedAtEpochMs,
      totalMs
    },
    provider: {
      firstRequestAt: attribution?.firstProviderRequestAt ?? null,
      firstRequestAtEpochMs: numberOrNull(attribution?.firstProviderRequestAtEpochMs),
      firstByteLatencyMs: numberOrNull(attribution?.firstByteLatencyMs),
      firstChunkLatencyMs: numberOrNull(attribution?.firstChunkLatencyMs),
      finalResponseAt: attribution?.lastProviderResponseAt ?? null,
      finalResponseAtEpochMs: numberOrNull(attribution?.lastProviderResponseAtEpochMs),
      finalMs: providerMs,
      requestCount: attribution?.requestCount ?? 0,
      missingRequest: attribution?.missingProviderRequest ?? true
    },
    processSnapshots: summarizeProcessSnapshots(result?.processSnapshots),
    buckets: {
      cliStartupMs: null,
      gatewayAttachMs: null,
      preProviderOpenClawMs,
      providerMs,
      postProviderMs,
      cleanupMs,
      unknownMs
    },
    sourceSpans: sourceSpanSummary,
    timeline: normalizedTimeline({ result, attribution, sourceSpanSummary })
  };
}

export function summarizeSourceSpans(timelineSummary = null) {
  const spanTotals = normalizeSpanTotals(timelineSummary);
  const categories = Object.fromEntries(SOURCE_SPAN_GROUPS.map((group) => [group.id, emptySourceCategory(group)]));

  for (const [name, summary] of Object.entries(spanTotals)) {
    for (const group of SOURCE_SPAN_GROUPS) {
      if (!group.matches(name)) {
        continue;
      }
      categories[group.id] = mergeSourceSpan(categories[group.id], name, summary);
    }
  }

  const knownPreProviderMs = round(
    categories.agentPrepare.totalDurationMs +
    categories.modelCatalog.totalDurationMs +
    categories.channelPlugin.totalDurationMs +
    categories.runtimeDepsStage.totalDurationMs
  );
  const available = Object.values(categories).some((category) => category.count > 0) || timelineSummary?.available === true;

  return {
    available,
    knownPreProviderMs,
    categories,
    unmatchedSpanCount: Object.keys(spanTotals).filter((name) => !SOURCE_SPAN_GROUPS.some((group) => group.matches(name))).length,
    openSpans: (timelineSummary?.openSpans ?? [])
      .filter((span) => SOURCE_SPAN_GROUPS.some((group) => group.matches(span.name ?? "")))
      .slice(0, 10)
  };
}

export function summarizeAgentTurnBreakdownForMarkdown(breakdown) {
  if (!breakdown) {
    return null;
  }
  const buckets = breakdown.buckets ?? {};
  const spans = breakdown.sourceSpans ?? {};
  const parts = [
    `pre-provider ${formatMs(buckets.preProviderOpenClawMs)}`,
    `provider ${formatMs(buckets.providerMs)}`,
    `post-provider ${formatMs(buckets.postProviderMs)}`
  ];
  if (buckets.cleanupMs !== null && buckets.cleanupMs !== undefined) {
    parts.push(`cleanup ${formatMs(buckets.cleanupMs)}`);
  }
  parts.push(`unknown ${formatMs(buckets.unknownMs)}`);

  const source = sourceSpanHighlights(spans).join("; ");
  return source
    ? `${parts.join("; ")}; source ${source}`
    : `${parts.join("; ")}; source ${breakdown.evidenceQuality === "outside-in-only" ? "missing" : "none"}`;
}

function normalizedTimeline({ result, attribution, sourceSpanSummary }) {
  const points = [
    timelinePoint("command.start", result?.startedAt ?? attribution?.commandStartedAt, result?.startedAtEpochMs ?? attribution?.commandStartedAtEpochMs),
    timelinePoint("provider.firstRequest", attribution?.firstProviderRequestAt, attribution?.firstProviderRequestAtEpochMs),
    timelinePoint("provider.firstByte", null, firstProviderByteEpochMs(attribution)),
    timelinePoint("provider.firstChunk", null, firstProviderChunkEpochMs(attribution)),
    timelinePoint("provider.finalResponse", attribution?.lastProviderResponseAt, attribution?.lastProviderResponseAtEpochMs),
    timelinePoint("command.outputComplete", result?.finishedAt ?? attribution?.commandFinishedAt, result?.finishedAtEpochMs ?? attribution?.commandFinishedAtEpochMs),
    timelinePoint("command.end", result?.finishedAt ?? attribution?.commandFinishedAt, result?.finishedAtEpochMs ?? attribution?.commandFinishedAtEpochMs)
  ].filter(Boolean);

  const sourceSpans = Object.values(sourceSpanSummary.categories)
    .flatMap((category) => category.spans.map((span) => ({
      type: "openclaw.span",
      group: category.id,
      name: span.name,
      count: span.count,
      totalDurationMs: span.totalDurationMs,
      maxDurationMs: span.maxDurationMs
    })));

  return {
    points,
    sourceSpans
  };
}

function firstProviderByteEpochMs(attribution) {
  const start = numberOrNull(attribution?.firstProviderRequestAtEpochMs);
  const latency = numberOrNull(attribution?.firstByteLatencyMs);
  return start !== null && latency !== null ? start + latency : null;
}

function firstProviderChunkEpochMs(attribution) {
  const start = numberOrNull(attribution?.firstProviderRequestAtEpochMs);
  const latency = numberOrNull(attribution?.firstChunkLatencyMs);
  return start !== null && latency !== null ? start + latency : null;
}

function timelinePoint(type, timestamp, epochMs) {
  const normalizedEpochMs = numberOrNull(epochMs);
  if (timestamp === null && normalizedEpochMs === null) {
    return null;
  }
  return {
    type,
    timestamp: timestamp ?? isoOrNull(normalizedEpochMs),
    epochMs: normalizedEpochMs
  };
}

function summarizeProcessSnapshots(snapshots) {
  if (!snapshots) {
    return {
      beforeAt: null,
      afterAt: null,
      beforeProcessCount: null,
      afterProcessCount: null,
      leakCount: null,
      leaksByRole: {},
      leakedProcesses: []
    };
  }
  return {
    beforeAt: snapshots.before?.capturedAt ?? null,
    afterAt: snapshots.after?.capturedAt ?? null,
    beforeProcessCount: snapshots.before?.processCount ?? snapshots.leaks?.beforeProcessCount ?? null,
    afterProcessCount: snapshots.after?.processCount ?? snapshots.leaks?.afterProcessCount ?? null,
    leakCount: snapshots.leaks?.leakCount ?? null,
    leaksByRole: snapshots.leaks?.leaksByRole ?? {},
    leakedProcesses: snapshots.leaks?.leakedProcesses ?? []
  };
}

function normalizeSpanTotals(timelineSummary) {
  const totals = {};
  for (const [name, summary] of Object.entries(timelineSummary?.spanTotals ?? {})) {
    totals[name] = normalizeSpanSummary(name, summary);
  }
  for (const [name, summary] of Object.entries(timelineSummary?.keySpans ?? {})) {
    const normalized = normalizeSpanSummary(name, summary);
    if (!totals[name] || normalized.totalDurationMs > totals[name].totalDurationMs || normalized.count > totals[name].count) {
      totals[name] = normalized;
    }
  }
  return totals;
}

function emptySourceCategory(group) {
  return {
    id: group.id,
    label: group.label,
    bucket: group.bucket,
    count: 0,
    errorCount: 0,
    openCount: 0,
    totalDurationMs: 0,
    maxDurationMs: null,
    spans: []
  };
}

function mergeSourceSpan(category, name, summary) {
  const normalized = normalizeSpanSummary(name, summary);
  return {
    ...category,
    count: category.count + normalized.count,
    errorCount: category.errorCount + normalized.errorCount,
    openCount: category.openCount + normalized.openCount,
    totalDurationMs: round(category.totalDurationMs + normalized.totalDurationMs),
    maxDurationMs: maxNumber(category.maxDurationMs, normalized.maxDurationMs),
    spans: [...category.spans, normalized].toSorted((left, right) => (right.totalDurationMs - left.totalDurationMs) || left.name.localeCompare(right.name)).slice(0, 10)
  };
}

function normalizeSpanSummary(name, summary) {
  return {
    name,
    count: numberOrNull(summary?.count) ?? 0,
    errorCount: numberOrNull(summary?.errorCount) ?? 0,
    openCount: numberOrNull(summary?.openCount) ?? 0,
    totalDurationMs: numberOrNull(summary?.totalDurationMs) ?? numberOrNull(summary?.durationMs) ?? 0,
    maxDurationMs: numberOrNull(summary?.maxDurationMs),
    slowest: summary?.slowest ?? null
  };
}

function computeUnknownMs({ totalMs, preProviderOpenClawMs, providerMs, postProviderMs, knownPreProviderMs }) {
  if (preProviderOpenClawMs !== null) {
    return round(Math.max(0, preProviderOpenClawMs - Math.min(preProviderOpenClawMs, knownPreProviderMs)));
  }
  const known = [providerMs, postProviderMs].filter((value) => value !== null).reduce((sum, value) => sum + value, 0);
  return totalMs === null ? null : round(Math.max(0, totalMs - known));
}

function sourceSpanHighlights(spans) {
  const categories = spans?.categories ?? {};
  return Object.values(categories)
    .filter((category) => category.count > 0)
    .toSorted((left, right) => (right.totalDurationMs - left.totalDurationMs) || left.id.localeCompare(right.id))
    .slice(0, 4)
    .map((category) => `${category.label} ${formatMs(category.totalDurationMs)}`);
}

function durationBetween(start, end) {
  return typeof start === "number" && typeof end === "number" ? Math.max(0, end - start) : null;
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

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isoOrNull(epochMs) {
  return typeof epochMs === "number" ? new Date(epochMs).toISOString() : null;
}

function round(value) {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value * 1000) / 1000 : value;
}

function formatMs(value) {
  return typeof value === "number" ? `${value}ms` : "unknown";
}
