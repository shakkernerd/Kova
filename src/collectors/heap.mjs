import { readFile } from "node:fs/promises";

export async function summarizeHeapProfiles(paths, options = {}) {
  const summaries = [];
  const limit = Math.max(1, Number(options.limit ?? 10));

  for (const path of paths.slice(0, Math.max(1, Number(options.maxProfiles ?? 20)))) {
    try {
      const profile = JSON.parse(await readFile(path, "utf8"));
      summaries.push({
        path,
        ...summarizeHeapProfile(profile, { limit })
      });
    } catch (error) {
      summaries.push({
        path,
        error: error.message,
        totalSelfSizeBytes: null,
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

export function summarizeHeapProfile(profile, options = {}) {
  const limit = Math.max(1, Number(options.limit ?? 10));
  const functions = [];
  walkHeapNode(profile?.head, functions);
  const totalSelfSizeBytes = functions.reduce((total, item) => total + item.selfSizeBytes, 0);
  return {
    totalSelfSizeBytes,
    topFunctions: functions
      .filter((item) => item.selfSizeBytes > 0)
      .toSorted((left, right) => right.selfSizeBytes - left.selfSizeBytes)
      .slice(0, limit)
      .map((item) => ({
        ...item,
        selfSizeMb: roundMb(item.selfSizeBytes),
        selfPercent: totalSelfSizeBytes > 0 ? roundPercent((item.selfSizeBytes / totalSelfSizeBytes) * 100) : null
      }))
  };
}

function walkHeapNode(node, output) {
  if (!node || typeof node !== "object") {
    return;
  }
  const callFrame = node.callFrame ?? {};
  output.push({
    functionName: callFrame.functionName || "(anonymous)",
    url: callFrame.url || "",
    lineNumber: typeof callFrame.lineNumber === "number" ? callFrame.lineNumber : null,
    columnNumber: typeof callFrame.columnNumber === "number" ? callFrame.columnNumber : null,
    selfSizeBytes: Number(node.selfSize) || 0
  });
  for (const child of node.children ?? []) {
    walkHeapNode(child, output);
  }
}

function mergeTopFunctions(summaries, limit) {
  const merged = new Map();
  for (const summary of summaries) {
    for (const item of summary.topFunctions ?? []) {
      const key = `${item.functionName}\n${item.url}\n${item.lineNumber ?? ""}\n${item.columnNumber ?? ""}`;
      const existing = merged.get(key) ?? {
        functionName: item.functionName,
        url: item.url,
        lineNumber: item.lineNumber,
        columnNumber: item.columnNumber,
        selfSizeBytes: 0,
        profileCount: 0
      };
      existing.selfSizeBytes += item.selfSizeBytes ?? 0;
      existing.profileCount += 1;
      merged.set(key, existing);
    }
  }

  const total = [...merged.values()].reduce((sum, item) => sum + item.selfSizeBytes, 0);
  return [...merged.values()]
    .toSorted((left, right) => right.selfSizeBytes - left.selfSizeBytes)
    .slice(0, limit)
    .map((item) => ({
      ...item,
      selfSizeMb: roundMb(item.selfSizeBytes),
      selfPercent: total > 0 ? roundPercent((item.selfSizeBytes / total) * 100) : null
    }));
}

function roundMb(bytes) {
  return Math.round((bytes / 1024 / 1024) * 10) / 10;
}

function roundPercent(value) {
  return Math.round(value * 10) / 10;
}
