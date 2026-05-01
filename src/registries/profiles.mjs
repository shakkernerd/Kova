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
  validateStringArray(profile.targetKinds, "targetKinds", errors, { optional: true });
  validateDiagnostics(profile.diagnostics, "diagnostics", errors);
  validateCalibration(profile.calibration, "calibration", errors);
  validateEntries(profile.entries, errors);

  if (profile.gate !== undefined) {
    validateGate(profile.gate, "gate", errors);
  }

  assertNoShapeErrors(errors, sourceName);
}

function validateCalibration(calibration, prefix, errors) {
  if (calibration === undefined) {
    return;
  }
  if (!calibration || typeof calibration !== "object" || Array.isArray(calibration)) {
    errors.push(`${prefix} must be an object when set`);
    return;
  }
  validateThresholdMap(calibration.roles, `${prefix}.roles`, errors, { keyed: true });
  if (calibration.surfaces !== undefined) {
    if (!calibration.surfaces || typeof calibration.surfaces !== "object" || Array.isArray(calibration.surfaces)) {
      errors.push(`${prefix}.surfaces must be an object when set`);
    } else {
      for (const [surfaceId, surfaceCalibration] of Object.entries(calibration.surfaces)) {
        if (!surfaceCalibration || typeof surfaceCalibration !== "object" || Array.isArray(surfaceCalibration)) {
          errors.push(`${prefix}.surfaces.${surfaceId} must be an object`);
          continue;
        }
        validateThresholdMap(surfaceCalibration.thresholds, `${prefix}.surfaces.${surfaceId}.thresholds`, errors);
        validateThresholdMap(surfaceCalibration.roleThresholds, `${prefix}.surfaces.${surfaceId}.roleThresholds`, errors, { keyed: true });
      }
    }
  }
}

function validateThresholdMap(map, prefix, errors, options = {}) {
  if (map === undefined) {
    return;
  }
  if (!map || typeof map !== "object" || Array.isArray(map)) {
    errors.push(`${prefix} must be an object when set`);
    return;
  }
  for (const [key, value] of Object.entries(map)) {
    if (options.keyed) {
      validateThresholdMap(value, `${prefix}.${key}`, errors);
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      errors.push(`${prefix}.${key} must be a finite number`);
    }
  }
}

function validateDiagnostics(diagnostics, prefix, errors) {
  if (diagnostics === undefined) {
    return;
  }
  if (!diagnostics || typeof diagnostics !== "object" || Array.isArray(diagnostics)) {
    errors.push(`${prefix} must be an object when set`);
    return;
  }
  if (diagnostics.timelineRequired !== undefined && typeof diagnostics.timelineRequired !== "boolean") {
    errors.push(`${prefix}.timelineRequired must be boolean when set`);
  }
  validateStringArray(diagnostics.timelineRequiredForTargetKinds, `${prefix}.timelineRequiredForTargetKinds`, errors, { optional: true });
  validateStringArray(diagnostics.requiredKeySpans, `${prefix}.requiredKeySpans`, errors, { optional: true });
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
  for (const key of ["surfaces", "scenarios", "states", "traits", "stateSurfaces", "platforms"]) {
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
