#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const options = parseArgs(process.argv.slice(2));
const provider = options.provider || "openai";
const envVar = options.envVar || "OPENAI_API_KEY";
const model = options.model || defaultModel(provider);
const providerKey = providerConfigKey(provider);

const stateDir = process.env.OPENCLAW_STATE_DIR || path.join(requiredEnv("OPENCLAW_HOME"), ".openclaw");
const configPath = process.env.OPENCLAW_CONFIG_PATH || path.join(stateDir, "openclaw.json");
fs.mkdirSync(path.dirname(configPath), { recursive: true });

let config = {};
try {
  config = JSON.parse(fs.readFileSync(configPath, "utf8"));
} catch {
  config = {};
}

config.models = {
  ...(config.models || {}),
  mode: "merge",
  providers: {
    ...(config.models?.providers || {}),
    [providerKey]: {
      ...(config.models?.providers?.[providerKey] || {}),
      apiKey: {
        source: "env",
        provider: "default",
        id: envVar
      },
      models: mergeModels(config.models?.providers?.[providerKey]?.models, model)
    }
  }
};

config.agents = {
  ...(config.agents || {}),
  defaults: {
    ...(config.agents?.defaults || {}),
    model: {
      ...(config.agents?.defaults?.model || {}),
      primary: `${providerKey}/${model.id}`
    }
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
  if (provider === "openai-codex") {
    return "openai";
  }
  return provider;
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
    envVar: parsed.envvar
  };
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}
