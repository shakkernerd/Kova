import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { profilesDir } from "./paths.mjs";

export async function loadProfiles(selectedId) {
  const names = await readdir(profilesDir);
  const paths = names.filter((name) => name.endsWith(".json")).sort();
  const profiles = [];
  const ids = new Set();

  for (const name of paths) {
    const raw = await readFile(join(profilesDir, name), "utf8");
    const profile = JSON.parse(raw);
    validateProfileShape(profile, name);
    if (ids.has(profile.id)) {
      throw new Error(`duplicate profile id '${profile.id}' in ${name}`);
    }
    ids.add(profile.id);
    profiles.push(profile);
  }

  const filtered = selectedId ? profiles.filter((profile) => profile.id === selectedId) : profiles;
  if (filtered.length === 0) {
    throw new Error(`no profile found for ${selectedId}`);
  }
  return filtered;
}

export async function loadProfile(selectedId) {
  const [profile] = await loadProfiles(selectedId);
  return profile;
}

export function validateProfileShape(profile, sourceName = "profile") {
  const errors = [];

  requireString(profile, "id", errors);
  requireString(profile, "title", errors);
  requireString(profile, "objective", errors);
  requireArray(profile, "entries", errors);

  if (typeof profile.id === "string" && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(profile.id)) {
    errors.push("id must be kebab-case lowercase alphanumeric");
  }

  if (Array.isArray(profile.entries)) {
    if (profile.entries.length === 0) {
      errors.push("entries must not be empty");
    }

    for (const [index, entry] of profile.entries.entries()) {
      const prefix = `entries[${index}]`;
      requireString(entry, "scenario", errors, prefix);
      requireString(entry, "state", errors, prefix);
      if (entry.timeoutMs !== undefined && (!Number.isInteger(entry.timeoutMs) || entry.timeoutMs <= 0)) {
        errors.push(`${prefix}.timeoutMs must be a positive integer when set`);
      }
      if (entry.platforms !== undefined) {
        validatePlatforms(entry.platforms, `${prefix}.platforms`, errors);
      }
    }
  }

  if (profile.gate !== undefined) {
    validateGate(profile.gate, "gate", errors);
  }

  if (errors.length > 0) {
    throw new Error(`${sourceName} is invalid:\n- ${errors.join("\n- ")}`);
  }
}

function validateGate(gate, prefix, errors) {
  if (!gate || typeof gate !== "object" || Array.isArray(gate)) {
    errors.push(`${prefix} must be an object`);
    return;
  }
  if (gate.id !== undefined && (typeof gate.id !== "string" || gate.id.length === 0)) {
    errors.push(`${prefix}.id must be a non-empty string when set`);
  }
  for (const key of ["blocking", "warning"]) {
    if (gate[key] === undefined) {
      continue;
    }
    if (!Array.isArray(gate[key])) {
      errors.push(`${prefix}.${key} must be an array`);
      continue;
    }
    for (const [index, entry] of gate[key].entries()) {
      const entryPrefix = `${prefix}.${key}[${index}]`;
      requireString(entry, "scenario", errors, entryPrefix);
      if (entry.state !== undefined && (typeof entry.state !== "string" || entry.state.length === 0)) {
        errors.push(`${entryPrefix}.state must be a non-empty string when set`);
      }
    }
  }
}

function validatePlatforms(platforms, prefix, errors) {
  if (!platforms || typeof platforms !== "object" || Array.isArray(platforms)) {
    errors.push(`${prefix} must be an object`);
    return;
  }
  for (const key of ["include", "exclude"]) {
    if (platforms[key] === undefined) {
      continue;
    }
    if (!Array.isArray(platforms[key])) {
      errors.push(`${prefix}.${key} must be an array`);
      continue;
    }
    for (const [index, value] of platforms[key].entries()) {
      if (typeof value !== "string" || value.length === 0) {
        errors.push(`${prefix}.${key}[${index}] must be a non-empty string`);
      }
    }
  }
}

function requireString(value, key, errors, prefix = "") {
  if (typeof value?.[key] !== "string" || value[key].length === 0) {
    errors.push(`${path(prefix, key)} must be a non-empty string`);
  }
}

function requireArray(value, key, errors, prefix = "") {
  if (!Array.isArray(value?.[key])) {
    errors.push(`${path(prefix, key)} must be an array`);
  }
}

function path(prefix, key) {
  return prefix ? `${prefix}.${key}` : key;
}
