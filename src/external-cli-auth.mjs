import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runCommand } from "./commands.mjs";

export function resolveExternalCliName(provider, requested) {
  const implied = impliedExternalCliForProvider(provider);
  if (implied) {
    if (requested && externalCliFromChoice(requested) !== implied) {
      throw new Error(`provider ${provider} uses external CLI ${implied}; do not pass a different --external-cli value`);
    }
    return implied;
  }
  throw new Error(`external-cli auth is only supported for provider openai or anthropic`);
}

export function impliedExternalCliForProvider(provider) {
  if (provider === "openai") {
    return "codex";
  }
  if (provider === "anthropic") {
    return "claude";
  }
  return null;
}

export function externalCliFromChoice(choice) {
  const normalized = String(choice ?? "").trim().toLowerCase().replaceAll("_", "-");
  const aliases = {
    1: "codex",
    codex: "codex",
    "codex-cli": "codex",
    2: "claude",
    claude: "claude",
    "claude-cli": "claude",
    anthropic: "claude"
  };
  if (aliases[normalized]) {
    return aliases[normalized];
  }
  throw new Error(`unknown external CLI: ${choice}`);
}

export async function verifyExternalCliAuth(cli) {
  const binary = await commandPath(cli);
  const checks = [{
    id: `${cli}-binary`,
    ok: Boolean(binary),
    path: binary,
    message: binary ? binary : `${cli} binary not found on PATH`
  }];

  const authEvidence = cli === "codex"
    ? await codexAuthEvidence()
    : await claudeAuthEvidence();
  checks.push(...authEvidence.checks);

  const verified = Boolean(binary) && authEvidence.ok;
  return {
    schemaVersion: "kova.external-cli.verification.v1",
    cli,
    verified,
    binaryPath: binary,
    authFiles: authEvidence.files,
    reason: verified ? "verified" : firstFailedReason(checks),
    checks
  };
}

export function externalCliVerificationSummary(verification) {
  return {
    schemaVersion: verification.schemaVersion,
    cli: verification.cli,
    verified: verification.verified,
    binaryPath: verification.binaryPath,
    authFiles: verification.authFiles,
    reason: verification.reason,
    checks: verification.checks.map((check) => ({
      id: check.id,
      ok: check.ok,
      path: check.path,
      envVar: check.envVar,
      required: check.required !== false,
      message: check.message
    }))
  };
}

async function commandPath(command) {
  const result = await runCommand(`command -v ${quoteWord(command)}`, { timeoutMs: 5000, maxOutputChars: 20000 });
  if (result.status !== 0) {
    return null;
  }
  const path = result.stdout.trim().split(/\r?\n/)[0];
  return path || null;
}

async function codexAuthEvidence() {
  const authJson = join(homedir(), ".codex", "auth.json");
  const configToml = join(homedir(), ".codex", "config.toml");
  const auth = await readableJsonObject(authJson);
  const config = await readableFile(configToml);
  return {
    ok: auth.ok,
    files: [auth.ok ? authJson : null, config.ok ? configToml : null].filter(Boolean),
    checks: [
      {
        id: "codex-auth-json",
        ok: auth.ok,
        path: authJson,
        message: auth.ok ? "readable JSON auth file" : auth.message
      },
      {
        id: "codex-config",
        ok: config.ok,
        path: configToml,
        required: false,
        message: config.ok ? "readable config file" : config.message
      }
    ]
  };
}

async function claudeAuthEvidence() {
  const credentialsJson = join(homedir(), ".claude", ".credentials.json");
  const legacyJson = join(homedir(), ".claude.json");
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const credentials = await readableJsonObject(credentialsJson);
  const legacy = await readableJsonObject(legacyJson);
  const credentialsLooksUsable = credentials.ok && jsonContainsAnyKey(credentials.data, ["claudeAiOauth", "oauthAccount", "accessToken", "refreshToken"]);
  const legacyLooksUsable = legacy.ok && Object.keys(legacy.data ?? {}).length > 0;
  const tokenLooksUsable = typeof token === "string" && token.length > 0;
  return {
    ok: credentialsLooksUsable || legacyLooksUsable || tokenLooksUsable,
    files: [
      credentialsLooksUsable ? credentialsJson : null,
      legacyLooksUsable ? legacyJson : null
    ].filter(Boolean),
    checks: [
      {
        id: "claude-credentials-json",
        ok: credentialsLooksUsable,
        path: credentialsJson,
        message: credentialsLooksUsable ? "readable Claude credentials" : credentials.message
      },
      {
        id: "claude-legacy-json",
        ok: legacyLooksUsable,
        path: legacyJson,
        required: false,
        message: legacyLooksUsable ? "readable Claude legacy auth file" : legacy.message
      },
      {
        id: "claude-oauth-token-env",
        ok: tokenLooksUsable,
        envVar: "CLAUDE_CODE_OAUTH_TOKEN",
        required: false,
        message: tokenLooksUsable ? "token present in host environment" : "CLAUDE_CODE_OAUTH_TOKEN is not set"
      }
    ]
  };
}

async function readableJsonObject(path) {
  try {
    const data = JSON.parse(await readFile(path, "utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { ok: false, data: null, message: "JSON file does not contain an object" };
    }
    return { ok: true, data, message: "ok" };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { ok: false, data: null, message: "file not found" };
    }
    return { ok: false, data: null, message: error.message };
  }
}

async function readableFile(path) {
  try {
    await access(path, constants.R_OK);
    return { ok: true, message: "ok" };
  } catch (error) {
    return { ok: false, message: error.code === "ENOENT" ? "file not found" : error.message };
  }
}

function jsonContainsAnyKey(value, keys) {
  if (!value || typeof value !== "object") {
    return false;
  }
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      return true;
    }
  }
  return Object.values(value).some((item) => jsonContainsAnyKey(item, keys));
}

function firstFailedReason(checks) {
  const failedRequired = checks.find((check) => check.ok !== true && check.required !== false);
  const failed = failedRequired ?? checks.find((check) => check.ok !== true);
  return failed?.message ?? "verification failed";
}

function quoteWord(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
