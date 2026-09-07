import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

let ticksPerSecond;
function clockTicksPerSecond() {
  if (ticksPerSecond === undefined) {
    const result = spawnSync("getconf", ["CLK_TCK"], { encoding: "utf8", timeout: 2000 });
    ticksPerSecond = result.status === 0 ? Number(result.stdout.trim()) : NaN;
  }
  if (!Number.isSafeInteger(ticksPerSecond) || ticksPerSecond <= 0) {
    throw new Error("Linux CPU accounting requires CLK_TCK");
  }
  return ticksPerSecond;
}

export function readLinuxCpuCounters(pid) {
  const text = readFileSync(`/proc/${pid}/stat`, "utf8");
  // comm can contain spaces and parentheses; fields after its last ')' are fixed.
  const fields = text.slice(text.lastIndexOf(")") + 2).trim().split(/\s+/);
  const values = [fields[11], fields[12], fields[13], fields[14], fields[19]].map(Number);
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`Invalid Linux CPU counters for process ${pid}`);
  }
  return { cpuTicks: values[0] + values[1], childCpuTicks: values[2] + values[3], startTicks: values[4], ppid: Number(fields[1]) };
}

export class LinuxCpuSnapshotChangedError extends Error {}

export function readLinuxCpuSnapshot(processes, previouslyTrackedPids = new Set()) {
  const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
  const visited = new Set();
  const visiting = new Set();
  const counters = [];
  const visit = (entry) => {
    if (visited.has(entry.pid)) return;
    if (visiting.has(entry.pid)) throw new LinuxCpuSnapshotChangedError("Process ancestry changed during CPU collection");
    visiting.add(entry.pid);
    const parent = byPid.get(entry.ppid);
    if (parent) visit(parent);
    visiting.delete(entry.pid);
    visited.add(entry.pid);
    try {
      const values = readLinuxCpuCounters(entry.pid);
      if (values.ppid !== entry.ppid) throw new LinuxCpuSnapshotChangedError("Process parent changed during CPU collection");
      counters.push({ ...entry, ...values });
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error;
      // Parent counters precede every live child counter. A child disappearing
      // after the process census invalidates this scan: its parent's earlier
      // wait counter cannot establish that child's terminal CPU transfer.
      if (entry.roles?.length || previouslyTrackedPids.has(entry.pid)) throw new LinuxCpuSnapshotChangedError("Product process exited during CPU collection");
    }
  };
  // The census needs product processes and their wait-owner ancestry, not
  // unrelated host workloads that happen to share an ancestor such as init.
  for (const entry of processes) {
    if (entry.roles?.length || previouslyTrackedPids.has(entry.pid)) visit(entry);
  }
  return counters;
}

export function readLinuxCpuClock() {
  const hz = clockTicksPerSecond();
  const uptime = Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]);
  if (!Number.isFinite(uptime) || uptime < 0) throw new Error("Invalid Linux CPU clock");
  return { hz, ticks: uptime * hz, monotonicMs: performance.now() };
}

const identity = (process) => `${process.pid}:${process.startTicks}`;

export function createLinuxCpuAccountant({ accountingRootPid } = {}) {
  let previous = new Map();
  let previousClock;
  let reapDebt = new Map();
  let missingWaitOwner = false;
  return {
    lastSuccessfulClock() {
      return previousClock;
    },
    trackedProcessIds() {
      return new Set([...previous.values()].map((entry) => entry.pid));
    },
    coverageComplete() {
      return !missingWaitOwner && ![...reapDebt.values()].some((debt) => debt.ticks > 0 && debt.processes.some((entry) => entry.roles?.length));
    },
    sample(processes, clock) {
      const nextDebt = new Map([...reapDebt].map(([key, debt]) => [key, { ...debt, processes: [...debt.processes] }]));
      let nextMissingWaitOwner = missingWaitOwner;
      processes = processes.map((entry) => {
        const roles = [...new Set([...(previous.get(identity(entry))?.roles ?? []), ...(entry.roles ?? [])])];
        return { ...entry, roles, role: roles.join(",") };
      });
      const current = new Map(processes.map((process) => [identity(process), process]));
      const previousByPid = new Map([...previous.values()].map((process) => [process.pid, process]));
      const intervalTicks = previousClock === undefined ? null :
        (clock.monotonicMs - (previousClock.finishedMs ?? previousClock.monotonicMs)) * clock.hz / 1000;
      if (intervalTicks !== null && (!(intervalTicks > 0) || clock.hz !== previousClock.hz)) {
        throw new Error("Linux CPU sample clock did not advance");
      }
      // Once a child is reaped, Linux transfers its complete CPU lifetime to its
      // wait owner. Subtract the part already observed, including nested waits.
      for (const [key, process] of previous) {
        if (current.has(key)) continue;
        const heldDebt = nextDebt.get(key);
        if (heldDebt?.ticks > 0 && heldDebt.processes.some((entry) => entry.roles?.length)) nextMissingWaitOwner = true;
        let ancestor = previousByPid.get(process.ppid);
        const seen = new Set([key]);
        let foundWaitOwner = false;
        while (ancestor && !seen.has(identity(ancestor))) {
          const ancestorKey = identity(ancestor);
          seen.add(ancestorKey);
          if (current.has(ancestorKey)) {
            const debt = nextDebt.get(ancestorKey) ?? { ticks: 0, processes: [] };
            debt.ticks += process.cpuTicks + process.childCpuTicks;
            debt.processes.push(process);
            nextDebt.set(ancestorKey, debt);
            foundWaitOwner = true;
            break;
          }
          ancestor = previousByPid.get(ancestor.ppid);
        }
        if (!foundWaitOwner && process.roles?.length) nextMissingWaitOwner = true;
      }
      const measured = [];
      for (const process of processes) {
        const key = identity(process);
        const before = previous.get(key);
        let ownCpuPercent = null;
        let reapedCpuPercent = null;
        let reapedRoles = [];
        let reapedProcesses = [];
        if (intervalTicks !== null) {
          const newlyObservedExistingOwner = !before && process.startTicks < Math.floor(previousClock.ticks) - 1;
          if (newlyObservedExistingOwner && process.roles.length) {
            throw new Error(`Missing CPU baseline for process ${process.pid}`);
          }
          // A new product process can introduce an existing external wait owner.
          // Its historical host work is not product CPU; establish its baseline
          // before the child can be reaped in a later parent-first census.
          const baseline = before ?? (newlyObservedExistingOwner ? process : null);
          const ownTicks = process.cpuTicks - (baseline?.cpuTicks ?? 0);
          const waitedTicks = process.childCpuTicks - (baseline?.childCpuTicks ?? 0);
          if (ownTicks < 0 || waitedTicks < 0) throw new Error(`Regressed CPU counters for process ${process.pid}`);
          const debt = nextDebt.get(key) ?? { ticks: 0, processes: [] };
          const newlyReapedTicks = Math.max(0, waitedTicks - debt.ticks);
          reapedRoles = [...new Set([...(process.roles ?? []), ...debt.processes.flatMap((entry) => entry.roles ?? [])])];
          reapedProcesses = debt.processes.filter((entry) => entry.roles?.length).map(({ pid, startTicks, roles, command }) => ({ pid, startTicks, roles, command }));
          if (debt.ticks > waitedTicks) nextDebt.set(key, { ...debt, ticks: debt.ticks - waitedTicks });
          else nextDebt.delete(key);
          // The accounting wrapper is harness work. Its waited-child counters
          // still contain product work, including children missed by polling.
          ownCpuPercent = (process.pid === accountingRootPid ? 0 : ownTicks) / intervalTicks * 100;
          reapedCpuPercent = newlyReapedTicks / intervalTicks * 100;
        }
        measured.push({ ...process, ownCpuPercent, reapedCpuPercent, reapedRoles, reapedProcesses,
          cpuPercent: ownCpuPercent === null ? null : ownCpuPercent + reapedCpuPercent });
      }
      for (const key of nextDebt.keys()) if (!current.has(key)) nextDebt.delete(key);
      reapDebt = nextDebt;
      missingWaitOwner = nextMissingWaitOwner;
      previous = current;
      previousClock = clock;
      return measured;
    }
  };
}
