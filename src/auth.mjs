import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { credentialsDir, liveEnvPath, providersPath, repoRoot } from "./paths.mjs";
import { quoteShell } from "./commands.mjs";

export const authModes = ["mock", "live", "skip"];
export const credentialMethods = ["mock", "api-key", "env-only", "external-cli", "oauth", "skip"];
export const authOverrideModes = ["default", "mock", "live", "skip", "missing", "broken", "none"];

const defaultProviderId = "openai";
const mockApiKey = "kova-mock-key";

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
  metadata.defaultProvider = providerId;
  metadata.providers = {
    ...(metadata.providers ?? {}),
    [providerId]: {
      id: providerId,
      method,
      envVars: method === "api-key" || method === "env-only" ? [envVar] : [],
      externalCli: method === "external-cli" ? (options.externalCli ?? providerId) : null,
      fallbackPolicy: options.fallbackPolicy ?? "mock",
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
  const live = liveCredentialStatus(store);
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
      setup: true,
      commandEnv: env,
      redactionValues: [...(context.auth?.redactionValues ?? []), ...secretValues(env)],
      summary: authDisplay({ mode: "live", providerId, source: live.method, setup: true, envVars: live.envVars })
    };
  }

  return {
    schemaVersion: "kova.auth.policy.v1",
    mode: "mock",
    providerId: defaultProviderId,
    source: "default-mock",
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
      envVars: ["OPENAI_API_KEY"]
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
    commands: [startMockProviderCommand(dir)],
    evidence: ["mock provider port", "mock provider request log", "mock provider health"]
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
    intent: "Configure the disposable OpenClaw env with the selected live provider auth.",
    commands: [configureLiveAuthCommand(authPolicy, envName)],
    evidence: ["OpenClaw config references live auth env vars", "live auth env vars available to OpenClaw runtime"]
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
    setup: policy.setup === true,
    envVars: policy.envVars ?? [],
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
      envVars: authContext.live.envVars,
      reason: authContext.live.reason
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
          envVars,
          reason: `missing env var(s): ${missing.join(", ")}`
        };
      }
    }
    return {
      available: true,
      providerId: provider.id,
      method: provider.method,
      envVars,
      reason: "configured"
    };
  }
  return {
    available: false,
    providerId: defaultId,
    method: providers[defaultId]?.method ?? "mock",
    envVars: providers[defaultId]?.envVars ?? [],
    reason: "no live provider configured"
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

function mockDir(artifactDir) {
  return join(artifactDir, "mock-openai");
}

function startMockProviderCommand(dir) {
  const server = join(repoRoot, "support/mock-openai-server.mjs");
  const portFile = join(dir, "port");
  const requestLog = join(dir, "requests.jsonl");
  const serverLog = join(dir, "server.log");
  const pidFile = join(dir, "pid");
  return [
    `mkdir -p ${quoteShell(dir)}`,
    `node ${quoteShell(server)} --port-file ${quoteShell(portFile)} --request-log ${quoteShell(requestLog)} --marker KOVA_AGENT_OK >${quoteShell(serverLog)} 2>&1 & echo $! >${quoteShell(pidFile)}`,
    `for i in $(seq 1 100); do test -s ${quoteShell(portFile)} && node -e 'fetch("http://127.0.0.1:"+process.argv[1]+"/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' "$(cat ${quoteShell(portFile)})" && exit 0; sleep 0.1; done`,
    `cat ${quoteShell(serverLog)} >&2`,
    "exit 1"
  ].join("; ");
}

function configureMockAuthCommand(envName, dir) {
  return `ocm env exec ${quoteShell(envName)} -- node ${quoteShell(join(repoRoot, "support/configure-openclaw-mock-auth.mjs"))} --port-file ${quoteShell(join(dir, "port"))}`;
}

function configureLiveAuthCommand(authPolicy, envName) {
  const envVar = authPolicy.summary.envVars?.[0] ?? defaultEnvVarForProvider(authPolicy.providerId);
  return `ocm env exec ${quoteShell(envName)} -- node ${quoteShell(join(repoRoot, "support/configure-openclaw-live-auth.mjs"))} --provider ${quoteShell(authPolicy.providerId)} --env-var ${quoteShell(envVar)}`;
}

function defaultEnvVarForProvider(providerId) {
  if (providerId === "anthropic") {
    return "ANTHROPIC_API_KEY";
  }
  if (providerId === "openai-codex") {
    return "OPENAI_API_KEY";
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
