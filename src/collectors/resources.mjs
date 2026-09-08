import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { cpus } from "node:os";
import { dirname } from "node:path";
import { repoRoot } from "../paths.mjs";
import { ocmServiceStatusJson } from "../ocm/commands.mjs";
import { createLinuxCpuAccountant, LinuxCpuSnapshotChangedError, readLinuxCpuClock, readLinuxCpuSnapshot } from "./linux-cpu.mjs";

export const RESOURCE_SAMPLES_SCHEMA = "kova.resourceSamples.v1";
export const PROCESS_SNAPSHOT_SCHEMA = "kova.processSnapshot.v1";
export const PROCESS_LEAKS_SCHEMA = "kova.processLeakSummary.v1";

// Gateway PIDs remain stable across most phase commands. Reuse live PIDs so
// resource sampling does not perturb the workload with repeated OCM launches.
const gatewayPidsByEnv = new Map();

export function startResourceSampler(rootPid, options = {}) {
  const startedAt = Date.now();
  const intervalMs = Math.max(250, Number(options.intervalMs ?? 1000));
  const roleMatchers = compileRoleMatchers(options.processRoles ?? []);
  const trackedRolePids = new Map(
    Object.entries(options.trackedRolePids ?? {})
      .filter(([role, pid]) => typeof role === "string" && role.length > 0 && Number.isSafeInteger(pid) && pid > 0)
  );
  const samples = [];
  const cpuAccountant = process.platform === "linux" && !options.processLister
    ? createLinuxCpuAccountant({ accountingRootPid: options.accountingRootPid }) : null;
  const cpuCount = cpuAccountant ? cpus().length : 0;
  let stopped;
  let gatewayPid = null;
  let nextGatewayLookupSample = 0;

  sample();
  const timer = setInterval(sample, intervalMs);
  timer.unref?.();

  return {
    stop() {
      stopped ??= finish();
      return stopped;
    }
  };

  async function finish() {
    clearInterval(timer);
    sample();
    const summary = summarizeResourceSamples(samples);
    if (cpuAccountant && !cpuAccountant.coverageComplete()) {
      summary.cpuCoverageComplete = false;
      summary.errors.push("Product CPU interval or terminal wait accounting is incomplete");
    }
    if (options.artifactPath) {
      await mkdir(dirname(options.artifactPath), { recursive: true });
      await writeFile(
        options.artifactPath,
        samples.map((item) => JSON.stringify(item)).join("\n") + (samples.length > 0 ? "\n" : ""),
        "utf8"
      );
      summary.artifactPath = options.artifactPath;
    }
    return summary;
  }

  function sample(attempt = 1) {
    let cpuClock;
    try {
      cpuClock = cpuAccountant ? readLinuxCpuClock() : null;
    } catch (error) {
      samples.push({ timestamp: new Date().toISOString(), elapsedMs: Date.now() - startedAt,
        rootPid, gatewayPid, collectionStatus: "error", collectionError: error.message, processes: [] });
      return;
    }
    const processResult = (options.processLister ?? listProcesses)(options.redactValues ?? []);
    if (!processResult.ok) {
      samples.push({
        timestamp: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        rootPid,
        gatewayPid,
        collectionStatus: "error",
        collectionError: processResult.error,
        processes: []
      });
      return;
    }
    const allProcesses = processResult.processes;
    if (options.envName) {
      const knownGatewayPid = gatewayPid ?? gatewayPidsByEnv.get(options.envName) ?? null;
      gatewayPid = liveGatewayPid(options.envName, gatewayPid, allProcesses);
      if (knownGatewayPid !== null && gatewayPid === null) {
        nextGatewayLookupSample = samples.length;
      }
      if (gatewayPid === null && samples.length >= nextGatewayLookupSample) {
        gatewayPid = lookupGatewayPid(options.envName, options.commandEnv);
        nextGatewayLookupSample = samples.length + 5;
      }
    }

    const treePids = collectProcessTreePids(allProcesses, rootPid);
    const gatewayTreePids = gatewayPid === null ? new Set() : collectProcessTreePids(allProcesses, gatewayPid);
    const tracked = [];
    const seen = new Set();

    for (const process of allProcesses) {
      const roles = new Set();
      if (treePids.has(process.pid)) {
        roles.add("command-tree");
      }
      if (gatewayPid !== null && process.pid === gatewayPid) {
        roles.add("gateway");
      }
      if (gatewayTreePids.has(process.pid)) {
        roles.add("gateway-tree");
      }
      for (const [role, pid] of trackedRolePids.entries()) {
        if (process.pid === pid) {
          roles.add(role);
        }
      }
      if (roles.size > 0) {
        for (const role of matchingRegistryRoles(process, options.rootCommand, roleMatchers, roles)) {
          roles.add(role);
        }
      }
      if (roles.size === 1 && roles.has("command-tree")) {
        roles.add("uncategorized");
      }
      if (roles.size === 1 && roles.has("gateway-tree")) {
        roles.add("uncategorized");
      }
      if (seen.has(process.pid)) {
        continue;
      }
      seen.add(process.pid);
      const sortedRoles = [...roles].sort();
      tracked.push({ ...process,
        ...(process.pid === options.accountingRootPid ? { rssKb: 0, rssMb: 0, command: "[Kova command CPU accounting]" } : {}),
        roles: sortedRoles, role: sortedRoles.join(",") });
    }

    let measured = tracked;
    let cpuUncertaintyPercent = null;
    if (cpuAccountant) {
      try {
        const counters = readLinuxCpuSnapshot(tracked, cpuAccountant.trackedProcessIds());
        cpuClock.finishedMs = performance.now();
        const previousEnd = cpuAccountant.lastSuccessfulClock()?.finishedMs;
        const previousStart = cpuAccountant.lastSuccessfulClock()?.monotonicMs;
        const innerMs = previousEnd === undefined ? null : cpuClock.monotonicMs - previousEnd;
        const scanMs = cpuClock.finishedMs - cpuClock.monotonicMs + (previousEnd === undefined ? 0 : previousEnd - previousStart);
        cpuUncertaintyPercent = innerMs > 0 ? cpuCount * scanMs / innerMs * 100 : null;
        measured = cpuAccountant.sample(counters, cpuClock).map((entry) => ({ ...entry,
          ...(entry.roles.length ? {} : { rssMb: 0, rssKb: 0, command: "[CPU wait owner for retired product processes]" }),
          // A supervisor outside the product tree can own a retired Gateway's
          // wait counters. Preserve those roles without charging its own work.
          cpuPercent: entry.ownCpuPercent === null ? null :
            (entry.roles.length ? entry.ownCpuPercent : 0) + (entry.reapedRoles.length ? entry.reapedCpuPercent : 0)
        }));
      } catch (error) {
        if (error instanceof LinuxCpuSnapshotChangedError && attempt < 3) return sample(attempt + 1);
        samples.push({ timestamp: new Date().toISOString(), elapsedMs: Date.now() - startedAt,
          rootPid, gatewayPid, collectionStatus: "error", collectionError: error.message, processes: [] });
        return;
      }
    }
    samples.push({
      timestamp: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
      rootPid,
      gatewayPid,
      collectionStatus: "ok",
      collectionError: null,
      cpuMeasurementContract: cpuAccountant ? "linux-process-interval-v1" : "ps-process-cpu-v1",
      cpuClock, cpuUncertaintyPercent,
      ...(cpuAccountant ? { collectionAttempts: attempt } : {}),
      processes: measured.filter((entry) => entry.roles.length || entry.reapedRoles?.length)
    });
  }
}

export function summarizeResourceSamples(samples) {
  const usableSamples = samples.filter((sample) =>
    sample?.collectionStatus !== "error" && Array.isArray(sample?.processes)
  );
  const failedSamples = samples.filter((sample) => sample?.collectionStatus === "error");
  const missingCpuInterval = usableSamples.some((sample) => sample.processes.some((process) =>
    process.cpuIntervalComplete === false && (process.roles?.length || process.reapedRoles?.length)
  ));
  let peakTotalRssMb = null;
  let maxTotalCpuPercent = null;
  let maxTotalCpuPercentLower = null;
  let peakCommandTreeRssMb = null;
  let peakGatewayRssMb = null;
  let peakRssSample = null;
  let peakCpuSample = null;
  const byPid = new Map();
  const byRole = new Map();

  for (const sample of usableSamples) {
    const totalRssMb = roundNumber(sample.processes.reduce((total, process) => total + process.rssMb, 0));
    const cpuProcesses = sample.processes.filter((process) => typeof process.cpuPercent === "number");
    const totalCpu = cpuProcesses.reduce((total, process) => total + process.cpuPercent, 0);
    const totalCpuPercent = cpuProcesses.length > 0 ? (sample.cpuMeasurementContract === "linux-process-interval-v1" ? Math.ceil(totalCpu * 10) / 10 : roundNumber(totalCpu)) : null;
    const commandTreeRssMb = roleRss(sample.processes, "command-tree");
    const gatewayRssMb = roleRss(sample.processes, "gateway");
    updateRolePeaks(byRole, sample);

    peakTotalRssMb = maxNullable(peakTotalRssMb, totalRssMb);
    maxTotalCpuPercent = maxNullable(maxTotalCpuPercent, totalCpuPercent);
    if (sample.cpuUncertaintyPercent !== null && sample.cpuUncertaintyPercent !== undefined) {
      const certain = sample.processes.reduce((sum, entry) => sum + (entry.roles.length && entry.cpuIntervalComplete !== false ? entry.ownCpuPercent ?? 0 : 0), 0);
      maxTotalCpuPercentLower = maxNullable(maxTotalCpuPercentLower, Math.floor(Math.max(0, certain - sample.cpuUncertaintyPercent) * 10) / 10);
    }
    peakCommandTreeRssMb = maxNullable(peakCommandTreeRssMb, commandTreeRssMb);
    peakGatewayRssMb = maxNullable(peakGatewayRssMb, gatewayRssMb);
    if (!peakRssSample || totalRssMb > peakRssSample.totalRssMb) {
      peakRssSample = {
        timestamp: sample.timestamp,
        elapsedMs: sample.elapsedMs,
        totalRssMb,
        topProcess: sample.processes.toSorted((left, right) => right.rssMb - left.rssMb)[0] ?? null
      };
    }
    if (totalCpuPercent !== null && (!peakCpuSample || totalCpuPercent > peakCpuSample.totalCpuPercent)) {
      peakCpuSample = {
        timestamp: sample.timestamp,
        elapsedMs: sample.elapsedMs,
        totalCpuPercent,
        topProcess: sample.processes.toSorted((left, right) => right.cpuPercent - left.cpuPercent)[0] ?? null
      };
    }

    for (const process of sample.processes) {
      const processIdentity = `${process.pid}:${process.startTicks ?? "legacy"}`;
      const existing = byPid.get(processIdentity) ?? {
        pid: process.pid,
        ...(process.startTicks === undefined ? {} : { startTicks: process.startTicks }),
        command: process.command,
        roles: process.roles ?? process.role.split(",").filter(Boolean),
        role: process.role,
        peakRssMb: 0,
        maxCpuPercent: 0,
        firstSeenMs: sample.elapsedMs,
        lastSeenMs: sample.elapsedMs
      };
      existing.roles = mergeRoleArrays(existing.roles, process.roles ?? process.role.split(",").filter(Boolean));
      existing.role = existing.roles.join(",");
      existing.command = process.command;
      existing.peakRssMb = Math.max(existing.peakRssMb, process.rssMb);
      existing.maxCpuPercent = Math.max(existing.maxCpuPercent, process.cpuPercent);
      existing.lastSeenMs = sample.elapsedMs;
      byPid.set(processIdentity, existing);
    }
  }

  const processSummaries = [...byPid.values()].map((process) => ({
    ...process,
    peakRssMb: roundNumber(process.peakRssMb),
    maxCpuPercent: roundNumber(process.maxCpuPercent)
  }));
  const trend = summarizeResourceTrend(usableSamples);
  const roleSummaries = Object.fromEntries([...byRole.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([role, summary]) => [role, finalizeRoleSummary(summary)]));
  const roleList = Object.entries(roleSummaries).map(([role, summary]) => ({ role, ...summary }));

  return {
    schemaVersion: RESOURCE_SAMPLES_SCHEMA,
    sampleCount: samples.length,
    successfulSampleCount: usableSamples.length,
    failedSampleCount: failedSamples.length,
    available: usableSamples.length > 0,
    errors: [...new Set([
      ...(missingCpuInterval ? ["CPU interval baseline is missing for a late-discovered product process"] : []),
      ...failedSamples.map((sample) => sample.collectionError).filter(Boolean)
    ])].slice(0, 5),
    intervalMs: sampleInterval(usableSamples),
    peakTotalRssMb,
    maxTotalCpuPercent,
    maxTotalCpuPercentLower,
    cpuMeasurementContract: usableSamples.find((sample) => sample.cpuMeasurementContract)?.cpuMeasurementContract ?? null,
    cpuCoverageComplete: !missingCpuInterval && usableSamples.some((sample) => sample.processes.some((process) => typeof process.cpuPercent === "number")) && failedSamples.length === 0,
    peakCommandTreeRssMb,
    peakGatewayRssMb,
    byRole: roleSummaries,
    topRolesByRss: roleList.toSorted((left, right) => (right.peakRssMb ?? 0) - (left.peakRssMb ?? 0)).slice(0, 8),
    topRolesByCpu: roleList.toSorted((left, right) => (right.maxCpuPercent ?? 0) - (left.maxCpuPercent ?? 0)).slice(0, 8),
    trend,
    peakRssSample,
    peakCpuSample,
    topByRss: processSummaries.toSorted((left, right) => right.peakRssMb - left.peakRssMb).slice(0, 5),
    topByCpu: processSummaries.toSorted((left, right) => right.maxCpuPercent - left.maxCpuPercent).slice(0, 5)
  };
}

function summarizeResourceTrend(samples) {
  const usable = samples.filter((sample) => Array.isArray(sample.processes));
  if (usable.length === 0) {
    return {
      schemaVersion: "kova.resourceTrend.v1",
      available: false,
      totalRssGrowthMb: null,
      gatewayRssGrowthMb: null,
      firstElapsedMs: null,
      lastElapsedMs: null,
      sampleCount: 0
    };
  }
  const first = usable[0];
  const last = usable.at(-1);
  const firstTotal = totalRss(first.processes);
  const lastTotal = totalRss(last.processes);
  const firstGateway = roleRss(first.processes, "gateway");
  const lastGateway = roleRss(last.processes, "gateway");
  return {
    schemaVersion: "kova.resourceTrend.v1",
    available: true,
    sampleCount: usable.length,
    firstElapsedMs: first.elapsedMs ?? null,
    lastElapsedMs: last.elapsedMs ?? null,
    totalRssStartMb: firstTotal,
    totalRssEndMb: lastTotal,
    totalRssGrowthMb: roundNumber(lastTotal - firstTotal),
    gatewayRssStartMb: firstGateway,
    gatewayRssEndMb: lastGateway,
    gatewayRssGrowthMb: roundNumber(lastGateway - firstGateway)
  };
}

function totalRss(processes) {
  return roundNumber(processes.reduce((total, process) => total + process.rssMb, 0));
}

function roleRss(processes, role) {
  return roundNumber(processes
    .filter((process) => process.roles?.includes(role) || process.role?.split(",").includes(role))
    .reduce((total, process) => total + process.rssMb, 0));
}

export function captureProcessSnapshot(options = {}) {
  const roleMatchers = compileRoleMatchers(options.processRoles ?? []);
  const envName = options.envName ?? null;
  const processResult = (options.processLister ?? listProcesses)(options.redactValues ?? []);
  const allProcesses = processResult.processes;
  const gatewayPid = processResult.ok && envName
    ? liveGatewayPid(envName, null, allProcesses) ?? lookupGatewayPid(envName, options.commandEnv)
    : null;
  const gatewayTreePids = gatewayPid === null ? new Set() : collectProcessTreePids(allProcesses, gatewayPid);
  const scopeTokens = snapshotScopeTokens(options);
  const included = [];

  for (const process of allProcesses) {
    const roles = new Set();
    if (gatewayPid !== null && process.pid === gatewayPid) {
      roles.add("gateway");
    }
    if (gatewayTreePids.has(process.pid)) {
      roles.add("gateway-tree");
    }
    for (const role of matchingSnapshotRegistryRoles(process, roleMatchers, {
      allowGlobalProcessRoleMatches: options.allowGlobalProcessRoleMatches === true,
      existingRoles: roles,
      scopeTokens
    })) {
      roles.add(role);
    }
    if (roles.size === 0) {
      continue;
    }
    const sortedRoles = [...roles].sort();
    included.push({
      pid: process.pid,
      ppid: process.ppid,
      rssMb: process.rssMb,
      cpuPercent: process.cpuPercent,
      roles: sortedRoles,
      role: sortedRoles.join(","),
      command: process.command
    });
  }

  return {
    schemaVersion: PROCESS_SNAPSHOT_SCHEMA,
    capturedAt: new Date().toISOString(),
    envName,
    collectionStatus: processResult.ok ? "ok" : "error",
    collectionError: processResult.error,
    gatewayPid,
    processCount: included.length,
    roleCounts: summarizeRoleCounts(included),
    processes: included.toSorted((left, right) => left.pid - right.pid)
  };
}

export function diffProcessSnapshots(before, after, options = {}) {
  const roles = new Set(options.roles ?? []);
  const beforePids = new Set((before?.processes ?? []).map((process) => process.pid));
  const leakedProcesses = (after?.processes ?? [])
    .filter((process) => !beforePids.has(process.pid))
    .filter((process) => roles.size === 0 || process.roles?.some((role) => roles.has(role)))
    .toSorted((left, right) => roleSortKey(left).localeCompare(roleSortKey(right)) || left.pid - right.pid);

  return {
    schemaVersion: PROCESS_LEAKS_SCHEMA,
    roles: [...roles],
    beforeProcessCount: before?.processCount ?? null,
    afterProcessCount: after?.processCount ?? null,
    leakCount: leakedProcesses.length,
    leaksByRole: summarizeRoleCounts(leakedProcesses),
    leakedProcesses: leakedProcesses.map(compactProcess)
  };
}

export function classifyRegistryRolesForProcess(process, options = {}) {
  const roleMatchers = compileRoleMatchers(options.processRoles ?? []);
  const existingRoles = new Set(options.existingRoles ?? []);
  return matchingRegistryRoles(process, options.rootCommand, roleMatchers, existingRoles);
}

export function classifySnapshotRolesForProcess(process, options = {}) {
  const roleMatchers = compileRoleMatchers(options.processRoles ?? []);
  const existingRoles = new Set(options.existingRoles ?? []);
  const roles = new Set(existingRoles);
  for (const role of matchingSnapshotRegistryRoles(process, roleMatchers, {
    allowGlobalProcessRoleMatches: options.allowGlobalProcessRoleMatches === true,
    existingRoles,
    scopeTokens: snapshotScopeTokens(options)
  })) {
    roles.add(role);
  }
  return [...roles].sort();
}

function compileRoleMatchers(roles) {
  return roles.map((role) => ({
    id: role.id,
    commandPatterns: compilePatterns(role.commandPatterns ?? []),
    processPatterns: compilePatterns(role.processPatterns ?? [])
  })).filter((role) => typeof role.id === "string" && role.id.length > 0);
}

function compilePatterns(patterns) {
  return patterns
    .filter((pattern) => typeof pattern === "string" && pattern.length > 0)
    .map((pattern) => {
      try {
        return { raw: pattern, regex: new RegExp(pattern, "i") };
      } catch {
        return { raw: pattern, regex: null };
      }
    });
}

function matchingRegistryRoles(process, rootCommand, roleMatchers, existingRoles = new Set()) {
  const processRoles = matchingRegistryProcessRoles(process, roleMatchers);
  if (processRoles.length > 0) {
    return processRoles;
  }

  const commandRoles = roleMatchers
    .filter((role) =>
      role.id !== "command-tree" &&
      role.id !== "gateway" &&
      role.id !== "gateway-tree" &&
      matchesAny(role.commandPatterns, process.command)
    )
    .map((role) => role.id);
  if (commandRoles.length > 0 || !existingRoles.has("command-tree")) {
    return commandRoles;
  }

  // Generic wrappers inherit the root command role; owned child processes keep
  // their process-specific role instead of duplicating the whole command tree.
  return roleMatchers
    .filter((role) =>
      role.id !== "command-tree" &&
      role.id !== "gateway" &&
      role.id !== "gateway-tree" &&
      matchesAny(role.commandPatterns, rootCommand)
    )
    .map((role) => role.id);
}

function matchingRegistryProcessRoles(process, roleMatchers) {
  const roles = [];
  for (const role of roleMatchers) {
    if (role.id === "command-tree" || role.id === "gateway" || role.id === "gateway-tree") {
      continue;
    }
    if (matchesAny(role.processPatterns, process.command)) {
      roles.push(role.id);
    }
  }
  return roles;
}

function matchingSnapshotRegistryRoles(process, roleMatchers, options = {}) {
  const existingRoles = options.existingRoles ?? new Set();
  if (existingRoles.size === 0 && options.allowGlobalProcessRoleMatches !== true && !processMatchesSnapshotScope(process, options.scopeTokens ?? [])) {
    return [];
  }
  return matchingRegistryProcessRoles(process, roleMatchers);
}

function processMatchesSnapshotScope(process, scopeTokens) {
  const command = String(process?.command ?? "");
  return scopeTokens.some((token) => token.length > 0 && command.includes(token));
}

function snapshotScopeTokens(options = {}) {
  const tokens = new Set();
  if (typeof options.envName === "string" && options.envName.trim().length > 0) {
    tokens.add(options.envName.trim());
  }
  for (const token of String(options.rootCommand ?? "").match(/\bkova-[A-Za-z0-9_.-]+\b/g) ?? []) {
    tokens.add(token);
  }
  return [...tokens].filter((token) => token.length >= 4);
}

function summarizeRoleCounts(processes) {
  const counts = new Map();
  for (const process of processes) {
    for (const role of process.roles ?? process.role?.split(",").filter(Boolean) ?? []) {
      counts.set(role, (counts.get(role) ?? 0) + 1);
    }
  }
  return Object.fromEntries([...counts.entries()].toSorted(([left], [right]) => left.localeCompare(right)));
}

function roleSortKey(process) {
  return process.role ?? process.roles?.join(",") ?? "";
}

function matchesAny(patterns, value) {
  const text = String(value ?? "");
  return patterns.some((pattern) => pattern.regex ? pattern.regex.test(text) : text.includes(pattern.raw));
}

function listProcesses(redactValues = []) {
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,rss=,%cpu=,command="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 2000
  });
  if (result.status !== 0) {
    return {
      ok: false,
      status: result.status,
      error: result.error?.message ?? `ps exited with status ${result.status ?? "unknown"}`,
      processes: []
    };
  }

  const processes = [];
  for (const line of result.stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([0-9.]+)\s+(.+)$/);
    if (!match || Number(match[1]) === result.pid) {
      continue;
    }
    processes.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssKb: Number(match[3]),
      rssMb: roundMb(Number(match[3])),
      cpuPercent: Number(match[4]),
      command: redactProcessCommand(match[5], redactValues)
    });
  }
  return {
    ok: true,
    status: 0,
    error: null,
    processes
  };
}

function redactProcessCommand(command, redactValues = []) {
  let text = String(command)
    .replace(/\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)=('[^']*'|"[^"]*"|\S+)/gi, "$1=[redacted]")
    .replace(/(^|\s)(--(?:api-key|password|token|client-secret|client_secret|access-token|refresh-token|credential))(?:=|\s+)(('[^']*')|("[^"]*")|\S+)/gi, "$1$2 [redacted]")
    .replace(/\b(authorization\s*:\s*)(?:bearer|basic)\s+('[^']*'|"[^"]*"|\S+)/gi, "$1[redacted]")
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1[redacted]@")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "sk-[redacted]")
    .replace(/\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g, "[redacted-slack-token]");
  for (const value of redactValues) {
    if (typeof value === "string" && value.length > 0) {
      text = text.split(value).join("[redacted]");
    }
  }
  return text;
}

function collectProcessTreePids(processes, rootPid) {
  const childrenByParent = new Map();
  for (const process of processes) {
    const children = childrenByParent.get(process.ppid) ?? [];
    children.push(process.pid);
    childrenByParent.set(process.ppid, children);
  }

  const pids = new Set([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift();
    for (const childPid of childrenByParent.get(pid) ?? []) {
      if (pids.has(childPid)) {
        continue;
      }
      pids.add(childPid);
      queue.push(childPid);
    }
  }
  return pids;
}

function liveGatewayPid(envName, currentPid, processes) {
  const candidate = currentPid ?? gatewayPidsByEnv.get(envName) ?? null;
  if (candidate === null) {
    return null;
  }
  if (processes.some((process) => process.pid === candidate)) {
    return candidate;
  }
  gatewayPidsByEnv.delete(envName);
  return null;
}

function lookupGatewayPid(envName, commandEnv) {
  const shell = commandEnv?.SHELL ?? process.env.SHELL ?? "/bin/sh";
  const result = spawnSync(shell, ["-lc", ocmServiceStatusJson(envName)], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...(commandEnv ?? {}) },
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5000
  });
  if (result.status !== 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(result.stdout);
    const childPid = typeof parsed.childPid === "number" ? parsed.childPid : null;
    if (childPid === null) {
      gatewayPidsByEnv.delete(envName);
    } else {
      gatewayPidsByEnv.set(envName, childPid);
    }
    return childPid;
  } catch {
    return null;
  }
}

function updateRolePeaks(byRole, sample) {
  const totals = new Map();
  for (const process of sample.processes) {
    for (const role of new Set([...(process.roles ?? process.role.split(",").filter(Boolean)), ...(process.reapedRoles ?? [])])) {
      const total = totals.get(role) ?? {
        rssMb: 0,
        cpuPercent: null,
        cpuCertainPercent: null,
        processCount: 0,
        topRssProcess: null,
        topCpuProcess: null
      };
      const ownsRole = process.roles?.includes(role) ?? process.role.split(",").includes(role);
      if (ownsRole) total.rssMb += process.rssMb;
      if (typeof process.ownCpuPercent === "number") {
        total.cpuPercent = (total.cpuPercent ?? 0) + (ownsRole ? process.ownCpuPercent : 0) +
          (process.reapedRoles.includes(role) ? process.reapedCpuPercent : 0);
        total.cpuCertainPercent = (total.cpuCertainPercent ?? 0) + (ownsRole && process.cpuIntervalComplete !== false ? process.ownCpuPercent : 0);
      } else if (typeof process.cpuPercent === "number") total.cpuPercent = (total.cpuPercent ?? 0) + process.cpuPercent;
      total.processCount += 1;
      if (!total.topRssProcess || process.rssMb > total.topRssProcess.rssMb) {
        total.topRssProcess = process;
      }
      const retired = !ownsRole ? process.reapedProcesses?.find((entry) => entry.roles?.includes(role)) : null;
      const attributed = retired ? { ...process, ...retired, rssMb: 0, role: retired.roles.join(","),
        cpuPercent: process.reapedCpuPercent, cpuAttribution: "reaped-role-upper-bound", cpuWaitOwnerPid: process.pid } : process;
      if (!total.topCpuProcess || attributed.cpuPercent > total.topCpuProcess.cpuPercent) {
        total.topCpuProcess = attributed;
      }
      totals.set(role, total);
    }
  }

  for (const [role, total] of totals.entries()) {
    const existing = byRole.get(role) ?? {
      role,
      peakRssMb: null,
      maxCpuPercent: null,
      peakRssAtMs: null,
      peakCpuAtMs: null,
      peakProcessCount: 0,
      peakRssProcess: null,
      peakCpuProcess: null
    };
    const rssMb = roundNumber(total.rssMb);
    const cpuPercent = total.cpuPercent === null ? null :
      sample.cpuMeasurementContract === "linux-process-interval-v1" ? Math.ceil(total.cpuPercent * 10) / 10 : roundNumber(total.cpuPercent);
    if (existing.peakRssMb === null || rssMb > existing.peakRssMb) {
      existing.peakRssMb = rssMb;
      existing.peakRssAtMs = sample.elapsedMs;
      existing.peakProcessCount = total.processCount;
      existing.peakRssProcess = compactProcess(total.topRssProcess);
    }
    if (total.cpuCertainPercent !== null) {
      const lower = Math.floor(Math.max(0, total.cpuCertainPercent - (sample.cpuUncertaintyPercent ?? 0)) * 10) / 10;
      existing.maxCpuPercentLower = Math.max(existing.maxCpuPercentLower ?? 0, lower);
    }
    if (cpuPercent !== null && (existing.maxCpuPercent === null || cpuPercent > existing.maxCpuPercent)) {
      existing.maxCpuPercent = cpuPercent;
      existing.peakCpuAtMs = sample.elapsedMs;
      existing.peakCpuProcess = compactProcess(total.topCpuProcess);
    }
    byRole.set(role, existing);
  }
}

function finalizeRoleSummary(summary) {
  return {
    peakRssMb: summary.peakRssMb,
    maxCpuPercent: summary.maxCpuPercent,
    ...(summary.maxCpuPercentLower === undefined ? {} : { maxCpuPercentLower: summary.maxCpuPercentLower }),
    peakRssAtMs: summary.peakRssAtMs,
    peakCpuAtMs: summary.peakCpuAtMs,
    peakProcessCount: summary.peakProcessCount,
    peakRssProcess: summary.peakRssProcess,
    peakCpuProcess: summary.peakCpuProcess
  };
}

function compactProcess(process) {
  if (!process) {
    return null;
  }
  return {
    pid: process.pid,
    roles: process.roles ?? process.role.split(",").filter(Boolean),
    role: process.role,
    rssMb: process.rssMb,
    cpuPercent: process.cpuPercent,
    command: process.command,
    ...(process.cpuAttribution ? { cpuAttribution: process.cpuAttribution, cpuWaitOwnerPid: process.cpuWaitOwnerPid } : {})
  };
}

function sampleInterval(samples) {
  if (samples.length < 2) {
    return null;
  }
  return Math.max(1, samples[1].elapsedMs - samples[0].elapsedMs);
}

function mergeRoleArrays(left, right) {
  const roles = new Set([...(left ?? []), ...(right ?? [])].filter(Boolean));
  return [...roles].sort();
}

function maxNullable(left, right) {
  if (typeof right !== "number") {
    return left;
  }
  return left === null ? right : Math.max(left, right);
}

function roundMb(kb) {
  return roundNumber(kb / 1024);
}

function roundNumber(value) {
  return Math.round(value * 10) / 10;
}
