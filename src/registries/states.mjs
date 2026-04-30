import { statesDir } from "../paths.mjs";
import { assertNoShapeErrors, loadJsonRegistry, requireArray, requireKebabId, requireObject, requireString } from "./validate.mjs";

export const knownStateTraits = [
  "agent-state",
  "baseline",
  "channel-state",
  "config-state",
  "configured-auth",
  "existing-user",
  "external-plugin",
  "failure-state",
  "filesystem-pressure",
  "fresh-user",
  "memory-pressure",
  "migration-state",
  "missing-auth",
  "mock-provider",
  "old-release",
  "onboarded-user",
  "performance-pressure",
  "platform-specific",
  "plugin-pressure",
  "provider-pressure",
  "runtime-deps",
  "service-state",
  "session-state",
  "upgraded-user",
  "workspace-pressure"
];

export async function loadStates(selectedId) {
  return loadJsonRegistry({
    dir: statesDir,
    kind: "state",
    selectedId,
    validate: validateStateShape
  });
}

export async function loadState(selectedId = "fresh") {
  const [state] = await loadStates(selectedId);
  return state;
}

export function validateStateShape(state, sourceName = "state") {
  const errors = [];

  requireKebabId(state, "id", errors);
  requireString(state, "title", errors);
  requireString(state, "objective", errors);
  requireArray(state, "tags", errors);
  requireArray(state, "traits", errors);
  requireArray(state, "compatibleSurfaces", errors);
  requireArray(state, "incompatibleSurfaces", errors);
  requireString(state, "riskArea", errors);
  requireString(state, "ownerArea", errors);
  requireArray(state, "setupEvidence", errors);
  requireArray(state, "cleanupGuarantees", errors);
  if (state.prepare !== undefined) {
    requireArray(state, "prepare", errors);
  }
  requireArray(state, "setup", errors);
  if (state.cleanup !== undefined) {
    requireArray(state, "cleanup", errors);
  }

  validateSteps(state.prepare, "prepare", errors, { phaseBinding: false });
  validateSteps(state.setup, "setup", errors, { phaseBinding: true });
  validateSteps(state.cleanup, "cleanup", errors, { phaseBinding: false });
  validateStringArray(state.compatibleSurfaces, "compatibleSurfaces", errors, { optional: true });
  validateStringArray(state.incompatibleSurfaces, "incompatibleSurfaces", errors, { optional: true });
  validateStringArray(state.traits, "traits", errors);
  validateStringArray(state.setupEvidence, "setupEvidence", errors, { nonEmpty: true });
  validateStringArray(state.cleanupGuarantees, "cleanupGuarantees", errors, { nonEmpty: true });
  validateKnownTraits(state.traits, errors);
  if (state.source !== undefined) {
    validateSource(state.source, errors);
  }

  assertNoShapeErrors(errors, sourceName);
}

function validateKnownTraits(traits, errors) {
  if (!Array.isArray(traits)) {
    return;
  }
  const known = new Set(knownStateTraits);
  for (const [index, trait] of traits.entries()) {
    if (typeof trait === "string" && !known.has(trait)) {
      errors.push(`traits[${index}] references unknown trait '${trait}'`);
    }
  }
}

function validateSource(source, errors) {
  requireObject({ source }, "source", errors);
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return;
  }
  requireKebabId(source, "kind", errors, "source");
  for (const [key, value] of Object.entries(source)) {
    if (key === "kind") {
      continue;
    }
    if (typeof value !== "string" || value.length === 0) {
      errors.push(`source.${key} must be a non-empty string`);
    }
  }
}

function validateSteps(steps, key, errors, options) {
  if (steps === undefined) {
    return;
  }
  if (!Array.isArray(steps)) {
    return;
  }
  for (const [index, step] of steps.entries()) {
    const prefix = `${key}[${index}]`;
    requireKebabId(step, "id", errors, prefix);
    requireString(step, "title", errors, prefix);
    requireString(step, "intent", errors, prefix);
    if (options.phaseBinding) {
      if (step.afterPhase !== undefined && step.afterPhases !== undefined) {
        errors.push(`${prefix} must use afterPhase or afterPhases, not both`);
      }
      if (step.afterPhases !== undefined) {
        requireArray(step, "afterPhases", errors, prefix);
      } else {
        requireString(step, "afterPhase", errors, prefix);
      }
    }
    requireArray(step, "commands", errors, prefix);
    requireArray(step, "evidence", errors, prefix);
    validateStringArray(step.afterPhases, `${prefix}.afterPhases`, errors, { optional: true });
    validateStringArray(step.commands, `${prefix}.commands`, errors);
    validateStringArray(step.evidence, `${prefix}.evidence`, errors);
  }
}

function validateStringArray(values, key, errors, options = {}) {
  if (values === undefined && options.optional) {
    return;
  }
  if (!Array.isArray(values)) {
    errors.push(`${key} must be an array`);
    return;
  }
  if (options.nonEmpty && values.length === 0) {
    errors.push(`${key} must not be empty`);
  }
  for (const [index, value] of values.entries()) {
    if (typeof value !== "string" || value.length === 0) {
      errors.push(`${key}[${index}] must be a non-empty string`);
    }
  }
}
