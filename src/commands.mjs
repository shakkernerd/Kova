import { spawn, spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { repoRoot } from "./paths.mjs";

export function checkCommand(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });

  return {
    command: [command, ...args].join(" "),
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
}

export function runCommand(command, options = {}) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const shell = process.env.SHELL || "/bin/sh";
    const child = spawn(shell, ["-lc", command], {
      cwd: repoRoot,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"]
    });

    const sampler = options.resourceSample
      ? startResourceSampler(child.pid, options.resourceSample)
      : null;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3000).unref();
    }, options.timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      settle({
        command,
        status: 127,
        signal: null,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr: error.message
      });
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      settle({
        command,
        status: timedOut ? 124 : (status ?? 1),
        signal,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout: truncate(stdout, options.maxOutputChars ?? 20000),
        stderr: truncate(stderr, options.maxOutputChars ?? 20000)
      });
    });

    async function settle(result) {
      if (settled) {
        return;
      }
      settled = true;
      if (sampler) {
        result.resourceSamples = await sampler.stop();
      }
      resolve(result);
    }
  });
}

export function quoteShell(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function truncate(value, limit = 20000) {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit)}\n[truncated ${value.length - limit} chars]`;
}

function startResourceSampler(rootPid, options) {
  const startedAt = Date.now();
  const intervalMs = Math.max(250, Number(options.intervalMs ?? 1000));
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
      const summary = summarizeSamples(samples);
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
    const tracked = [];
    const seen = new Set();

    for (const process of allProcesses) {
      let role = null;
      if (treePids.has(process.pid)) {
        role = "command-tree";
      }
      if (gatewayPid !== null && process.pid === gatewayPid) {
        role = role ? `${role},gateway` : "gateway";
      }
      if (!role) {
        continue;
      }
      if (seen.has(process.pid)) {
        continue;
      }
      seen.add(process.pid);
      tracked.push({ ...process, role });
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

function summarizeSamples(samples) {
  let peakTotalRssMb = null;
  let maxTotalCpuPercent = null;
  let peakCommandTreeRssMb = null;
  let peakGatewayRssMb = null;
  let peakRssSample = null;
  let peakCpuSample = null;
  const byPid = new Map();

  for (const sample of samples) {
    const totalRssMb = roundNumber(sample.processes.reduce((total, process) => total + process.rssMb, 0));
    const totalCpuPercent = roundNumber(sample.processes.reduce((total, process) => total + process.cpuPercent, 0));
    const commandTreeRssMb = roundNumber(sample.processes
      .filter((process) => process.role.includes("command-tree"))
      .reduce((total, process) => total + process.rssMb, 0));
    const gatewayRssMb = roundNumber(sample.processes
      .filter((process) => process.role.includes("gateway"))
      .reduce((total, process) => total + process.rssMb, 0));

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
        role: process.role,
        peakRssMb: 0,
        maxCpuPercent: 0,
        firstSeenMs: sample.elapsedMs,
        lastSeenMs: sample.elapsedMs
      };
      existing.role = mergeRoles(existing.role, process.role);
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

  return {
    schemaVersion: "kova.resourceSamples.v1",
    sampleCount: samples.length,
    intervalMs: sampleInterval(samples),
    peakTotalRssMb,
    maxTotalCpuPercent,
    peakCommandTreeRssMb,
    peakGatewayRssMb,
    peakRssSample,
    peakCpuSample,
    topByRss: processSummaries.toSorted((left, right) => right.peakRssMb - left.peakRssMb).slice(0, 5),
    topByCpu: processSummaries.toSorted((left, right) => right.maxCpuPercent - left.maxCpuPercent).slice(0, 5)
  };
}

function sampleInterval(samples) {
  if (samples.length < 2) {
    return null;
  }
  return Math.max(1, samples[1].elapsedMs - samples[0].elapsedMs);
}

function mergeRoles(left, right) {
  const roles = new Set(`${left},${right}`.split(",").filter(Boolean));
  return [...roles].join(",");
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
