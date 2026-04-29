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
    }
  }

  if (errors.length > 0) {
    throw new Error(`${sourceName} is invalid:\n- ${errors.join("\n- ")}`);
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
