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
  const auth = await setupAuth(flags);

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
  checks.push(await credentialStoreCheck(auth));
  checks.push(skillGuidanceCheck());

  const ok = checks.every((check) => !check.required || check.status === "PASS");
  const result = {
    schemaVersion: "kova.setup.v1",
    generatedAt: new Date().toISOString(),
    mode: flags.ci ? "ci" : "local",
    ok,
    platform: platformInfo(),
    auth,
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
  const auth = await configureAuthFromFlags(flags, { defaultMethod: "mock" });

  const response = {
    schemaVersion: "kova.setup.auth.v1",
    generatedAt: new Date().toISOString(),
    ok: true,
    auth
  };

  if (flags.json) {
    console.log(JSON.stringify(response, null, 2));
    return;
  }

  console.log(`PASS credentials-dir: ${credentialsDir}`);
  console.log(`PASS providers: ${providersPath}`);
  console.log(`PASS live-env: ${liveEnvPath}`);
  console.log(`PASS provider ${response.auth.provider}: ${response.auth.method}`);
}

async function setupAuth(flags) {
  if (flags.ci === true && flags.auth === undefined && flags.method === undefined) {
    return configureAuthFromFlags({ ...flags, auth: "mock" }, { defaultMethod: "mock" });
  }
  if (flags.non_interactive === true || flags.auth !== undefined || flags.method !== undefined) {
    return configureAuthFromFlags(flags, { defaultMethod: "mock" });
  }
  if (!process.stdin.isTTY) {
    throw new Error("kova setup requires --non-interactive or --ci when stdin is not a TTY");
  }
  return interactiveAuthSetup(flags);
}

async function configureAuthFromFlags(flags, options = {}) {
  const method = setupAuthMethod(flags, options.defaultMethod ?? "mock");
  const provider = flags.provider ? String(flags.provider) : "openai";
  const envVar = flags.env_var ? String(flags.env_var) : undefined;
  const summary = await configureCredentialProvider({
    provider,
    method,
    envVar,
    value: flags.value ? String(flags.value) : undefined,
    externalCli: flags.external_cli ? String(flags.external_cli) : undefined,
    fallbackPolicy: flags.fallback_policy ? String(flags.fallback_policy) : "mock"
  });
  return {
    schemaVersion: "kova.setup.auth.result.v1",
    mode: method === "skip" ? "skip" : method === "mock" ? "mock" : "live",
    method,
    provider,
    envVar: envVar ?? defaultEnvVarForProvider(provider),
    credentials: summary
  };
}

function setupAuthMethod(flags, fallback) {
  const raw = flags.auth ?? flags.method ?? fallback;
  const method = String(raw);
  if (method === "live") {
    throw new Error("--auth live is for runs; setup needs --auth api-key, env-only, external-cli, oauth, mock, or skip");
  }
  return method;
}

async function interactiveAuthSetup(flags) {
  const provider = flags.provider ? String(flags.provider) : "openai";
  console.log("Kova auth setup");
  console.log("");
  console.log("Choose auth method:");
  console.log("  1. mock (default)");
  console.log("  2. env-only");
  console.log("  3. api-key");
  console.log("  4. external-cli");
  console.log("  5. oauth");
  console.log("  6. skip");
  const choice = (await prompt("Auth method [mock]: ")).trim().toLowerCase();
  const method = methodFromChoice(choice);
  const envVar = method === "api-key" || method === "env-only"
    ? (await prompt(`Env var [${defaultEnvVarForProvider(provider)}]: `)).trim() || defaultEnvVarForProvider(provider)
    : undefined;
  const value = method === "api-key"
    ? await promptSecret(`Value for ${envVar} (leave empty to read host env): `)
    : undefined;
  return configureAuthFromFlags({
    ...flags,
    auth: method,
    provider,
    env_var: envVar,
    value: value || undefined
  }, { defaultMethod: "mock" });
}

function methodFromChoice(choice) {
  if (!choice || choice === "1" || choice === "mock") {
    return "mock";
  }
  if (choice === "2" || choice === "env-only") {
    return "env-only";
  }
  if (choice === "3" || choice === "api-key") {
    return "api-key";
  }
  if (choice === "4" || choice === "external-cli") {
    return "external-cli";
  }
  if (choice === "5" || choice === "oauth") {
    return "oauth";
  }
  if (choice === "6" || choice === "skip") {
    return "skip";
  }
  throw new Error(`unknown auth method choice: ${choice}`);
}

function prompt(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    process.stdin.resume();
    process.stdin.once("data", (chunk) => {
      process.stdin.pause();
      resolve(chunk.toString("utf8").replace(/\r?\n$/, ""));
    });
  });
}

async function promptSecret(question) {
  return prompt(question);
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

async function credentialStoreCheck(auth) {
  try {
    const summary = await ensureCredentialStore();
    return {
      id: "credentials",
      required: true,
      status: "PASS",
      path: credentialsDir,
      providersPath,
      liveEnvPath,
      message: `${auth?.provider ?? summary.defaultProvider} ${auth?.method ?? summary.providers?.[summary.defaultProvider]?.method ?? "mock"}`
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

function defaultEnvVarForProvider(providerId) {
  if (providerId === "anthropic") {
    return "ANTHROPIC_API_KEY";
  }
  return "OPENAI_API_KEY";
}

function skillGuidanceCheck() {
  return {
    id: "ocm-operator-skill",
    required: false,
    status: "INFO",
    message: "For Codex/agent runs, install or load https://github.com/shakkernerd/ocm/tree/main/skills/ocm-operator"
  };
}
