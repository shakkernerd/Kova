import { spawn } from "node:child_process";

// Keep the wait owner alive until the sampler reads its final child CPU counters.
// Otherwise sub-second commands and the last interval disappear with waitpid.
let child;
let completed = false;
process.on("message", (message) => {
  if (message?.type === "start" && !child) {
    child = spawn(process.argv[2], ["-c", process.argv[3]], {
      env: message.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    // Keep the wait owner alive until inherited writers close, even when the
    // direct shell has exited. The parent's watchdog still owns this group.
    child.stdout.pipe(process.stdout, { end: false });
    child.stderr.pipe(process.stderr, { end: false });
    child.once("error", (error) => {
      process.stderr.write(`${error.message}\n`);
      finish(127, null);
    });
    child.once("close", (status, signal) => finish(status, signal));
  } else if (message?.type === "sampled" && completed) {
    process.disconnect();
  }
});
process.on("disconnect", () => {
  if (child && !completed) {
    // The command shares this process group; do not orphan it if its owner dies.
    process.kill(-process.pid, "SIGTERM");
  }
});
function finish(status, signal) {
  if (completed) return;
  completed = true;
  process.send?.({ type: "complete", status, signal });
}
process.send?.({ type: "ready" });
