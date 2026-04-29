#!/usr/bin/env node

import { spawn } from "node:child_process";

const separator = process.argv.indexOf("--");
const command = separator >= 0 ? process.argv.slice(separator + 1) : process.argv.slice(2);

if (command.length === 0) {
  console.error("usage: expect-command-fails.mjs -- <command> [args...]");
  process.exit(2);
}

const child = spawn(command[0], command.slice(1), {
  stdio: "inherit",
  shell: false
});

child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`expected command to fail normally, but it exited by signal ${signal}`);
    process.exit(1);
  }
  if (code === 0) {
    console.error("expected command to fail, but it exited 0");
    process.exit(1);
  }
  process.exit(0);
});

child.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});
