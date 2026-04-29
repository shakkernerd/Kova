import { access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { checkCommand, runCommand } from "./commands.mjs";
import { platformInfo } from "./platform.mjs";
import { artifactsDir, reportsDir } from "./paths.mjs";

const requiredNodeMajor = 22;

export async function runSetup(flags = {}) {
  const checks = [];

  checks.push(nodeVersionCheck());
  checks.push(commandAvailableCheck("ocm", ["--version"], { required: true }));
  checks.push(await jsonCommandCheck("ocm-env-list", "ocm env list --json", {
    required: true,
    validate: (data) => Array.isArray(data)
  }));
  checks.push(await jsonCommandCheck("ocm-runtime-list", "ocm runtime list --json", {
    required: true,
    validate: (data) => Array.isArray(data)
  }));
  checks.push(await directoryCheck("reports-dir", reportsDir));
  checks.push(await directoryCheck("artifacts-dir", artifactsDir));
  checks.push(skillGuidanceCheck());

  const ok = checks.every((check) => !check.required || check.status === "PASS");
  const result = {
    schemaVersion: "kova.setup.v1",
    generatedAt: new Date().toISOString(),
    mode: flags.ci ? "ci" : "local",
    ok,
    platform: platformInfo(),
    checks,
    nextCommands: [
      "kova self-check",
      "kova profiles list",
      "kova matrix plan --profile smoke --target runtime:stable",
      "kova matrix run --profile smoke --target runtime:stable --execute --json"
    ]
  };

  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const check of checks) {
      console.log(`${check.status} ${check.id}: ${check.message}`);
    }
    console.log("");
    console.log("Next:");
    for (const command of result.nextCommands) {
      console.log(`  ${command}`);
    }
  }

  if (!ok) {
    throw new Error("setup found missing required prerequisites");
  }
}

function nodeVersionCheck() {
  const major = Number(process.versions.node.split(".")[0]);
  const ok = major >= requiredNodeMajor;
  return {
    id: "node-version",
    required: true,
    status: ok ? "PASS" : "FAIL",
    expected: `>= ${requiredNodeMajor}`,
    actual: process.version,
    message: ok ? `Node ${process.version}` : `Node ${process.version}; expected >= ${requiredNodeMajor}`
  };
}

function commandAvailableCheck(command, args, options = {}) {
  const result = checkCommand(command, args);
  return {
    id: `${command}-available`,
    required: options.required === true,
    status: result.status === 0 ? "PASS" : "FAIL",
    command: [command, ...args].join(" "),
    message: result.status === 0 ? result.stdout.trim() : result.stderr.trim() || "not available"
  };
}

async function jsonCommandCheck(id, command, options) {
  const result = await runCommand(command, { timeoutMs: 30000 });
  if (result.status !== 0) {
    return {
      id,
      required: options.required === true,
      status: "FAIL",
      command,
      durationMs: result.durationMs,
      message: result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`
    };
  }

  try {
    const data = JSON.parse(result.stdout);
    if (!options.validate(data)) {
      throw new Error("unexpected JSON shape");
    }
    return {
      id,
      required: options.required === true,
      status: "PASS",
      command,
      durationMs: result.durationMs,
      message: "ok"
    };
  } catch (error) {
    return {
      id,
      required: options.required === true,
      status: "FAIL",
      command,
      durationMs: result.durationMs,
      message: error.message
    };
  }
}

async function directoryCheck(id, path) {
  try {
    await mkdir(path, { recursive: true });
    await access(path, constants.W_OK);
    return {
      id,
      required: true,
      status: "PASS",
      path,
      message: path
    };
  } catch (error) {
    return {
      id,
      required: true,
      status: "FAIL",
      path,
      message: error.message
    };
  }
}

function skillGuidanceCheck() {
  return {
    id: "ocm-operator-skill",
    required: false,
    status: "INFO",
    message: "For Codex/agent runs, install or load https://github.com/shakkernerd/ocm/tree/main/skills/ocm-operator"
  };
}
