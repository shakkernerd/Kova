import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { repoRoot } from "../paths.mjs";

export const RESOURCE_SAMPLES_SCHEMA = "kova.resourceSamples.v1";

export function startResourceSampler(rootPid, options = {}) {
  const startedAt = Date.now();
  const intervalMs = Math.max(250, Number(options.intervalMs ?? 1000));
  const roleMatchers = compileRoleMatchers(options.processRoles ?? []);
  const samples = [];
  let gatewayPid = null;
  let gatewayRefreshSample = 0;

  sample();
  const timer = setInterval(sample, intervalMs);
  timer.unref?.();

  return {
    async stop() {
      clearInterval(timer);
      sample();
      const summary = summarizeResourceSamples(samples);
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
  };

  function sample() {
    const allProcesses = listProcesses();
    if (options.envName && (gatewayPid === null || samples.length >= gatewayRefreshSample)) {
      gatewayPid = resolveGatewayPid(options.envName);
      gatewayRefreshSample = samples.length + 5;
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
      if (roles.size > 0) {
        for (const role of matchingRegistryRoles(process, options.rootCommand, roleMatchers)) {
          roles.add(role);
        }
      }
      if (roles.size === 1 && roles.has("command-tree")) {
        roles.add("uncategorized");
      }
      if (roles.size === 1 && roles.has("gateway-tree")) {
        roles.add("uncategorized");
      }
      if (roles.size === 0 || seen.has(process.pid)) {
        continue;
      }
      seen.add(process.pid);
      const sortedRoles = [...roles].sort();
      tracked.push({ ...process, roles: sortedRoles, role: sortedRoles.join(",") });
    }

    samples.push({
      timestamp: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
      rootPid,
      gatewayPid,
      processes: tracked
    });
  }
}

export function summarizeResourceSamples(samples) {
  let peakTotalRssMb = null;
  let maxTotalCpuPercent = null;
  let peakCommandTreeRssMb = null;
  let peakGatewayRssMb = null;
  let peakRssSample = null;
  let peakCpuSample = null;
  const byPid = new Map();
  const byRole = new Map();

  for (const sample of samples) {
    const totalRssMb = roundNumber(sample.processes.reduce((total, process) => total + process.rssMb, 0));
    const totalCpuPercent = roundNumber(sample.processes.reduce((total, process) => total + process.cpuPercent, 0));
    const commandTreeRssMb = roundNumber(sample.processes
      .filter((process) => process.roles?.includes("command-tree") || process.role.includes("command-tree"))
      .reduce((total, process) => total + process.rssMb, 0));
    const gatewayRssMb = roundNumber(sample.processes
      .filter((process) => process.roles?.includes("gateway") || process.role.includes("gateway"))
      .reduce((total, process) => total + process.rssMb, 0));
    updateRolePeaks(byRole, sample);

    peakTotalRssMb = maxNullable(peakTotalRssMb, totalRssMb);
    maxTotalCpuPercent = maxNullable(maxTotalCpuPercent, totalCpuPercent);
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
    if (!peakCpuSample || totalCpuPercent > peakCpuSample.totalCpuPercent) {
      peakCpuSample = {
        timestamp: sample.timestamp,
        elapsedMs: sample.elapsedMs,
        totalCpuPercent,
        topProcess: sample.processes.toSorted((left, right) => right.cpuPercent - left.cpuPercent)[0] ?? null
      };
    }

    for (const process of sample.processes) {
      const existing = byPid.get(process.pid) ?? {
        pid: process.pid,
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
      byPid.set(process.pid, existing);
    }
  }

  const processSummaries = [...byPid.values()].map((process) => ({
    ...process,
    peakRssMb: roundNumber(process.peakRssMb),
    maxCpuPercent: roundNumber(process.maxCpuPercent)
  }));
  const roleSummaries = Object.fromEntries([...byRole.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([role, summary]) => [role, finalizeRoleSummary(summary)]));
  const roleList = Object.entries(roleSummaries).map(([role, summary]) => ({ role, ...summary }));

  return {
    schemaVersion: RESOURCE_SAMPLES_SCHEMA,
    sampleCount: samples.length,
    intervalMs: sampleInterval(samples),
    peakTotalRssMb,
    maxTotalCpuPercent,
    peakCommandTreeRssMb,
    peakGatewayRssMb,
    byRole: roleSummaries,
    topRolesByRss: roleList.toSorted((left, right) => (right.peakRssMb ?? 0) - (left.peakRssMb ?? 0)).slice(0, 8),
    topRolesByCpu: roleList.toSorted((left, right) => (right.maxCpuPercent ?? 0) - (left.maxCpuPercent ?? 0)).slice(0, 8),
    peakRssSample,
    peakCpuSample,
    topByRss: processSummaries.toSorted((left, right) => right.peakRssMb - left.peakRssMb).slice(0, 5),
    topByCpu: processSummaries.toSorted((left, right) => right.maxCpuPercent - left.maxCpuPercent).slice(0, 5)
  };
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

function matchingRegistryRoles(process, rootCommand, roleMatchers) {
  const roles = [];
  for (const role of roleMatchers) {
    if (role.id === "command-tree" || role.id === "gateway" || role.id === "gateway-tree") {
      continue;
    }
    if (matchesAny(role.processPatterns, process.command) || matchesAny(role.commandPatterns, rootCommand) ||
      matchesAny(role.commandPatterns, process.command)) {
      roles.push(role.id);
    }
  }
  return roles;
}

function matchesAny(patterns, value) {
  const text = String(value ?? "");
  return patterns.some((pattern) => pattern.regex ? pattern.regex.test(text) : text.includes(pattern.raw));
}

function listProcesses() {
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,rss=,%cpu=,command="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 2000
  });
  if (result.status !== 0) {
    return [];
  }

  const processes = [];
  for (const line of result.stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([0-9.]+)\s+(.+)$/);
    if (!match) {
      continue;
    }
    processes.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssKb: Number(match[3]),
      rssMb: roundMb(Number(match[3])),
      cpuPercent: Number(match[4]),
      command: redactProcessCommand(match[5])
    });
  }
  return processes;
}

function redactProcessCommand(command) {
  return String(command)
    .replace(/\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)=('[^']*'|"[^"]*"|\S+)/gi, "$1=[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "sk-[redacted]")
    .replace(/\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g, "[redacted-slack-token]");
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

function resolveGatewayPid(envName) {
  const result = spawnSync(process.env.SHELL || "/bin/sh", ["-lc", `ocm service status ${quoteShell(envName)} --json`], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5000
  });
  if (result.status !== 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(result.stdout);
    return typeof parsed.childPid === "number" ? parsed.childPid : null;
  } catch {
    return null;
  }
}

function updateRolePeaks(byRole, sample) {
  const totals = new Map();
  for (const process of sample.processes) {
    for (const role of process.roles ?? process.role.split(",").filter(Boolean)) {
      const total = totals.get(role) ?? {
        rssMb: 0,
        cpuPercent: 0,
        processCount: 0,
        topRssProcess: null,
        topCpuProcess: null
      };
      total.rssMb += process.rssMb;
      total.cpuPercent += process.cpuPercent;
      total.processCount += 1;
      if (!total.topRssProcess || process.rssMb > total.topRssProcess.rssMb) {
        total.topRssProcess = process;
      }
      if (!total.topCpuProcess || process.cpuPercent > total.topCpuProcess.cpuPercent) {
        total.topCpuProcess = process;
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
    const cpuPercent = roundNumber(total.cpuPercent);
    if (existing.peakRssMb === null || rssMb > existing.peakRssMb) {
      existing.peakRssMb = rssMb;
      existing.peakRssAtMs = sample.elapsedMs;
      existing.peakProcessCount = total.processCount;
      existing.peakRssProcess = compactProcess(total.topRssProcess);
    }
    if (existing.maxCpuPercent === null || cpuPercent > existing.maxCpuPercent) {
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
    command: process.command
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

function quoteShell(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
