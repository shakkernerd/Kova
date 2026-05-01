import { pathToFileURL } from "node:url";
import path from "node:path";

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
