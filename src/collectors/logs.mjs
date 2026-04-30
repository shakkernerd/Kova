import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCommand } from "../commands.mjs";

export const LOG_METRICS_SCHEMA = "kova.logMetrics.v1";

export async function collectLogMetrics(envName, timeoutMs, artifactDir) {
  const result = await runCommand(`ocm logs ${envName} --tail 200`, { timeoutMs });
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
    structuredEvents: extractStructuredDiagnosticEvents(text),
    artifacts,
    stdoutSnippet: result.stdout.slice(-4000),
    stderrSnippet: result.stderr.slice(-4000)
  };
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
