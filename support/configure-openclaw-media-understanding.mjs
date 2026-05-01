#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const options = parseArgs(process.argv.slice(2));
const timeoutMs = positiveInteger(options.timeoutMs ?? "1200", "--timeout-ms");
const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
const stateDir = process.env.OPENCLAW_STATE_DIR || path.join(requiredEnv("OPENCLAW_HOME"), ".openclaw");
const configPath = process.env.OPENCLAW_CONFIG_PATH || path.join(stateDir, "openclaw.json");

let config = {};
try {
  config = JSON.parse(fs.readFileSync(configPath, "utf8"));
} catch {
  config = {};
}

const openaiProvider = config.models?.providers?.openai || {};
const models = Array.isArray(openaiProvider.models)
  ? openaiProvider.models.filter((model) => model?.id !== "gpt-5.5")
  : [];

config.models = {
  ...(config.models || {}),
  mode: "merge",
  providers: {
    ...(config.models?.providers || {}),
    openai: {
      ...openaiProvider,
      models: [
        ...models,
        {
          id: "gpt-5.5",
          name: "gpt-5.5",
          api: "openai-responses",
          reasoning: false,
          input: ["text", "image"],
          contextWindow: 128000,
          contextTokens: 96000,
          maxTokens: 4096
        }
      ]
    }
  }
};

config.tools = {
  ...(config.tools || {}),
  media: {
    ...(config.tools?.media || {}),
    image: {
      ...(config.tools?.media?.image || {}),
      enabled: true,
      timeoutSeconds,
      models: [
        {
          provider: "openai",
          model: "gpt-5.5",
          capabilities: ["image"],
          timeoutSeconds
        }
      ]
    }
  }
};

fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
console.log(configPath);

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
    timeoutMs: parsed.timeoutms
  };
}

function positiveInteger(value, flag) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return number;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}
