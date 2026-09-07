import assert from "node:assert/strict";
import test from "node:test";
import { runCommand, quoteShell } from "../src/commands.mjs";

test("a final sample measures a sub-second command before its wait owner exits", { skip: process.platform !== "linux" }, async () => {
  const result = await runCommand(`sleep 0.2; ${quoteShell(process.execPath)} -e 'const end=Date.now()+200; while(Date.now()<end){}'`, {
    resourceSample: {}, timeoutMs: 10000
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.resourceSamples.byRole["command-tree"].maxCpuPercent > 20, `sub-second CPU must be measured: ${JSON.stringify(result.resourceSamples)}`);
  assert.equal(result.resourceSamples.cpuCoverageComplete, true, JSON.stringify(result.resourceSamples.errors));
  assert.equal(result.resourceSamples.cpuMeasurementContract, "linux-process-interval-v1");
});

test("accounted commands retain output, nonzero exits, and timeout cleanup", { skip: process.platform !== "linux" }, async () => {
  const failed = await runCommand("printf output; printf error >&2; exit 7", { resourceSample: {}, timeoutMs: 10000 });
  assert.equal(failed.status, 7);
  assert.equal(failed.stdout, "output");
  assert.equal(failed.stderr, "error");
  const timeout = await runCommand("sleep 30", { resourceSample: {}, timeoutMs: 200 });
  assert.equal(timeout.status, 124);
  assert.equal(timeout.timedOut, true);
});


test("parallel child CPU is measured against the work actually performed", { skip: process.platform !== "linux" }, async (t) => {
  const { execFileSync } = await import("node:child_process");
  const hz = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim());
  assert.ok(Number.isSafeInteger(hz) && hz > 0);
  const worker = 'const end=Date.now()+1200;while(Date.now()<end){};console.log(JSON.stringify(process.cpuUsage()));';
  const script = `const {spawn}=require('node:child_process');Promise.all(Array.from({length:4},()=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,['-e',${JSON.stringify(worker)}],{stdio:['ignore','pipe','inherit']});let text='';child.stdout.on('data',chunk=>text+=chunk);child.on('error',reject);child.on('close',code=>code===0?resolve(JSON.parse(text)):reject(new Error('child failed')));}))).then(rows=>console.log(JSON.stringify(rows))).catch(error=>{console.error(error);process.exitCode=1;});`;
  const result = await runCommand(`${quoteShell(process.execPath)} -e ${quoteShell(script)}`, { resourceSample: { intervalMs: 250 }, timeoutMs: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.resourceSamples.cpuCoverageComplete, true, JSON.stringify(result.resourceSamples.errors));
  const workers = JSON.parse(result.stdout);
  assert.equal(workers.length, 4);
  const cpuMicros = workers.reduce((total, row) => total + row.user + row.system, 0);
  // user and system counters each have one kernel tick of quantization per
  // worker. The measured peak must cover the independently reported average
  // work, whether the runner supplies one CPU, a quota, or several CPUs.
  const quantizationMicros = workers.length * 2 * 1_000_000 / hz;
  const referenceAverageLower = Math.max(0, cpuMicros - quantizationMicros) / (result.durationMs * 1000) * 100;
  const measuredPeak = result.resourceSamples.byRole["command-tree"].maxCpuPercent;
  assert.ok(referenceAverageLower > 0);
  assert.ok(measuredPeak >= referenceAverageLower, `${measuredPeak}% does not cover ${referenceAverageLower}% of observed child work`);
  t.diagnostic(JSON.stringify({ case: "parallel-child-cpu", cpuMicros, durationMs: result.durationMs,
    referenceAverageLower, measuredPeak, productionCpuThreshold: 200,
    physicallyObservedAboveThreshold: referenceAverageLower > 200,
    terminalCoverageComplete: result.resourceSamples.cpuCoverageComplete }));
});


test("terminal sampling failures remain visible and do not strand the command owner", { skip: process.platform !== "linux" }, async () => {
  const result = await runCommand("true", { resourceSample: { artifactPath: "/dev/null/not-a-directory/sample.jsonl" }, timeoutMs: 10000 });
  assert.equal(result.status, 0);
  assert.equal(result.resourceSamples.cpuCoverageComplete, false);
  assert.ok(result.resourceSamples.errors.length > 0);
  const signaled = await runCommand("kill -TERM $$", { resourceSample: {}, timeoutMs: 10000 });
  assert.equal(signaled.signal, "SIGTERM");
  assert.notEqual(signaled.status, 0);
});


test("command Node preloads and coverage run only in the requested command", { skip: process.platform !== "linux" }, async () => {
  const fs = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await fs.mkdtemp(join(tmpdir(), "kova-command-node-env-"));
  try {
    const modules = join(root, "modules");
    const coverage = join(root, "coverage");
    const preload = join(root, "preload.cjs");
    await fs.mkdir(modules);
    await fs.writeFile(join(modules, "accounting-preload-marker.js"), 'module.exports = "preload\\n";');
    await fs.writeFile(preload, 'process.stdout.write(require("accounting-preload-marker"));');
    const result = await runCommand(`${quoteShell(process.execPath)} -e 'process.stdout.write("target\\n")'`, {
      env: { NODE_OPTIONS: `--require ${JSON.stringify(preload)}`, NODE_PATH: modules, NODE_V8_COVERAGE: coverage },
      resourceSample: {}, timeoutMs: 10000
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "preload\ntarget\n");
    assert.equal((await fs.readdir(coverage)).filter((entry) => entry.endsWith(".json")).length, 1);
    assert.equal(result.resourceSamples.cpuCoverageComplete, true, JSON.stringify(result.resourceSamples.errors));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});


test("the command deadline owns inherited output pipes after the shell exits", { skip: process.platform !== "linux" }, async () => {
  const result = await runCommand("sleep 1.5 & exit 0", { resourceSample: {}, timeoutMs: 250 });
  assert.equal(result.status, 124);
  assert.equal(result.timedOut, true);
  assert.ok(result.durationMs >= 250, "timeout duration must include the inherited-pipe lifetime");
});


test("successful output drain includes descendants without consuming the timeout", { skip: process.platform !== "linux" }, async () => {
  const result = await runCommand("(sleep 0.1; printf tail >&2) & printf head; exit 0", { resourceSample: {}, timeoutMs: 2000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.timedOut, false);
  assert.equal(result.stdout, "head");
  assert.equal(result.stderr, "tail");
});


test("the watchdog reaps the owned group when inherited writers ignore TERM", { skip: process.platform !== "linux" }, async () => {
  const result = await runCommand("(trap '' TERM; sleep 30) & exit 0", { resourceSample: {}, timeoutMs: 250 });
  assert.equal(result.status, 124);
  assert.equal(result.timedOut, true);
  assert.doesNotMatch(result.stderr, /command timeout cleanup failed/);
});
