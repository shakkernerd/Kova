import { AsyncLocalStorage } from "node:async_hooks";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { startResourceSampler } from "./collectors/resources.mjs";
import { repoRoot } from "./paths.mjs";

const defaultCommandTimeoutMs = 120000;
const defaultCheckCommandTimeoutMs = 30000;
const commandEnvStorage = new AsyncLocalStorage();
const timeoutTerminationGraceMs = 3000;
const shutdownTerminationGraceMs = 1000;
const redactionMarker = "[REDACTED]";
const shutdownSignals = ["SIGHUP", "SIGINT", "SIGQUIT", "SIGTERM"];
const activeDetachedChildren = new Set();
const shutdownSignalHandlers = new Map(
  shutdownSignals.map((signal) => [signal, () => {
    void forwardShutdownSignal(signal);
  }])
);
let shutdownHandlersInstalled = false;
let shutdownInProgress = false;

export function runWithCommandEnv(env, callback) {
  return commandEnvStorage.run(
    {
      ...(commandEnvStorage.getStore() ?? {}),
      ...(env ?? {})
    },
    callback
  );
}

export function checkCommand(command, args, options = {}) {
  const timeoutMs = normalizeCheckCommandTimeoutMs(options.timeoutMs);
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    // spawnSync keeps waiting if the child ignores the timeout signal.
    killSignal: "SIGKILL"
  });

  return {
    command: [command, ...args].join(" "),
    status: result.status,
    signal: result.signal ?? null,
    error: result.error,
    timedOut: result.error?.code === "ETIMEDOUT",
    timeoutMs,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
}

export function runCommand(command, options = {}) {
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
  const maxOutputChars = normalizeMaxOutputChars(options.maxOutputChars);
  const startedAtEpochMs = Date.now();
  const startedAt = new Date(startedAtEpochMs).toISOString();
  return new Promise((resolve) => {
    const scopedEnv = commandEnvStorage.getStore() ?? {};
    const shell = options.shell ?? options.env?.SHELL ?? scopedEnv.SHELL ?? process.env.SHELL ?? "/bin/sh";
    const childEnv = {
      ...process.env,
      ...scopedEnv,
      ...(options.env ?? {})
    };
    if (options.shell !== undefined && options.env?.SHELL === undefined) {
      childEnv.SHELL = options.shell;
    }
    const accountCpu = process.platform === "linux" && Boolean(options.resourceSample);
    const accountingEnv = accountCpu ? Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith("NODE_") && name !== "UV_THREADPOOL_SIZE")
    ) : null;
    const child = spawn(accountCpu ? process.execPath : shell, accountCpu
      ? [fileURLToPath(new URL("../support/resource-command.mjs", import.meta.url)), shell, command]
      : ["-c", command], {
      cwd: repoRoot,
      env: accountingEnv ?? childEnv,
      stdio: accountCpu ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32"
    });
    const stopTrackingChild = trackDetachedChild(child);

    const createSampler = () => options.resourceSample
      ? startResourceSampler(child.pid, {
        ...options.resourceSample,
        accountingRootPid: accountCpu ? child.pid : undefined,
        rootCommand: command,
        redactValues: options.redactValues ?? []
      })
      : null;
    let sampler = accountCpu ? null : createSampler();
    let accountedCompletion;
    let sampledResources;
    child.on("message", (message) => {
      if (message?.type === "ready" && !sampler) {
        sampler = createSampler();
        child.send({ type: "start", env: childEnv }, () => {});
      } else if (message?.type === "complete" && !accountedCompletion) {
        accountedCompletion = { ...message, finishedAtEpochMs: Date.now() };
        // stop() captures the terminal counters synchronously. Persisting the
        // artifact must not keep the command's wait owner alive after capture.
        sampledResources = sampler?.stop().catch((error) => ({
          available: false, sampleCount: 0, failedSampleCount: 1,
          cpuCoverageComplete: false, errors: [error.message]
        }));
        if (child.connected) child.send({ type: "sampled" }, () => {});
      }
    });
    const stdout = createBoundedOutputAccumulator({
      limit: maxOutputChars,
      redactValues: options.redactValues
    });
    const stderr = createBoundedOutputAccumulator({
      limit: maxOutputChars,
      redactValues: options.redactValues
    });
    let timedOut = false;
    let settled = false;
    let termination = null;
    let terminationErrorReported = false;
    const timer = setTimeout(() => {
      timedOut = true;
      termination = terminateTimedOutProcess(child).then(
        () => null,
        (error) => error
      );
      void termination.then((error) => {
        if (!error) {
          return;
        }
        reportTerminationError(error);
        complete(124, child.signalCode, true);
      });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr.write(chunk);
    });
    child.on("error", async (error) => {
      clearTimeout(timer);
      let terminationError = null;
      if (termination) {
        terminationError = await termination;
        reportTerminationError(terminationError);
      }
      stderr.write(Buffer.from(error.message));
      complete(timedOut ? 124 : 127, null, Boolean(terminationError));
    });
    child.on("close", async (status, signal) => {
      clearTimeout(timer);
      let terminationError = null;
      if (termination) {
        terminationError = await termination;
        reportTerminationError(terminationError);
      }
      complete(timedOut ? 124 : (accountedCompletion ? (accountedCompletion.status ?? 1) : (status ?? 1)), accountedCompletion?.signal ?? signal, Boolean(terminationError));
    });

    function reportTerminationError(error) {
      if (!error || terminationErrorReported) {
        return;
      }
      terminationErrorReported = true;
      stderr.write(Buffer.from(`\ncommand timeout cleanup failed: ${error.message}`));
    }

    function complete(status, signal, keepTracking = false) {
      if (!keepTracking) {
        stopTrackingChild();
      }
      const finishedAtEpochMs = timedOut ? Date.now() : accountedCompletion?.finishedAtEpochMs ?? Date.now();
      const stdoutResult = stdout.finish();
      const stderrResult = stderr.finish();
      settle({
        command: redact(command, options.redactValues),
        status,
        signal,
        timedOut,
        startedAt,
        startedAtEpochMs,
        finishedAt: new Date(finishedAtEpochMs).toISOString(),
        finishedAtEpochMs,
        durationMs: finishedAtEpochMs - startedAtEpochMs,
        stdout: stdoutResult.text,
        stderr: stderrResult.text,
        ...(options.resourceSample ? { resourceSampleExpected: true } : {}),
        outputBudget: outputBudgetSummary(stdoutResult, stderrResult)
      });
    }

    async function settle(result) {
      if (settled) {
        return;
      }
      settled = true;
      if (sampler) {
        result.resourceSamples = await (sampledResources ?? sampler.stop());
      }
      resolve(result);
    }
  });
}

function trackDetachedChild(child) {
  if (process.platform === "win32") {
    return () => {};
  }
  activeDetachedChildren.add(child);
  installShutdownHandlers();
  let tracked = true;
  return () => {
    if (!tracked) {
      return;
    }
    tracked = false;
    activeDetachedChildren.delete(child);
    if (activeDetachedChildren.size === 0 && !shutdownInProgress) {
      uninstallShutdownHandlers();
    }
  };
}

function installShutdownHandlers() {
  if (shutdownHandlersInstalled) {
    return;
  }
  shutdownHandlersInstalled = true;
  for (const [signal, handler] of shutdownSignalHandlers) {
    process.on(signal, handler);
  }
  process.on("exit", forceKillActiveChildren);
}

function uninstallShutdownHandlers() {
  if (!shutdownHandlersInstalled) {
    return;
  }
  shutdownHandlersInstalled = false;
  for (const [signal, handler] of shutdownSignalHandlers) {
    process.off(signal, handler);
  }
  process.off("exit", forceKillActiveChildren);
}

async function forwardShutdownSignal(signal) {
  if (shutdownInProgress) {
    return;
  }
  shutdownInProgress = true;
  const children = [...activeDetachedChildren];
  for (const child of children) {
    try {
      signalProcessTree(child, signal);
    } catch {
      // The exit handler below still makes a best-effort SIGKILL pass.
    }
  }
  await Promise.all(children.map(async (child) => {
    try {
      await waitForProcessTreeExit(child, shutdownTerminationGraceMs);
    } catch {
      // Fall through to the forced pass.
    }
  }));
  const forcedChildren = forceKillActiveChildren();
  await Promise.all(forcedChildren.map(async (child) => {
    try {
      await waitForProcessTreeExit(child, shutdownTerminationGraceMs);
    } catch {
      // The exit hook makes one final synchronous kill pass.
    }
  }));
  process.exit(signalExitCode(signal));
}

function forceKillActiveChildren() {
  const children = [...activeDetachedChildren];
  for (const child of children) {
    try {
      signalProcessTree(child, "SIGKILL");
    } catch {
      // Exit hooks cannot recover; only avoid leaving children when possible.
    }
  }
  return children;
}

function signalExitCode(signal) {
  return {
    SIGHUP: 129,
    SIGINT: 130,
    SIGQUIT: 131,
    SIGTERM: 143
  }[signal] ?? 1;
}

export function quoteShell(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export function createBoundedOutputAccumulator(options = {}) {
  const limit = normalizeMaxOutputChars(options.limit);
  const secrets = [...new Set((options.redactValues ?? []).filter((value) =>
    typeof value === "string" && value.length > 0
  ))].sort((left, right) => right.length - left.length);
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let retained = "";
  let originalChars = 0;
  let finished = false;

  return {
    write(chunk) {
      if (finished) {
        return;
      }
      const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
      processText(text, false);
    },
    finish() {
      if (!finished) {
        processText(decoder.end(), true);
        finished = true;
      }
      const omittedChars = originalChars - retained.length;
      return {
        text: omittedChars > 0
          ? `${retained}\n[truncated ${omittedChars} chars]`
          : retained,
        originalChars,
        retainedChars: retained.length,
        omittedChars,
        truncated: omittedChars > 0,
        limitChars: limit
      };
    }
  };

  function processText(text, final) {
    pending += text;
    if (secrets.length === 0) {
      append(pending);
      pending = "";
      return;
    }
    const deferredAt = final ? pending.length : incompleteSecretStart(pending, secrets);
    let cursor = 0;
    while (cursor < deferredAt) {
      const match = nextSecretMatch(pending, secrets, cursor);
      if (!match || match.index >= deferredAt) {
        append(pending.slice(cursor, deferredAt));
        cursor = deferredAt;
        break;
      }
      append(pending.slice(cursor, match.index));
      if (match.secret) {
        append(redactionMarker);
        cursor = match.index + match.secret.length;
      }
    }
    pending = pending.slice(cursor);
  }

  function append(text) {
    originalChars += text.length;
    const remaining = limit - retained.length;
    if (remaining > 0) {
      retained += text.slice(0, remaining);
    }
  }
}

function incompleteSecretStart(text, secrets) {
  const maxLength = secrets.reduce((max, value) => Math.max(max, value.length), 0);
  const firstCandidate = Math.max(0, text.length - maxLength + 1);
  for (let index = firstCandidate; index < text.length; index += 1) {
    const suffix = text.slice(index);
    if (secrets.some((value) => suffix.length < value.length && value.startsWith(suffix))) {
      return index;
    }
  }
  return text.length;
}

function nextSecretMatch(text, secrets, fromIndex) {
  let match = null;
  for (const secret of secrets) {
    const index = text.indexOf(secret, fromIndex);
    if (index < 0) {
      continue;
    }
    if (!match || index < match.index || (index === match.index && secret.length > match.secret.length)) {
      match = { index, secret };
    }
  }
  return match;
}

function normalizeTimeoutMs(value) {
  const timeoutMs = value === undefined ? defaultCommandTimeoutMs : Number(value);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error(`runCommand timeoutMs must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return timeoutMs;
}

function normalizeCheckCommandTimeoutMs(value) {
  const timeoutMs = value === undefined ? defaultCheckCommandTimeoutMs : Number(value);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error(`checkCommand timeoutMs must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return timeoutMs;
}

function normalizeMaxOutputChars(value) {
  const limit = value === undefined ? 20000 : Number(value);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`runCommand maxOutputChars must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return limit;
}

async function terminateTimedOutProcess(child) {
  signalProcessTree(child, "SIGTERM");
  if (await waitForProcessTreeExit(child, timeoutTerminationGraceMs)) {
    return;
  }
  signalProcessTree(child, "SIGKILL");
  if (!await waitForProcessTreeExit(child, timeoutTerminationGraceMs)) {
    throw new Error(`process group ${child.pid ?? "unknown"} survived SIGKILL`);
  }
}

function signalProcessTree(child, signal) {
  if (process.platform !== "win32" && Number.isInteger(child.pid)) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (error.code !== "ESRCH") {
        throw error;
      }
      return;
    }
  }
  try {
    child.kill(signal);
  } catch (error) {
    if (error.code !== "ESRCH") {
      throw error;
    }
  }
}

async function waitForProcessTreeExit(child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processTreeIsRunning(child)) {
    if (Date.now() >= deadline) {
      return false;
    }
    await sleep(25);
  }
  return true;
}

function processTreeIsRunning(child) {
  if (process.platform === "win32" || !Number.isInteger(child.pid)) {
    return child.exitCode === null && child.signalCode === null;
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") {
      return false;
    }
    if (error.code === "EPERM") {
      return true;
    }
    throw error;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function outputBudgetSummary(stdout, stderr) {
  return {
    schemaVersion: "kova.commandOutputBudget.v1",
    stdout: budgetStreamSummary(stdout),
    stderr: budgetStreamSummary(stderr),
    truncated: stdout.truncated || stderr.truncated,
    omittedChars: stdout.omittedChars + stderr.omittedChars
  };
}

function budgetStreamSummary(stream) {
  return {
    originalChars: stream.originalChars,
    retainedChars: stream.retainedChars,
    omittedChars: stream.omittedChars,
    truncated: stream.truncated,
    limitChars: stream.limitChars
  };
}

function redact(value, secrets = []) {
  let output = String(value ?? "");
  for (const secret of secrets ?? []) {
    if (typeof secret !== "string" || secret.length === 0) {
      continue;
    }
    output = output.replaceAll(secret, "[REDACTED]");
  }
  return output;
}
