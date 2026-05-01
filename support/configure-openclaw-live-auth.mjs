#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const options = parseArgs(process.argv.slice(2));
const provider = options.provider || "openai";
const envVar = options.envVar || "OPENAI_API_KEY";
const authMethod = options.authMethod || "env";
const externalCli = options.externalCli || null;
const externalRuntime = authMethod === "external-cli"
  ? externalCliRuntimeConfig(provider, externalCli, options.model)
  : null;
const model = externalRuntime?.model || options.model || defaultModel(provider);
const providerKey = externalRuntime?.providerKey || providerConfigKey(provider);

const stateDir = process.env.OPENCLAW_STATE_DIR || path.join(requiredEnv("OPENCLAW_HOME"), ".openclaw");
const configPath = process.env.OPENCLAW_CONFIG_PATH || path.join(stateDir, "openclaw.json");
fs.mkdirSync(path.dirname(configPath), { recursive: true });

let config = {};
try {
  config = JSON.parse(fs.readFileSync(configPath, "utf8"));
} catch {
  config = {};
}

if (authMethod !== "external-cli") {
  const existingProvider = config.models?.providers?.[providerKey] || {};
  config.models = {
    ...(config.models || {}),
    mode: "merge",
    providers: {
      ...(config.models?.providers || {}),
      [providerKey]: {
        ...existingProvider,
        apiKey: {
          source: "env",
          provider: "default",
          id: envVar
        },
        models: mergeModels(existingProvider.models, model)
      }
    }
  };
}

if (externalRuntime?.pluginEntry) {
  config.plugins = {
    ...(config.plugins || {}),
    entries: {
      ...(config.plugins?.entries || {}),
      [externalRuntime.pluginEntry]: {
        ...(config.plugins?.entries?.[externalRuntime.pluginEntry] || {}),
        enabled: true
      }
    }
  };
}

config.agents = {
  ...(config.agents || {}),
  defaults: {
    ...(config.agents?.defaults || {}),
    model: {
      ...(config.agents?.defaults?.model || {}),
      primary: `${providerKey}/${model.id}`
    },
    ...(authMethod === "external-cli" ? {
      agentRuntime: {
        ...(config.agents?.defaults?.agentRuntime || {}),
        id: externalRuntime.agentRuntime,
        fallback: "none"
      }
    } : {})
  }
};

fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
console.log(configPath);

function mergeModels(existing, modelConfig) {
  const models = Array.isArray(existing) ? existing.filter((item) => item?.id !== modelConfig.id) : [];
  return [...models, modelConfig];
}

function defaultModel(provider) {
  if (provider === "anthropic") {
    return {
      id: "claude-sonnet-4-5",
      name: "claude-sonnet-4-5",
      input: ["text"],
      contextWindow: 200000,
      maxTokens: 8192
    };
  }
  return {
    id: "gpt-5.5",
    name: "gpt-5.5",
    api: "openai-responses",
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    contextTokens: 96000,
    maxTokens: 4096
  };
}

function providerConfigKey(provider) {
  return provider;
}

function externalCliRuntimeConfig(provider, cli, modelId) {
  if (provider === "openai" && cli === "codex") {
    return {
      providerKey: "codex",
      agentRuntime: "codex",
      pluginEntry: "codex",
      model: {
        ...defaultModel("openai"),
        id: modelId || "gpt-5.5",
        name: modelId || "gpt-5.5",
        api: "openai-codex-responses",
        contextWindow: 272000,
        contextTokens: 272000,
        maxTokens: 128000
      }
    };
  }
  if (provider === "anthropic" && cli === "claude") {
    return {
      providerKey: "anthropic",
      agentRuntime: "claude-cli",
      pluginEntry: "anthropic",
      model: {
        ...defaultModel("anthropic"),
        id: modelId || "claude-sonnet-4-5",
        name: modelId || "claude-sonnet-4-5"
      }
    };
  }
  throw new Error(`unsupported external CLI runtime for provider ${provider}: ${cli || "<missing>"}`);
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      throw new Error(`unexpected argument: ${arg}`);
    }
    const key = arg.slice(2).replaceAll("-", "");
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${arg} requires a value`);
    }
    parsed[key] = value;
    index += 1;
  }
  return {
    provider: parsed.provider,
    envVar: parsed.envvar,
    authMethod: parsed.authmethod,
    externalCli: parsed.externalcli,
    model: parsed.model
  };
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}
