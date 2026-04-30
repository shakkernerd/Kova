import { access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { checkCommand, runCommand } from "./commands.mjs";
import { platformInfo } from "./platform.mjs";
import { artifactsDir, credentialsDir, liveEnvPath, providersPath, reportsDir } from "./paths.mjs";
import { configureCredentialProvider, ensureCredentialStore } from "./auth.mjs";

const requiredNodeMajor = 22;

export async function runSetup(flags = {}) {
  if (flags._?.[0] === "auth") {
    await runAuthSetup(flags);
    return;
  }

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
  checks.push(await credentialStoreCheck());
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
      "kova plan --json",
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

async function runAuthSetup(flags) {
  const method = flags.method ? String(flags.method) : "mock";
  const result = await configureCredentialProvider({
    provider: flags.provider ? String(flags.provider) : "openai",
    method,
    envVar: flags.env_var ? String(flags.env_var) : undefined,
    value: flags.value ? String(flags.value) : undefined,
    externalCli: flags.external_cli ? String(flags.external_cli) : undefined,
    fallbackPolicy: flags.fallback_policy ? String(flags.fallback_policy) : "mock"
  });

  const response = {
    schemaVersion: "kova.setup.auth.v1",
    generatedAt: new Date().toISOString(),
    ok: true,
    credentials: result
  };

  if (flags.json) {
    console.log(JSON.stringify(response, null, 2));
    return;
  }

  console.log(`PASS credentials-dir: ${credentialsDir}`);
  console.log(`PASS providers: ${providersPath}`);
  console.log(`PASS live-env: ${liveEnvPath}`);
  console.log(`PASS provider ${response.credentials.defaultProvider}: ${method}`);
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
  const result = await runCommand(command, { timeoutMs: 30000, maxOutputChars: 1000000 });
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

async function credentialStoreCheck() {
  try {
    const summary = await ensureCredentialStore();
    return {
      id: "credentials",
      required: true,
      status: "PASS",
      path: credentialsDir,
      providersPath,
      liveEnvPath,
      message: `${summary.defaultProvider} ${summary.providers?.[summary.defaultProvider]?.method ?? "mock"}`
    };
  } catch (error) {
    return {
      id: "credentials",
      required: true,
      status: "FAIL",
      path: credentialsDir,
      providersPath,
      liveEnvPath,
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
