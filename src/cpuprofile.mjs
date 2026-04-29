import { readFile } from "node:fs/promises";

export async function summarizeCpuProfiles(paths, options = {}) {
  const summaries = [];
  const limit = Math.max(1, Number(options.limit ?? 10));

  for (const path of paths.slice(0, Math.max(1, Number(options.maxProfiles ?? 20)))) {
    try {
      const profile = JSON.parse(await readFile(path, "utf8"));
      summaries.push({
        path,
        ...summarizeCpuProfile(profile, { limit })
      });
    } catch (error) {
      summaries.push({
        path,
        error: error.message,
        totalSampleMs: null,
        topFunctions: []
      });
    }
  }

  return {
    profileCount: summaries.length,
    parseErrorCount: summaries.filter((summary) => summary.error).length,
    topFunctions: mergeTopFunctions(summaries, limit),
    profiles: summaries
  };
}

export function summarizeCpuProfile(profile, options = {}) {
  const limit = Math.max(1, Number(options.limit ?? 10));
  const nodes = new Map();
  for (const node of profile?.nodes ?? []) {
    if (typeof node.id !== "number") {
      continue;
    }
    nodes.set(node.id, {
      id: node.id,
      functionName: node.callFrame?.functionName || "(anonymous)",
      url: node.callFrame?.url || "",
      lineNumber: typeof node.callFrame?.lineNumber === "number" ? node.callFrame.lineNumber : null,
      columnNumber: typeof node.callFrame?.columnNumber === "number" ? node.callFrame.columnNumber : null
    });
  }

  const samples = Array.isArray(profile?.samples) ? profile.samples : [];
  const deltas = sampleDeltas(profile, samples.length);
  const selfUsByNode = new Map();
  let totalUs = 0;

  for (let index = 0; index < samples.length; index += 1) {
    const nodeId = samples[index];
    const deltaUs = deltas[index] ?? 0;
    totalUs += deltaUs;
    selfUsByNode.set(nodeId, (selfUsByNode.get(nodeId) ?? 0) + deltaUs);
  }

  const topFunctions = [...selfUsByNode.entries()]
    .map(([nodeId, selfUs]) => ({
      ...compactFrame(nodes.get(nodeId), nodeId),
      selfMs: roundMs(selfUs / 1000),
      selfPercent: totalUs > 0 ? roundPercent((selfUs / totalUs) * 100) : null
    }))
    .filter((item) => item.selfMs > 0)
    .toSorted((left, right) => right.selfMs - left.selfMs)
    .slice(0, limit);

  return {
    totalSampleMs: roundMs(totalUs / 1000),
    sampleCount: samples.length,
    topFunctions
  };
}

function sampleDeltas(profile, sampleCount) {
  if (Array.isArray(profile?.timeDeltas) && profile.timeDeltas.length > 0) {
    return profile.timeDeltas.map((value) => Number(value)).map((value) => Number.isFinite(value) ? value : 0);
  }

  const start = Number(profile?.startTime);
  const end = Number(profile?.endTime);
  if (sampleCount > 0 && Number.isFinite(start) && Number.isFinite(end) && end > start) {
    return Array.from({ length: sampleCount }, () => (end - start) / sampleCount);
  }

  return Array.from({ length: sampleCount }, () => 0);
}

function mergeTopFunctions(summaries, limit) {
  const merged = new Map();
  for (const summary of summaries) {
    for (const item of summary.topFunctions ?? []) {
      const key = `${item.functionName}\n${item.url}\n${item.lineNumber ?? ""}\n${item.columnNumber ?? ""}`;
      const existing = merged.get(key) ?? {
        ...item,
        selfMs: 0,
        profileCount: 0
      };
      existing.selfMs = roundMs(existing.selfMs + item.selfMs);
      existing.profileCount += 1;
      existing.selfPercent = null;
      merged.set(key, existing);
    }
  }

  return [...merged.values()]
    .toSorted((left, right) => right.selfMs - left.selfMs)
    .slice(0, limit);
}

function compactFrame(frame, nodeId) {
  return {
    nodeId,
    functionName: frame?.functionName ?? "(unknown)",
    url: frame?.url ?? "",
    lineNumber: frame?.lineNumber ?? null,
    columnNumber: frame?.columnNumber ?? null
  };
}

function roundMs(value) {
  return Math.round(value * 100) / 100;
}

function roundPercent(value) {
  return Math.round(value * 10) / 10;
}
