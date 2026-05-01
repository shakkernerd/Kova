#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const port = await reserveClosedPort();
const stateDir = process.env.OPENCLAW_STATE_DIR || path.join(requiredEnv("OPENCLAW_HOME"), ".openclaw");
const configPath = process.env.OPENCLAW_CONFIG_PATH || path.join(stateDir, "openclaw.json");
fs.mkdirSync(path.dirname(configPath), { recursive: true });
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(path.join(stateDir, ".env"), "OPENAI_API_KEY=kova-network-offline-key\n", "utf8");

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
console.log(JSON.stringify({
  schemaVersion: "kova.openclawProviderBlackhole.v1",
  configPath,
  baseUrl: `http://127.0.0.1:${port}/v1`
}));

async function reserveClosedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const selected = address?.port;
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  if (!Number.isInteger(selected) || selected <= 0) {
    throw new Error("failed to reserve a closed localhost port");
  }
  return selected;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}
