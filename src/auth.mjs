import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { credentialsDir, liveEnvPath, providersPath, repoRoot } from "./paths.mjs";
import { quoteShell } from "./commands.mjs";
import {
  externalCliVerificationSummary,
  resolveExternalCliName,
  verifyExternalCliAuth
} from "./external-cli-auth.mjs";

export const authModes = ["mock", "live", "skip"];
export const credentialMethods = ["mock", "api-key", "env-only", "external-cli", "oauth", "skip"];
export const authOverrideModes = ["default", "mock", "live", "skip", "missing", "broken", "none"];
export const fallbackPolicies = ["mock", "external-cli", "none"];

const defaultProviderId = "openai";
const mockApiKey = "kova-mock-key";
const mockProviderModes = new Set(["normal", "slow", "timeout", "malformed", "streaming-stall", "error-then-recover", "concurrent-pressure"]);

export async function ensureCredentialStore() {
  await mkdir(credentialsDir, { recursive: true });
  if (!(await pathExists(providersPath))) {
    await writeFile(providersPath, `${JSON.stringify(defaultProvidersMetadata(), null, 2)}\n`, "utf8");
  }
  if (!(await pathExists(liveEnvPath))) {
    await writeFile(liveEnvPath, "", { encoding: "utf8", mode: 0o600 });
  }
  await chmod(liveEnvPath, 0o600);
  return credentialStoreSummary(await loadCredentialStore());
}

export async function configureCredentialProvider(options = {}) {
  await ensureCredentialStore();
  const providerId = options.provider ?? defaultProviderId;
  const method = options.method ?? "mock";
  if (!credentialMethods.includes(method)) {
    throw new Error(`unsupported auth method '${method}'; expected one of ${credentialMethods.join(", ")}`);
  }

  const metadata = await readProvidersMetadata();
  const envVar = options.envVar ?? defaultEnvVarForProvider(providerId);
  const fallbackPolicy = normalizeFallbackPolicy(options.fallbackPolicy ?? "mock");
  metadata.defaultProvider = providerId;
  metadata.providers = {
    ...(metadata.providers ?? {}),
    [providerId]: {
      id: providerId,
      method,
      envVars: method === "api-key" || method === "env-only" ? [envVar] : [],
      externalCli: method === "external-cli" ? (options.externalCli ?? providerId) : null,
      fallbackPolicy,
      configuredAt: new Date().toISOString()
    }
  };

  if (method === "api-key") {
    const value = options.value ?? process.env[envVar];
    if (!value) {
      throw new Error(`api-key setup requires --value <secret> or ${envVar} in the host environment`);
    }
    const liveEnv = await loadLiveEnv();
    liveEnv[envVar] = value;
    await writeLiveEnv(liveEnv);
  }

  await writeFile(providersPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  return credentialStoreSummary(await loadCredentialStore());
}

export async function resolveRunAuthContext(flags = {}) {
  const requestedMode = flags.auth ? String(flags.auth) : "mock";
  if (!authModes.includes(requestedMode)) {
    throw new Error(`--auth must be one of ${authModes.join(", ")}`);
  }

  const store = await loadCredentialStore();
  const live = await verifyLiveCredentialStatus(liveCredentialStatus(store));
  if (requestedMode === "live" && !live.available) {
    throw new Error(`--auth live requires configured live credentials: ${live.reason}`);
  }

  return {
    schemaVersion: "kova.auth.context.v1",
    requestedMode,
    credentialStore: credentialStoreSummary(store),
    liveEnv: store.liveEnv,
    live,
    redactionValues: secretValues(store.liveEnv)
  };
}

export function scenarioAuthPolicy(context, scenario, state) {
  const override = normalizeAuthOverride(state?.auth?.mode ?? scenario?.auth?.mode ?? "default");
  if (["skip", "missing", "broken", "none"].includes(override)) {
    return {
      schemaVersion: "kova.auth.policy.v1",
      mode: override,
      providerId: null,
      source: `override:${override}`,
      setup: false,
      commandEnv: {},
      redactionValues: context.auth?.redactionValues ?? [],
      summary: authDisplay({ mode: override, providerId: null, source: `override:${override}`, setup: false })
    };
  }

  const requestedMode = override === "default" ? context.auth?.requestedMode ?? "mock" : override;
  if (requestedMode === "live") {
    const live = context.auth?.live;
    if (!live?.available) {
      throw new Error(`live auth requested but credentials are unavailable: ${live?.reason ?? "not configured"}`);
    }
    const providerId = live.providerId;
    const env = live.envVars.reduce((values, envVar) => {
      if (context.auth.liveEnv[envVar]) {
        values[envVar] = context.auth.liveEnv[envVar];
      } else if (process.env[envVar]) {
        values[envVar] = process.env[envVar];
      }
      return values;
    }, {});
    return {
      schemaVersion: "kova.auth.policy.v1",
      mode: "live",
      providerId,
      source: live.method,
      externalCli: live.externalCli ?? null,
      fallbackFrom: live.fallbackFrom ?? null,
      fallbackPolicy: live.fallbackPolicy ?? null,
      setup: true,
      setupKind: "fixture-config-patch",
      commandEnv: env,
      redactionValues: [...(context.auth?.redactionValues ?? []), ...secretValues(env)],
      summary: authDisplay({
        mode: "live",
        providerId,
        source: live.method,
        externalCli: live.externalCli ?? null,
        fallbackFrom: live.fallbackFrom ?? null,
        fallbackPolicy: live.fallbackPolicy ?? null,
        setup: true,
        setupKind: "fixture-config-patch",
        envVars: live.envVars
      })
    };
  }

  return {
    schemaVersion: "kova.auth.policy.v1",
    mode: "mock",
    providerId: defaultProviderId,
    source: "default-mock",
    mockProvider: mockProviderPolicy(scenario, state),
    setup: true,
    commandEnv: {
      OPENAI_API_KEY: mockApiKey
    },
    redactionValues: [...(context.auth?.redactionValues ?? []), mockApiKey],
    summary: authDisplay({
      mode: "mock",
      providerId: defaultProviderId,
      source: "default-mock",
      setup: true,
      envVars: ["OPENAI_API_KEY"],
      mockProvider: mockProviderPolicy(scenario, state)
    })
  };
}

export function buildAuthPreparePhase(authPolicy, artifactDir) {
  if (authPolicy.mode !== "mock") {
    return null;
  }
  const dir = mockDir(artifactDir);
  return {
    id: "auth-prepare",
    title: "Auth Prepare",
    intent: "Start Kova's deterministic mock provider for the disposable OpenClaw env.",
    commands: [startMockProviderCommand(dir, authPolicy.mockProvider)],
    evidence: ["mock provider port", "mock provider request log", "mock provider behavior mode", "mock provider health"]
  };
}

export function buildAuthSetupPhase(authPolicy, envName, artifactDir) {
  if (!authPolicy.setup) {
    return null;
  }
  if (authPolicy.mode === "mock") {
    const dir = mockDir(artifactDir);
    return {
      id: "auth-setup",
      title: "Auth Setup",
      intent: "Configure the disposable OpenClaw env with Kova's mock provider auth.",
      commands: [configureMockAuthCommand(envName, dir)],
      evidence: ["OpenClaw config points to mock provider", "default agent model is openai/gpt-5.5"]
    };
  }
  return {
    id: "auth-setup",
    title: "Auth Setup",
    intent: "Patch the disposable OpenClaw env with fixture live auth config; this proves runtime behavior, not OpenClaw onboarding/auth UX.",
    commands: [configureLiveAuthCommand(authPolicy, envName)],
    evidence: ["fixture auth config applied", "OpenClaw config references live auth env vars or selected external CLI", "live auth is environment-dependent"]
  };
}

export function buildAuthCleanupPhase(authPolicy, artifactDir) {
  if (authPolicy.mode !== "mock") {
    return null;
  }
  const dir = mockDir(artifactDir);
  return {
    id: "auth-cleanup",
    title: "Auth Cleanup",
    intent: "Stop Kova's deterministic mock provider.",
    commands: [`if test -f ${quoteShell(join(dir, "pid"))}; then kill "$(cat ${quoteShell(join(dir, "pid"))})" 2>/dev/null || true; fi`],
    evidence: ["mock provider stopped"]
  };
}

export function authDisplay(policy) {
  return {
    schemaVersion: "kova.auth.summary.v1",
    mode: policy.mode,
    providerId: policy.providerId ?? null,
    source: policy.source,
    externalCli: policy.externalCli ?? null,
    fallbackFrom: policy.fallbackFrom ?? null,
    fallbackPolicy: policy.fallbackPolicy ?? null,
    setup: policy.setup === true,
    setupKind: policy.setupKind ?? null,
    deterministic: policy.mode === "mock",
    environmentDependent: policy.mode === "live",
    envVars: policy.envVars ?? [],
    mockProvider: policy.mockProvider ? mockProviderDisplay(policy.mockProvider) : null,
    secretValues: "redacted"
  };
}

export function authReportSummary(authContext) {
  return {
    schemaVersion: "kova.auth.report.v1",
    requestedMode: authContext.requestedMode,
    credentialStore: authContext.credentialStore,
    live: {
      available: authContext.live.available,
      providerId: authContext.live.providerId,
      method: authContext.live.method,
      externalCli: authContext.live.externalCli ?? null,
      fallbackFrom: authContext.live.fallbackFrom ?? null,
      fallbackPolicy: authContext.live.fallbackPolicy ?? null,
      verification: authContext.live.verification ?? null,
      envVars: authContext.live.envVars,
      reason: authContext.live.reason,
      environmentDependent: authContext.requestedMode === "live"
    }
  };
}

export async function loadCredentialStore() {
  const providers = await readProvidersMetadata();
  const liveEnv = await loadLiveEnv();
  return {
    schemaVersion: "kova.credentials.store.v1",
    providers,
    liveEnv
  };
}

function defaultProvidersMetadata() {
  return {
    schemaVersion: "kova.credentials.providers.v1",
    defaultProvider: defaultProviderId,
    providers: {
      [defaultProviderId]: {
        id: defaultProviderId,
        method: "mock",
        envVars: ["OPENAI_API_KEY"],
        fallbackPolicy: "mock",
        configuredAt: null
      }
    }
  };
}

async function readProvidersMetadata() {
  try {
    const text = await readFile(providersPath, "utf8");
    const metadata = JSON.parse(text);
    validateProvidersMetadata(metadata);
    return metadata;
  } catch (error) {
    if (error.code === "ENOENT") {
      return defaultProvidersMetadata();
    }
    throw error;
  }
}

function validateProvidersMetadata(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("providers.json must contain an object");
  }
  if (metadata.schemaVersion !== "kova.credentials.providers.v1") {
    throw new Error("providers.json schemaVersion must be kova.credentials.providers.v1");
  }
  if (!metadata.providers || typeof metadata.providers !== "object" || Array.isArray(metadata.providers)) {
    throw new Error("providers.json providers must be an object");
  }
  for (const [id, provider] of Object.entries(metadata.providers)) {
    if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
      throw new Error(`providers.${id} must be an object`);
    }
    if (provider.id !== id) {
      throw new Error(`providers.${id}.id must match provider key`);
    }
    if (!credentialMethods.includes(provider.method)) {
      throw new Error(`providers.${id}.method must be one of ${credentialMethods.join(", ")}`);
    }
    if (provider.fallbackPolicy !== undefined && !fallbackPolicies.includes(provider.fallbackPolicy)) {
      throw new Error(`providers.${id}.fallbackPolicy must be one of ${fallbackPolicies.join(", ")}`);
    }
    if (provider.envVars !== undefined && !Array.isArray(provider.envVars)) {
      throw new Error(`providers.${id}.envVars must be an array`);
    }
  }
}

async function loadLiveEnv() {
  try {
    return parseEnvFile(await readFile(liveEnvPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function writeLiveEnv(values) {
  const text = Object.entries(values)
    .map(([key, value]) => `${key}=${escapeEnvValue(value)}`)
    .join("\n");
  await writeFile(liveEnvPath, text ? `${text}\n` : "", { encoding: "utf8", mode: 0o600 });
  await chmod(liveEnvPath, 0o600);
}

function parseEnvFile(text) {
  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const index = line.indexOf("=");
    if (index <= 0) {
      throw new Error(`invalid live.env line: ${rawLine}`);
    }
    const key = line.slice(0, index).trim();
    const value = unquoteEnvValue(line.slice(index + 1).trim());
    values[key] = value;
  }
  return values;
}

function escapeEnvValue(value) {
  const string = String(value);
  if (/^[A-Za-z0-9_./:@+-]*$/.test(string)) {
    return string;
  }
  return JSON.stringify(string);
}

function unquoteEnvValue(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  return value;
}

function liveCredentialStatus(store) {
  const providers = store.providers.providers ?? {};
  const defaultId = store.providers.defaultProvider ?? defaultProviderId;
  const candidates = [providers[defaultId], ...Object.values(providers).filter((provider) => provider?.id !== defaultId)].filter(Boolean);
  for (const provider of candidates) {
    if (!provider || provider.method === "mock" || provider.method === "skip") {
      continue;
    }
    const envVars = provider.envVars ?? [];
    if (provider.method === "api-key" || provider.method === "env-only") {
      const missing = envVars.filter((envVar) => !store.liveEnv[envVar] && !process.env[envVar]);
      if (missing.length > 0) {
        return {
          available: false,
          providerId: provider.id,
          method: provider.method,
          fallbackPolicy: provider.fallbackPolicy ?? "mock",
          envVars,
          reason: `missing env var(s): ${missing.join(", ")}`
        };
      }
    }
    return {
      available: true,
      providerId: provider.id,
      method: provider.method,
      externalCli: provider.externalCli ?? null,
      fallbackPolicy: provider.fallbackPolicy ?? "mock",
      envVars,
      reason: "configured"
    };
  }
  return {
    available: false,
    providerId: defaultId,
    method: providers[defaultId]?.method ?? "mock",
    externalCli: providers[defaultId]?.externalCli ?? null,
    fallbackPolicy: providers[defaultId]?.fallbackPolicy ?? "mock",
    envVars: providers[defaultId]?.envVars ?? [],
    reason: "no live provider configured"
  };
}

async function verifyLiveCredentialStatus(status) {
  if (status.available === false && status.fallbackPolicy === "external-cli") {
    try {
      const externalCli = resolveExternalCliName(status.providerId);
      const verification = await verifyExternalCliAuth(externalCli);
      return {
        ...status,
        available: verification.verified,
        method: "external-cli",
        externalCli,
        fallbackFrom: status.method,
        envVars: [],
        reason: verification.verified ? "configured via external-cli fallback" : `external-cli ${externalCli} is not usable: ${verification.reason}`,
        verification: externalCliVerificationSummary(verification)
      };
    } catch (error) {
      return {
        ...status,
        available: false,
        reason: `${status.reason}; external-cli fallback unavailable: ${error.message}`
      };
    }
  }
  if (status.method !== "external-cli") {
    return status;
  }
  if (!status.externalCli) {
    return {
      ...status,
      available: false,
      reason: "external-cli provider has no externalCli value"
    };
  }
  const verification = await verifyExternalCliAuth(status.externalCli);
  return {
    ...status,
    available: verification.verified,
    reason: verification.verified ? "configured" : `external-cli ${status.externalCli} is not usable: ${verification.reason}`,
    verification: externalCliVerificationSummary(verification)
  };
}

function credentialStoreSummary(store) {
  const providers = store.providers.providers ?? {};
  return {
    schemaVersion: "kova.credentials.summary.v1",
    home: credentialsDir,
    providersPath,
    liveEnvPath,
    defaultProvider: store.providers.defaultProvider ?? defaultProviderId,
    providers: Object.fromEntries(Object.entries(providers).map(([id, provider]) => [id, {
      id,
      method: provider.method,
      envVars: provider.envVars ?? [],
      fallbackPolicy: provider.fallbackPolicy ?? "mock",
      externalCli: provider.externalCli ?? null,
      configured: provider.method !== "mock" && provider.method !== "skip"
    }]))
  };
}

function secretValues(values) {
  return Object.values(values ?? {}).filter((value) => typeof value === "string" && value.length > 0);
}

function normalizeAuthOverride(value) {
  const mode = value ?? "default";
  if (!authOverrideModes.includes(mode)) {
    throw new Error(`auth.mode must be one of ${authOverrideModes.join(", ")}`);
  }
  return mode;
}

function normalizeFallbackPolicy(value) {
  const normalized = String(value ?? "mock").trim().toLowerCase().replaceAll("_", "-");
  const aliases = {
    mock: "mock",
    default: "mock",
    "external-cli": "external-cli",
    external: "external-cli",
    cli: "external-cli",
    none: "none",
    skip: "none",
    disabled: "none"
  };
  if (aliases[normalized]) {
    return aliases[normalized];
  }
  throw new Error(`fallbackPolicy must be one of ${fallbackPolicies.join(", ")}`);
}

function mockDir(artifactDir) {
  return join(artifactDir, "mock-openai");
}

function startMockProviderCommand(dir, mockProvider = {}) {
  const server = join(repoRoot, "support/mock-openai-server.mjs");
  const portFile = join(dir, "port");
  const requestLog = join(dir, "requests.jsonl");
  const serverLog = join(dir, "server.log");
  const pidFile = join(dir, "pid");
  const mode = mockProvider.mode ?? "normal";
  const args = [
    "--port-file", portFile,
    "--request-log", requestLog,
    "--marker", "KOVA_AGENT_OK",
    "--mode", mode
  ];
  for (const [key, flag] of [
    ["delayMs", "--delay-ms"],
    ["stallMs", "--stall-ms"],
    ["errorStatus", "--error-status"]
  ]) {
    if (mockProvider[key] !== undefined) {
      args.push(flag, String(mockProvider[key]));
    }
  }
  const argText = args.map(quoteShell).join(" ");
  return [
    `mkdir -p ${quoteShell(dir)}`,
    `node ${quoteShell(server)} ${argText} >${quoteShell(serverLog)} 2>&1 & echo $! >${quoteShell(pidFile)}`,
    `for i in $(seq 1 100); do test -s ${quoteShell(portFile)} && node -e 'fetch("http://127.0.0.1:"+process.argv[1]+"/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' "$(cat ${quoteShell(portFile)})" && exit 0; sleep 0.1; done`,
    `cat ${quoteShell(serverLog)} >&2`,
    "exit 1"
  ].join("; ");
}

function mockProviderPolicy(scenario, state) {
  const raw = {
    ...(state?.mockProvider ?? {}),
    ...(scenario?.mockProvider ?? {})
  };
  const mode = raw.mode ?? "normal";
  if (!mockProviderModes.has(mode)) {
    throw new Error(`mockProvider.mode must be one of ${[...mockProviderModes].join(", ")}`);
  }
  const policy = { mode };
  for (const key of ["delayMs", "stallMs", "errorStatus"]) {
    if (raw[key] !== undefined) {
      const value = Number(raw[key]);
      if (!Number.isInteger(value) || value < 0) {
        throw new Error(`mockProvider.${key} must be a non-negative integer`);
      }
      policy[key] = value;
    }
  }
  return policy;
}

function mockProviderDisplay(policy) {
  return {
    mode: policy.mode,
    delayMs: policy.delayMs ?? null,
    stallMs: policy.stallMs ?? null,
    errorStatus: policy.errorStatus ?? null
  };
}

function configureMockAuthCommand(envName, dir) {
  return `ocm env exec ${quoteShell(envName)} -- node ${quoteShell(join(repoRoot, "support/configure-openclaw-mock-auth.mjs"))} --port-file ${quoteShell(join(dir, "port"))}`;
}

function configureLiveAuthCommand(authPolicy, envName) {
  const envVar = authPolicy.summary.envVars?.[0] ?? defaultEnvVarForProvider(authPolicy.providerId);
  const externalCliArgs = authPolicy.source === "external-cli" && authPolicy.externalCli
    ? ` --auth-method external-cli --external-cli ${quoteShell(authPolicy.externalCli)}`
    : "";
  return `ocm env exec ${quoteShell(envName)} -- node ${quoteShell(join(repoRoot, "support/configure-openclaw-live-auth.mjs"))} --provider ${quoteShell(authPolicy.providerId)} --env-var ${quoteShell(envVar)}${externalCliArgs}`;
}

function defaultEnvVarForProvider(providerId) {
  if (providerId === "anthropic") {
    return "ANTHROPIC_API_KEY";
  }
  return "OPENAI_API_KEY";
}

async function pathExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
