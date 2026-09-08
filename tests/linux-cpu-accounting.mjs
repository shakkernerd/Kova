import fs from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { startResourceSampler, summarizeResourceSamples } from "../src/collectors/resources.mjs";
import { checkCpuThreshold } from "../src/evaluation/violations.mjs";
import { evaluateRecord } from "../src/evaluator.mjs";
import { createLinuxCpuAccountant, readLinuxCpuSnapshot, LinuxCpuSnapshotChangedError } from "../src/collectors/linux-cpu.mjs";

const clock = (seconds) => ({ hz: 100, ticks: seconds * 100, monotonicMs: seconds * 1000 });
const processRow = (pid, ppid, cpuTicks, childCpuTicks = 0, startTicks = 0) => ({ pid, ppid, cpuTicks, childCpuTicks, startTicks, rssMb: 0, command: "synthetic", roles: [] });
const cpu = (rows) => rows.reduce((total, row) => total + (row.cpuPercent ?? 0), 0);

test("serial parent and newborn child use the same CPU interval", () => {
  const accountant = createLinuxCpuAccountant();
  accountant.sample([processRow(1, 0, 0)], clock(0));
  assert.equal(cpu(accountant.sample([processRow(1, 0, 100)], clock(1))), 100);
  assert.equal(cpu(accountant.sample([processRow(1, 0, 100), processRow(2, 1, 10, 0, 100)], clock(1.1))), 100);
});

test("real parallel CPU above the unchanged 200% gate remains visible", () => {
  const accountant = createLinuxCpuAccountant();
  accountant.sample([processRow(1, 0, 0), processRow(2, 1, 0)], clock(0));
  assert.equal(cpu(accountant.sample([processRow(1, 0, 150), processRow(2, 1, 150)], clock(1))), 300);
});

test("wait accounting retains unseen short children and excludes already sampled work", () => {
  const accountant = createLinuxCpuAccountant({ accountingRootPid: 1 });
  accountant.sample([processRow(1, 0, 30)], clock(0));
  assert.equal(cpu(accountant.sample([processRow(1, 0, 40), processRow(2, 1, 60, 0, 0)], clock(1))), 60);
  // The child did another 20 ticks before being reaped, and a new short child
  // did 10 ticks entirely between samples. Wrapper work remains harness-only.
  assert.equal(cpu(accountant.sample([processRow(1, 0, 50, 90)], clock(2))), 30);
});

test("nested reaping does not count a grandchild twice", () => {
  const accountant = createLinuxCpuAccountant({ accountingRootPid: 1 });
  accountant.sample([processRow(1, 0, 0)], clock(0));
  accountant.sample([processRow(1, 0, 0), processRow(2, 1, 50), processRow(3, 2, 10)], clock(1));
  assert.equal(cpu(accountant.sample([processRow(1, 0, 0, 90)], clock(2))), 30);
});

test("a recycled PID begins a new CPU identity", () => {
  const accountant = createLinuxCpuAccountant({ accountingRootPid: 1 });
  accountant.sample([processRow(1, 0, 0)], clock(0));
  accountant.sample([processRow(1, 0, 0), processRow(2, 1, 50)], clock(1));
  assert.equal(cpu(accountant.sample([processRow(1, 0, 0, 60), processRow(2, 1, 20, 0, 100)], clock(2))), 30);
});

test("counter regression and a missing historical baseline fail closed", () => {
  const accountant = createLinuxCpuAccountant();
  accountant.sample([processRow(1, 0, 100)], clock(10));
  assert.throws(() => accountant.sample([processRow(1, 0, 90)], clock(11)), /Regressed/);
  const fresh = createLinuxCpuAccountant();
  fresh.sample([processRow(1, 0, 100)], clock(10));
  assert.throws(() => fresh.sample([processRow(1, 0, 100), { ...processRow(2, 1, 100), roles: ["gateway"] }], clock(11)), /Missing CPU baseline/);
});

test("late-discovered product CPU keeps interval bounds and incomplete coverage", () => {
  const accountant = createLinuxCpuAccountant();
  accountant.sample([processRow(1, 0, 100)], clock(10));
  accountant.sample([processRow(1, 0, 100)], clock(11));
  const gateway = { ...processRow(2, 1, 240, 0, 1020), roles: ["gateway"] };
  const measured = accountant.sample([processRow(1, 0, 100), gateway], clock(15));
  assert.equal(measured.find((entry) => entry.pid === 2).cpuPercent, 60);
  assert.equal(accountant.coverageComplete(), false);
  const summary = summarizeResourceSamples([{ processes: measured, collectionStatus: "ok", cpuUncertaintyPercent: 0 }]);
  assert.equal(summary.byRole.gateway.maxCpuPercentLower, 0);
  assert.equal(summary.cpuCoverageComplete, false);
  const record = { status: "PASS", phases: [{ id: "status", measurementScope: "product", results: [{
    command: "openclaw status", status: 0, stdout: "", stderr: "", durationMs: 5000, resourceSamples: summary
  }] }] };
  evaluateRecord(record, {}, {});
  assert.equal(record.status, "BLOCKED", "unobserved earlier bursts cannot qualify even when the latest upper bound is small");
  assert.ok(record.violations.some((violation) => violation.metric === "resourceCpuCoverage"));
  accountant.sample([processRow(1, 0, 100), { ...gateway, cpuTicks: 260 }], clock(16));
  assert.equal(accountant.coverageComplete(), false, "later intervals cannot repair an earlier discovery gap");
});

test("late discovery cannot average a 225% CPU burst into a passing lifetime value", () => {
  const accountant = createLinuxCpuAccountant();
  accountant.sample([], clock(10));
  accountant.sample([], clock(11));
  const processes = accountant.sample([{ ...processRow(2, 0, 900, 0, 1020), roles: ["gateway"] }], clock(15));
  const summary = summarizeResourceSamples([{ processes, collectionStatus: "ok", cpuUncertaintyPercent: 0 }]);
  assert.equal(summary.byRole.gateway.maxCpuPercent, 225);
  assert.equal(summary.byRole.gateway.maxCpuPercentLower, 0);
  const violations = [];
  checkCpuThreshold(violations, { kind: "resource", metric: "cpu", label: "CPU", value: summary.byRole.gateway.maxCpuPercent,
    lower: summary.byRole.gateway.maxCpuPercentLower, threshold: 200 });
  assert.equal(violations[0]?.kind, "evidence");
  assert.equal(violations[0]?.failureDomain, "kova-harness");
});

test("mixed discovery times do not import uncertain CPU into total or role lower bounds", () => {
  const accountant = createLinuxCpuAccountant();
  const known = { ...processRow(1, 0, 0), roles: ["gateway"] };
  accountant.sample([known], clock(10));
  accountant.sample([known], clock(11));
  const processes = accountant.sample([{ ...known, cpuTicks: 400 },
    { ...processRow(2, 0, 900, 0, 1020), roles: ["gateway"] }], clock(15));
  const summary = summarizeResourceSamples([{ processes, collectionStatus: "ok", cpuUncertaintyPercent: 0 }]);
  assert.equal(summary.maxTotalCpuPercent, 325);
  assert.equal(summary.maxTotalCpuPercentLower, 100);
  assert.equal(summary.byRole.gateway.maxCpuPercent, 325);
  assert.equal(summary.byRole.gateway.maxCpuPercentLower, 100);
  assert.equal(summary.cpuCoverageComplete, false);
});

test("a rejected late-discovery census cannot poison interval coverage", () => {
  const accountant = createLinuxCpuAccountant();
  const known = { ...processRow(1, 0, 100), roles: ["gateway"] };
  accountant.sample([known], clock(10));
  accountant.sample([known], clock(11));
  assert.throws(() => accountant.sample([
    { ...processRow(2, 0, 240, 0, 1020), roles: ["gateway"] }, { ...known, cpuTicks: 90 }
  ], clock(15)), /Regressed/);
  accountant.sample([{ ...known, cpuTicks: 200 }], clock(16));
  assert.equal(accountant.coverageComplete(), true);
});

test("late discovery of a roleless wait owner does not invalidate product coverage", () => {
  const accountant = createLinuxCpuAccountant();
  const known = { ...processRow(1, 0, 0), roles: ["gateway"] };
  accountant.sample([known], clock(10));
  accountant.sample([known], clock(11));
  const processes = accountant.sample([{ ...known, cpuTicks: 100 }, processRow(2, 0, 0, 0, 1020)], clock(15));
  const summary = summarizeResourceSamples([{ processes, collectionStatus: "ok", cpuUncertaintyPercent: 0 }]);
  assert.equal(summary.cpuCoverageComplete, true);
  assert.deepEqual(summary.errors, []);
  assert.equal(accountant.coverageComplete(), true);
});

test("a discovery gap follows an identity when a product role is assigned later", () => {
  for (const startTicks of [0, 1020]) {
    const accountant = createLinuxCpuAccountant();
    accountant.sample([], clock(10));
    accountant.sample([], clock(11));
    const owner = processRow(2, 0, 240, 0, startTicks);
    accountant.sample([owner], clock(15));
    assert.equal(accountant.coverageComplete(), true);
    const processes = accountant.sample([{ ...owner, cpuTicks: 260, roles: ["gateway"] }], clock(16));
    const summary = summarizeResourceSamples([{ processes, collectionStatus: "ok", cpuUncertaintyPercent: 0 }]);
    assert.equal(summary.byRole.gateway.maxCpuPercent, 20);
    assert.equal(summary.byRole.gateway.maxCpuPercentLower, 20, "the current interval is known despite the historical gap");
    assert.equal(summary.cpuCoverageComplete, false);
    assert.equal(accountant.coverageComplete(), false);
  }
});

test("reaping preserves a roleless child's discovery gap for a later product owner", () => {
  for (const startTicks of [0, 1020]) {
    for (const roleAtReap of [true, false]) {
      const accountant = createLinuxCpuAccountant();
      const owner = processRow(1, 0, 0);
      accountant.sample([owner], clock(10));
      accountant.sample([owner], clock(11));
      accountant.sample([owner, processRow(2, 1, 240, 0, startTicks)], clock(15));
      let processes = accountant.sample([{ ...owner, childCpuTicks: 260, roles: roleAtReap ? ["gateway"] : [] }], clock(16));
      if (!roleAtReap) {
        assert.equal(accountant.coverageComplete(), true);
        processes = accountant.sample([{ ...owner, cpuTicks: 20, childCpuTicks: 260, roles: ["gateway"] }], clock(17));
      }
      const summary = summarizeResourceSamples([{ processes, collectionStatus: "ok", cpuUncertaintyPercent: 0 }]);
      assert.equal(summary.cpuCoverageComplete, false);
      assert.equal(accountant.coverageComplete(), false);
    }
  }
});

test("missing CPU counter coverage blocks qualification rather than passing as zero", () => {
  const record = { status: "PASS", phases: [{ id: "status", measurementScope: "product", results: [{
    command: "openclaw status", status: 0, stdout: "", stderr: "", durationMs: 10, resourceSamples: { sampleCount: 2, cpuMeasurementContract: process.platform === "linux" ? "linux-process-interval-v1" : "ps-process-cpu-v1", cpuCoverageComplete: false, errors: ["missing CPU baseline"] }
  }] }] };
  const complete = structuredClone(record);
  complete.phases[0].results[0].resourceSamples.cpuCoverageComplete = true;
  complete.phases[0].results[0].resourceSamples.errors = [];
  evaluateRecord(complete, {}, {});
  assert.equal(complete.status, "PASS");
  evaluateRecord(record, {}, {});
  assert.equal(record.status, "BLOCKED");
  assert.ok(record.violations.some((violation) => violation.metric === "resourceCpuCoverage"));
});


test("retired Gateway CPU retains its role when an external supervisor reaps it", () => {
  const accountant = createLinuxCpuAccountant();
  const supervisor = processRow(1, 0, 0);
  const gateway = { ...processRow(2, 1, 0), roles: ["gateway", "gateway-tree"] };
  accountant.sample([supervisor, gateway], clock(0));
  accountant.sample([supervisor, { ...gateway, cpuTicks: 100 }], clock(1));
  const retiring = accountant.sample([supervisor, { ...gateway, cpuTicks: 120, roles: [] }], clock(1.5));
  assert.deepEqual(retiring.find((entry) => entry.pid === 2).roles, ["gateway", "gateway-tree"]);
  const processes = accountant.sample([{ ...supervisor, childCpuTicks: 150 }], clock(2));
  assert.deepEqual(processes[0].reapedRoles, ["gateway", "gateway-tree"]);
  const summary = summarizeResourceSamples([{ elapsedMs: 2000, collectionStatus: "ok", processes, cpuUncertaintyPercent: 0 }]);
  assert.equal(summary.byRole.gateway.maxCpuPercent, 60);
  assert.equal(summary.byRole.gateway.maxCpuPercentLower, 0);
  assert.equal(summary.byRole.gateway.peakCpuProcess.pid, 2);
  assert.equal(summary.byRole.gateway.peakCpuProcess.cpuWaitOwnerPid, 1);
  assert.equal(accountant.coverageComplete(), true);
});

test("counter scan brackets yield conservative bounds and never an invented CPU failure", () => {
  const accountant = createLinuxCpuAccountant();
  accountant.sample([processRow(1, 0, 0)], { ...clock(0), finishedMs: 500 });
  const measured = accountant.sample([processRow(1, 0, 150)], { ...clock(1), finishedMs: 1500 });
  assert.equal(cpu(measured), 300);
  const ambiguous = [];
  checkCpuThreshold(ambiguous, { kind: "resource", metric: "cpu", label: "CPU", value: 300, lower: 0, threshold: 200 });
  assert.equal(ambiguous[0].failureDomain, "kova-harness");
  assert.equal(ambiguous[0].kind, "evidence");
  const parallel = [];
  checkCpuThreshold(parallel, { kind: "resource", metric: "cpu", label: "CPU", value: 300, lower: 280, threshold: 200 });
  assert.equal(parallel[0].kind, "resource");
  const below = [];
  checkCpuThreshold(below, { kind: "resource", metric: "cpu", label: "CPU", value: 199, lower: 180, threshold: 200 });
  assert.deepEqual(below, []);
});

test("process census latency stays outside the CPU counter uncertainty window", {
  skip: process.platform !== "linux"
}, async () => {
  let now = 0;
  let cpuTicks = 0;
  const originalRead = fs.readFileSync;
  const originalSpawn = childProcess.spawnSync;
  mock.method(performance, "now", () => now);
  mock.method(childProcess, "spawnSync", (command) => {
    if (command === "getconf") return { status: 0, stdout: "100\n" };
    if (command === "ps") {
      now += 100;
      return { status: 0, pid: 999, stdout: "1 0 1024 0 node\n" };
    }
    return originalSpawn(command);
  });
  mock.method(fs, "readFileSync", (path, ...args) => {
    if (path === "/proc/uptime") return `${now / 1000} 0\n`;
    if (path === "/proc/1/stat") {
      const fields = Array(22).fill("0");
      fields[0] = "S";
      fields[11] = String(cpuTicks);
      return `1 (node) ${fields.join(" ")}`;
    }
    return originalRead(path, ...args);
  });
  syncBuiltinESMExports();
  try {
    const sampler = startResourceSampler(1);
    now += 1000;
    cpuTicks = 100;
    const summary = await sampler.stop();
    // The summary rounds the upper bound up and the lower bound down. With no
    // scan uncertainty, they can therefore differ by at most one tenth.
    assert.ok(summary.maxTotalCpuPercent - summary.maxTotalCpuPercentLower <= 0.1);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("qualification rejects missing and historical CPU contracts", () => {
  for (const cpuMeasurementContract of [undefined, "ps-process-cpu-legacy"]) {
    const record = { status: "PASS", phases: [{ id: "status", measurementScope: "product", results: [{
      command: "openclaw status", status: 0, stdout: "", stderr: "", durationMs: 10,
      resourceSamples: { sampleCount: 2, cpuCoverageComplete: true, cpuMeasurementContract }
    }] }] };
    evaluateRecord(record, {}, { requireCpuContract: true });
    assert.equal(record.status, "BLOCKED");
    assert.ok(record.violations.some((violation) => violation.metric === "resourceCpuCoverage"));
  }
});


test("an unreaped or missing wait owner cannot certify terminal product CPU", () => {
  const accountant = createLinuxCpuAccountant();
  accountant.sample([processRow(1, 0, 0), { ...processRow(2, 1, 100), roles: ["gateway"] }], clock(0));
  accountant.sample([processRow(1, 0, 0)], clock(1));
  assert.equal(accountant.coverageComplete(), false);
  accountant.sample([processRow(1, 0, 0, 120)], clock(2));
  assert.equal(accountant.coverageComplete(), true);
  const missing = createLinuxCpuAccountant();
  missing.sample([{ ...processRow(2, 99, 100), roles: ["gateway"] }], clock(0));
  missing.sample([], clock(1));
  assert.equal(missing.coverageComplete(), false);
});


test("resource summaries keep recycled PID identities separate", () => {
  const samples = [0, 100].map((startTicks) => ({ collectionStatus: "ok", elapsedMs: startTicks,
    processes: [{ ...processRow(2, 1, 0, 0, startTicks), roles: ["command-tree"], role: "command-tree", cpuPercent: 50 }]
  }));
  const summary = summarizeResourceSamples(samples);
  assert.equal(summary.topByCpu.length, 2);
  assert.deepEqual(summary.topByCpu.map((entry) => entry.startTicks).sort((a, b) => a - b), [0, 100]);
});


test("a child exiting after its wait owner read invalidates the census", () => {
  const reads = [];
  const original = fs.readFileSync;
  mock.method(fs, "readFileSync", (path, ...args) => {
    if (path !== "/proc/1/stat" && path !== "/proc/2/stat") return original(path, ...args);
    reads.push(path);
    if (path === "/proc/2/stat") throw Object.assign(new Error("gone"), { code: "ENOENT" });
    const fields = Array(22).fill("0"); fields[0] = "S"; fields[13] = "100";
    return `1 (wait owner) ${fields.join(" ")}`;
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => readLinuxCpuSnapshot([
      { ...processRow(2, 1, 100), roles: ["gateway"] }, processRow(1, 0, 0)
    ]), LinuxCpuSnapshotChangedError);
    assert.deepEqual(reads, ["/proc/1/stat", "/proc/2/stat"]);
    // A restarted Gateway may already have lost its current role, but its
    // previously measured identity still requires terminal wait accounting.
    assert.throws(() => readLinuxCpuSnapshot([
      processRow(2, 1, 100), processRow(1, 0, 0)
    ], new Set([2])), LinuxCpuSnapshotChangedError);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
});


test("losing a wait owner cannot erase its outstanding product debt", () => {
  const accountant = createLinuxCpuAccountant();
  const init = processRow(99, 0, 0);
  const owner = processRow(1, 99, 0);
  accountant.sample([init, owner, { ...processRow(2, 1, 100), roles: ["gateway"] }], clock(0));
  accountant.sample([init, owner], clock(1));
  assert.equal(accountant.coverageComplete(), false);
  accountant.sample([{ ...init, childCpuTicks: 120 }], clock(2));
  assert.equal(accountant.coverageComplete(), false);
});

test("a rejected census cannot alter CPU debt or the successful scan bracket", () => {
  const accountant = createLinuxCpuAccountant();
  const owner = processRow(1, 0, 10);
  const gateway = { ...processRow(2, 1, 100), roles: ["gateway"] };
  const firstClock = { ...clock(0), finishedMs: 100 };
  accountant.sample([owner, gateway], firstClock);
  assert.throws(() => accountant.sample([{ ...owner, cpuTicks: 5 }], clock(1)), /Regressed/);
  assert.equal(accountant.lastSuccessfulClock(), firstClock);
  accountant.sample([owner, gateway], clock(2));
  assert.equal(accountant.coverageComplete(), true);
});


test("production CPU qualification rejects a completely absent sampler result", () => {
  const record = { status: "PASS", phases: [{ id: "status", measurementScope: "product", results: [{
    command: "openclaw status", status: 0, stdout: "", stderr: "", durationMs: 10
  }] }] };
  evaluateRecord(record, {}, { requireCpuContract: true });
  assert.equal(record.status, "BLOCKED");
  assert.ok(record.violations.some((violation) => violation.metric === "resourceCpuCoverage"));
});


test("unrelated host reparenting is outside the product CPU census", () => {
  const reads = [];
  const original = fs.readFileSync;
  mock.method(fs, "readFileSync", (path, ...args) => {
    if (!/^\/proc\/[123]\/stat$/.test(path)) return original(path, ...args);
    reads.push(path);
    const pid = Number(path.split("/")[2]);
    const fields = Array(22).fill("0");
    fields[0] = "S";
    fields[1] = String(pid === 1 ? 0 : pid === 2 ? 1 : 99);
    return `${pid} (synthetic) ${fields.join(" ")}`;
  });
  syncBuiltinESMExports();
  try {
    const rows = readLinuxCpuSnapshot([
      processRow(1, 0, 0),
      { ...processRow(2, 1, 0), roles: ["gateway"] },
      processRow(3, 1, 0)
    ]);
    assert.deepEqual(rows.map((entry) => entry.pid), [1, 2]);
    assert.deepEqual(reads, ["/proc/1/stat", "/proc/2/stat"]);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
});


test("a new Gateway introduces its existing wait owner without importing host CPU", () => {
  const accountant = createLinuxCpuAccountant();
  const command = { ...processRow(1, 0, 0), roles: ["command-tree"] };
  accountant.sample([command], clock(10));
  const owner = processRow(2, 0, 5000, 9000);
  const gateway = { ...processRow(3, 2, 50, 0, 1000), roles: ["gateway"] };
  const running = accountant.sample([command, owner, gateway], clock(11));
  assert.equal(running.find((entry) => entry.pid === 2).cpuPercent, 0);
  assert.equal(running.find((entry) => entry.pid === 3).cpuPercent, 50);
  assert.ok(accountant.trackedProcessIds().has(2));
  const completed = accountant.sample([command, { ...owner, childCpuTicks: 9060 }], clock(12));
  const retired = completed.find((entry) => entry.pid === 2);
  assert.equal(retired.reapedCpuPercent, 10);
  assert.deepEqual(retired.reapedRoles, ["gateway"]);
  assert.equal(accountant.coverageComplete(), true);
  const summary = summarizeResourceSamples([{ processes: completed, collectionStatus: "ok", cpuUncertaintyPercent: 0 }]);
  assert.equal(summary.cpuCoverageComplete, true, "an external owner's historical host CPU does not invalidate a fully sampled product child");
});
