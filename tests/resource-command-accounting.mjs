import assert from "node:assert/strict";
import test from "node:test";
import { runCommand, quoteShell } from "../src/commands.mjs";

test("a final sample measures a sub-second command before its wait owner exits", { skip: process.platform !== "linux" }, async () => {
  const result = await runCommand(`sleep 0.2; ${process.execPath} -e 'const end=Date.now()+200; while(Date.now()<end){}'`, {
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


test("parallel product children can still exceed two CPU cores", { skip: process.platform !== "linux" }, async () => {
  const script = "const {spawn}=require('node:child_process');for(let i=0;i<4;i++)spawn(process.execPath,['-e','const end=Date.now()+1200;while(Date.now()<end){}'],{stdio:'ignore'});";
  const command = `${process.execPath} -e ${quoteShell(script)}`;
  const result = await runCommand(command, { resourceSample: { intervalMs: 250 }, timeoutMs: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.resourceSamples.cpuCoverageComplete, true, JSON.stringify(result.resourceSamples.errors));
  assert.ok(result.resourceSamples.byRole["command-tree"].maxCpuPercent > 200);
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
