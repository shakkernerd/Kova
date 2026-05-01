import { pathToFileURL } from "node:url";
import path from "node:path";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";

export async function importOpenClawDistModule(relativePath) {
  const packageRoot = process.cwd();
  const absolutePath = path.join(packageRoot, "dist", ...relativePath.split("/"));
  try {
    return await import(pathToFileURL(absolutePath).href);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `failed to import OpenClaw runtime module ${relativePath} from ${packageRoot}: ${message}. ` +
        "Kova user-message scenarios require a built/release-shaped OpenClaw runtime."
    );
  }
}

export function prepareOpenClawRuntimeFromOcmEnv(envName) {
  if (!envName) {
    throw new Error("--env is required");
  }
  const status = runOcmJson(["env", "status", envName, "--json"]);
  const resolved = runOcmJson(["env", "resolve", envName, "--json", "--", "status"]);
  const root = readRequiredString(status.root, "ocm env status root");
  const port = Number(status.gatewayPort);
  const binaryPath = readRequiredString(resolved.binaryPath, "ocm env resolve binaryPath");
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`invalid gateway port from OCM status: ${JSON.stringify(status.gatewayPort)}`);
  }
  const packageRoot = dirname(binaryPath);
  process.env.OPENCLAW_HOME = root;
  process.env.OPENCLAW_GATEWAY_PORT = String(port);
  process.chdir(packageRoot);
  return {
    envName,
    root,
    gatewayPort: port,
    binaryPath,
    packageRoot,
    runtime: {
      bindingKind: resolved.bindingKind ?? null,
      bindingName: resolved.bindingName ?? null,
      releaseVersion: resolved.runtimeReleaseVersion ?? null,
      releaseChannel: resolved.runtimeReleaseChannel ?? null,
      sourceKind: resolved.runtimeSourceKind ?? null
    }
  };
}

export function parseSupportArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      throw new Error(`unexpected argument: ${arg}`);
    }
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${arg} requires a value`);
    }
    parsed[key] = value;
    index += 1;
  }
  return parsed;
}

export function readTimeoutMs(value, fallbackMs) {
  if (value === undefined) {
    return fallbackMs;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`invalid timeout: ${value}`);
  }
  return parsed;
}

export function runOcmJson(args) {
  let stdout = "";
  try {
    stdout = execFileSync("ocm", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    const stderr = error?.stderr ? String(error.stderr) : "";
    throw new Error(`ocm ${args.join(" ")} failed: ${stderr.trim() || error.message}`);
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`ocm ${args.join(" ")} did not return JSON: ${stdout.slice(0, 1000)}`);
  }
}

export function runOcmText(args) {
  try {
    return execFileSync("ocm", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    const stderr = error?.stderr ? String(error.stderr) : "";
    throw new Error(`ocm ${args.join(" ")} failed: ${stderr.trim() || error.message}`);
  }
}

function readRequiredString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} missing`);
  }
  return value;
}

export function extractText(value) {
  if (typeof value === "string") {
    return value;
  }
  if (!value || typeof value !== "object") {
    return "";
  }
  if (Array.isArray(value)) {
    return value.map(extractText).filter(Boolean).join("\n");
  }
  for (const key of ["finalAssistantVisibleText", "finalAssistantRawText", "text", "content", "reply"]) {
    if (typeof value[key] === "string") {
      return value[key];
    }
  }
  return Object.values(value).map(extractText).filter(Boolean).join("\n");
}

export async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function finishJson(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

export function failJson(error, extra = {}) {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(`${JSON.stringify({ ok: false, error: message, ...extra }, null, 2)}\n`);
  process.exit(1);
}
