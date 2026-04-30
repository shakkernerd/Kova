import { profilesDir } from "../paths.mjs";
import { assertNoShapeErrors, loadJsonRegistry, requireArray, requireKebabId, requireString } from "./validate.mjs";

export async function loadProfiles(selectedId) {
  return loadJsonRegistry({
    dir: profilesDir,
    kind: "profile",
    selectedId,
    validate: validateProfileShape
  });
}

export async function loadProfile(selectedId) {
  const [profile] = await loadProfiles(selectedId);
  return profile;
}

export function validateProfileShape(profile, sourceName = "profile") {
  const errors = [];

  requireKebabId(profile, "id", errors);
  requireString(profile, "title", errors);
  requireString(profile, "objective", errors);
  requireArray(profile, "entries", errors);
  validateEntries(profile.entries, errors);

  if (profile.gate !== undefined) {
    validateGate(profile.gate, "gate", errors);
  }

  assertNoShapeErrors(errors, sourceName);
}

function validateEntries(entries, errors) {
  if (!Array.isArray(entries)) {
    return;
  }
  if (entries.length === 0) {
    errors.push("entries must not be empty");
  }
  for (const [index, entry] of entries.entries()) {
    const prefix = `entries[${index}]`;
    requireKebabId(entry, "scenario", errors, prefix);
    requireKebabId(entry, "state", errors, prefix);
    if (entry.timeoutMs !== undefined && (!Number.isInteger(entry.timeoutMs) || entry.timeoutMs <= 0)) {
      errors.push(`${prefix}.timeoutMs must be a positive integer when set`);
    }
    if (entry.platforms !== undefined) {
      validatePlatforms(entry.platforms, `${prefix}.platforms`, errors);
    }
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
  validateGateEntries(gate.blocking, `${prefix}.blocking`, errors);
  validateGateEntries(gate.warning, `${prefix}.warning`, errors);
  validateCoverage(gate.coverage, `${prefix}.coverage`, errors);
}

function validateGateEntries(entries, prefix, errors) {
  if (entries === undefined) {
    return;
  }
  if (!Array.isArray(entries)) {
    errors.push(`${prefix} must be an array`);
    return;
  }
  for (const [index, entry] of entries.entries()) {
    const entryPrefix = `${prefix}[${index}]`;
    requireKebabId(entry, "scenario", errors, entryPrefix);
    if (entry.state !== undefined) {
      requireKebabId(entry, "state", errors, entryPrefix);
    }
  }
}

function validateCoverage(coverage, prefix, errors) {
  if (coverage === undefined) {
    return;
  }
  if (!coverage || typeof coverage !== "object" || Array.isArray(coverage)) {
    errors.push(`${prefix} must be an object`);
    return;
  }
  for (const key of ["surfaces", "scenarios", "states", "platforms"]) {
    const value = coverage[key];
    if (value === undefined) {
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      errors.push(`${prefix}.${key} must be an object`);
      continue;
    }
    validateStringArray(value.blocking, `${prefix}.${key}.blocking`, errors, { optional: true });
    validateStringArray(value.warning, `${prefix}.${key}.warning`, errors, { optional: true });
  }
}

function validatePlatforms(platforms, prefix, errors) {
  if (!platforms || typeof platforms !== "object" || Array.isArray(platforms)) {
    errors.push(`${prefix} must be an object`);
    return;
  }
  validateStringArray(platforms.include, `${prefix}.include`, errors, { optional: true });
  validateStringArray(platforms.exclude, `${prefix}.exclude`, errors, { optional: true });
}

function validateStringArray(values, key, errors, options = {}) {
  if (values === undefined && options.optional) {
    return;
  }
  if (!Array.isArray(values)) {
    errors.push(`${key} must be an array`);
    return;
  }
  for (const [index, value] of values.entries()) {
    if (typeof value !== "string" || value.length === 0) {
      errors.push(`${key}[${index}] must be a non-empty string`);
    }
  }
}
