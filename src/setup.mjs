import { access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { checkCommand, runCommand } from "./commands.mjs";
import {
  externalCliFromChoice,
  externalCliVerificationSummary,
  impliedExternalCliForProvider,
  resolveExternalCliName,
  verifyExternalCliAuth
} from "./external-cli-auth.mjs";
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
  const provider = normalizeProvider(flags.provider ? String(flags.provider) : "openai");
  const envVar = flags.env_var ? String(flags.env_var) : undefined;
  const externalCli = method === "external-cli"
    ? resolveExternalCliName(provider, flags.external_cli ? String(flags.external_cli) : undefined)
    : undefined;
  const verification = method === "external-cli"
    ? await verifyExternalCliAuth(externalCli)
    : null;
  if (verification && !verification.verified) {
    throw new Error(`external-cli ${externalCli} is not usable: ${verification.reason}`);
  }
  const summary = await configureCredentialProvider({
    provider,
    method,
    envVar,
    value: flags.value ? String(flags.value) : undefined,
    externalCli,
    fallbackPolicy: flags.fallback_policy ? String(flags.fallback_policy) : "mock"
  });
  return {
    schemaVersion: "kova.setup.auth.result.v1",
    mode: method === "skip" ? "skip" : method === "mock" ? "mock" : "live",
    method,
    provider,
    externalCli: externalCli ?? null,
    verification: verification ? externalCliVerificationSummary(verification) : null,
    envVar: envVar ?? defaultEnvVarForProvider(provider),
    credentials: summary
  };
}

function setupAuthMethod(flags, fallback) {
  const raw = flags.auth ?? flags.method ?? fallback;
  const method = normalizeAuthMethod(String(raw));
  if (method === "live") {
    throw new Error("--auth live is for runs; setup needs --auth api-key, env-only, external-cli, oauth, mock, or skip");
  }
  return method;
}

async function interactiveAuthSetup(flags) {
  console.log("Kova auth setup");
  console.log("");
  console.log("Choose provider:");
  console.log("  1. openai (default)");
  console.log("  2. anthropic");
  console.log("  3. openai-codex");
  console.log("  4. claude-cli");
  console.log("  5. custom-openai");
  console.log("  6. skip");
  const providerChoice = flags.provider
    ? String(flags.provider)
    : (await prompt("Provider [openai]: ")).trim().toLowerCase();
  const provider = providerFromChoice(providerChoice);
  if (provider === "skip") {
    return configureAuthFromFlags({
      ...flags,
      auth: "skip",
      provider: "openai"
    }, { defaultMethod: "mock" });
  }

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
  const externalCli = method === "external-cli"
    ? await promptExternalCli(provider)
    : undefined;
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
    external_cli: externalCli,
    env_var: envVar,
    value: value || undefined
  }, { defaultMethod: "mock" });
}

async function promptExternalCli(provider) {
  const implied = impliedExternalCliForProvider(provider);
  if (implied) {
    return implied;
  }
  console.log("");
  console.log("Choose external CLI:");
  console.log("  1. codex");
  console.log("  2. claude");
  const choice = (await prompt("External CLI [codex]: ")).trim().toLowerCase();
  return externalCliFromChoice(choice || "codex");
}

function methodFromChoice(choice) {
  if (!choice) {
    return "mock";
  }
  const byNumber = {
    1: "mock",
    2: "env-only",
    3: "api-key",
    4: "external-cli",
    5: "oauth",
    6: "skip"
  };
  if (byNumber[choice]) {
    return byNumber[choice];
  }
  return normalizeAuthMethod(choice);
}

function normalizeAuthMethod(value) {
  const normalized = String(value ?? "").trim().toLowerCase().replaceAll("_", "-");
  const aliases = {
    1: "mock",
    mock: "mock",
    local: "mock",
    2: "env-only",
    "env-only": "env-only",
    env: "env-only",
    environment: "env-only",
    3: "api-key",
    "api-key": "api-key",
    apikey: "api-key",
    key: "api-key",
    4: "external-cli",
    "external-cli": "external-cli",
    external: "external-cli",
    cli: "external-cli",
    5: "oauth",
    oauth: "oauth",
    "oauth-browser": "oauth",
    6: "skip",
    skip: "skip",
    none: "skip"
  };
  if (aliases[normalized]) {
    return aliases[normalized];
  }
  throw new Error(`unknown auth method: ${value}`);
}

function providerFromChoice(choice) {
  const normalized = String(choice ?? "").trim().toLowerCase().replaceAll("_", "-");
  if (!normalized) {
    return "openai";
  }
  const byNumber = {
    1: "openai",
    2: "anthropic",
    3: "openai-codex",
    4: "claude-cli",
    5: "custom-openai",
    6: "skip"
  };
  if (byNumber[normalized]) {
    return byNumber[normalized];
  }
  return normalizeProvider(normalized);
}

function normalizeProvider(value) {
  const normalized = String(value ?? "").trim().toLowerCase().replaceAll("_", "-");
  const aliases = {
    1: "openai",
    openai: "openai",
    2: "anthropic",
    anthropic: "anthropic",
    claude: "anthropic",
    3: "openai-codex",
    "openai-codex": "openai-codex",
    codex: "openai-codex",
    "codex-cli": "openai-codex",
    4: "claude-cli",
    "claude-cli": "claude-cli",
    5: "custom-openai",
    "custom-openai": "custom-openai",
    custom: "custom-openai",
    "openai-compatible": "custom-openai",
    6: "skip",
    skip: "skip"
  };
  if (aliases[normalized]) {
    return aliases[normalized];
  }
  throw new Error(`unknown provider: ${value}`);
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
    if (auth?.method === "external-cli" && auth?.verification?.verified !== true) {
      throw new Error(`external-cli ${auth?.externalCli ?? "unknown"} is not verified`);
    }
    const summary = await ensureCredentialStore();
    return {
      id: "credentials",
      required: true,
      status: "PASS",
      path: credentialsDir,
      providersPath,
      liveEnvPath,
      message: credentialStoreMessage(auth, summary)
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

function credentialStoreMessage(auth, summary) {
  const provider = auth?.provider ?? summary.defaultProvider;
  const method = auth?.method ?? summary.providers?.[summary.defaultProvider]?.method ?? "mock";
  if (method === "external-cli") {
    return `${provider} external-cli ${auth.externalCli} verified`;
  }
  return `${provider} ${method}`;
}

function defaultEnvVarForProvider(providerId) {
  if (providerId === "anthropic") {
    return "ANTHROPIC_API_KEY";
  }
  if (providerId === "claude-cli") {
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
