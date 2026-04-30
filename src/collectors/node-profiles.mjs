import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { summarizeHeapProfiles } from "./heap.mjs";

export const NODE_PROFILES_SCHEMA = "kova.nodeProfiles.v1";

export async function collectNodeProfileMetrics(artifactDir) {
  const startedAt = Date.now();
  const profileDir = artifactDir ? join(artifactDir, "node-profiles") : null;
  if (!profileDir) {
    return {
      schemaVersion: NODE_PROFILES_SCHEMA,
      commandStatus: 0,
      statusLabel: "INFO",
      durationMs: 0,
      fileCount: 0,
      cpuProfileCount: 0,
      heapProfileCount: 0,
      traceEventCount: 0,
      artifactBytes: 0,
      artifacts: [],
      error: "artifact directory unavailable"
    };
  }

  let entries = [];
  try {
    entries = await readdir(profileDir, { withFileTypes: true });
  } catch (error) {
    if (error.code !== "ENOENT") {
      return {
        schemaVersion: NODE_PROFILES_SCHEMA,
        commandStatus: 0,
        statusLabel: "WARN",
        durationMs: Date.now() - startedAt,
        fileCount: 0,
        cpuProfileCount: 0,
        heapProfileCount: 0,
        traceEventCount: 0,
        artifactBytes: 0,
        artifacts: [],
        error: error.message
      };
    }
  }

  const artifacts = entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(profileDir, entry.name))
    .filter((path) => /\.(cpuprofile|heapprofile)$|node-trace.*\.(json|log)$|report\..*\.json$|diagnostic.*\.json$/i.test(path))
    .slice(0, 100);

  let artifactBytes = 0;
  for (const artifact of artifacts) {
    artifactBytes += await fileSize(artifact);
  }

  const cpuProfiles = artifacts.filter((path) => /\.cpuprofile$/i.test(path));
  const heapProfiles = artifacts.filter((path) => /\.heapprofile$/i.test(path));
  const reports = artifacts.filter((path) => /report\..*\.json$|diagnostic.*\.json$/i.test(path));
  const cpuProfileSummary = await summarizeCpuProfiles(cpuProfiles, { limit: 10, maxProfiles: 20 });
  const heapProfileSummary = await summarizeHeapProfiles(heapProfiles, { limit: 10, maxProfiles: 20 });

  return {
    schemaVersion: NODE_PROFILES_SCHEMA,
    commandStatus: 0,
    statusLabel: artifacts.length > 0 ? "PASS" : "INFO",
    durationMs: Date.now() - startedAt,
    fileCount: artifacts.length,
    cpuProfileCount: cpuProfiles.length,
    heapProfileCount: heapProfiles.length,
    reportCount: reports.length,
    traceEventCount: artifacts.filter((path) => /node-trace.*\.(json|log)$/i.test(path)).length,
    artifactBytes,
    cpuProfileSummary,
    heapProfileSummary,
    artifacts,
    error: artifacts.length > 0 ? null : "node profile artifacts not emitted"
  };
}

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

async function fileSize(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}
