import { runCommand } from "./commands.mjs";

export async function runCleanupCommand(command, options = {}) {
  const attempts = [];
  const delays = options.retryDelaysMs ?? [0, 1000, 2000];
  for (const [index, delayMs] of delays.entries()) {
    if (delayMs > 0) {
      await sleep(delayMs);
    }
    const result = await runCommand(command, options);
    attempts.push(result);
    if (result.status === 0 || !isRetryableCleanupFailure(result) || index === delays.length - 1) {
      return {
        ...result,
        attempts: attempts.map(summarizeAttempt)
      };
    }
  }
}

export function isRetryableCleanupFailure(result) {
  if (result.timedOut) {
    return true;
  }
  const output = `${result.stdout}\n${result.stderr}`;
  return /busy|running|shutting down|in use|resource temporarily unavailable|timed out|timeout|econnrefused|connection refused/i.test(output);
}

function summarizeAttempt(result) {
  return {
    status: result.status,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
