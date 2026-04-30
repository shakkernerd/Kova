#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const options = parseArgs(process.argv.slice(2));
if (!options.portFile) {
  throw new Error("--port-file is required");
}

const port = fs.readFileSync(options.portFile, "utf8").trim();
if (!/^\d+$/.test(port)) {
  throw new Error(`invalid mock provider port in ${options.portFile}`);
}

const stateDir = process.env.OPENCLAW_STATE_DIR || path.join(requiredEnv("OPENCLAW_HOME"), ".openclaw");
const configPath = process.env.OPENCLAW_CONFIG_PATH || path.join(stateDir, "openclaw.json");
fs.mkdirSync(path.dirname(configPath), { recursive: true });
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(path.join(stateDir, ".env"), "OPENAI_API_KEY=kova-mock-key\n", "utf8");

let config = {};
try {
  config = JSON.parse(fs.readFileSync(configPath, "utf8"));
} catch {
  config = {};
}

const modelRef = "openai/gpt-5.5";
const cost = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0
};

config.models = {
  ...(config.models || {}),
  mode: "merge",
  providers: {
    ...(config.models?.providers || {}),
    openai: {
      ...(config.models?.providers?.openai || {}),
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: {
        source: "env",
        provider: "default",
        id: "OPENAI_API_KEY"
      },
      api: "openai-responses",
      request: {
        ...(config.models?.providers?.openai?.request || {}),
        allowPrivateNetwork: true
      },
      models: [
        {
          id: "gpt-5.5",
          name: "gpt-5.5",
          api: "openai-responses",
          reasoning: false,
          input: ["text"],
          cost,
          contextWindow: 128000,
          contextTokens: 96000,
          maxTokens: 4096
        }
      ]
    }
  }
};

config.agents = {
  ...(config.agents || {}),
  defaults: {
    ...(config.agents?.defaults || {}),
    model: {
      ...(config.agents?.defaults?.model || {}),
      primary: modelRef
    },
    models: {
      ...(config.agents?.defaults?.models || {}),
      [modelRef]: {
        params: {
          ...(config.agents?.defaults?.models?.[modelRef]?.params || {}),
          transport: "sse",
          openaiWsWarmup: false
        }
      }
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
    portFile: parsed.portfile
  };
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}
