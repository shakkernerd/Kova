import { surfacesDir } from "../paths.mjs";
import { assertNoShapeErrors, loadJsonRegistry, requireArray, requireKebabId, requireObject, requireString } from "./validate.mjs";

export async function loadSurfaces(selectedId) {
  return loadJsonRegistry({
    dir: surfacesDir,
    kind: "surface",
    selectedId,
    validate: validateSurfaceShape
  });
}

export function validateSurfaceShape(surface, sourceName = "surface") {
  const errors = [];
  requireKebabId(surface, "id", errors);
  requireString(surface, "title", errors);
  requireString(surface, "ownerArea", errors);
  requireString(surface, "description", errors);
  requireArray(surface, "requiredMetrics", errors);
  requireArray(surface, "processRoles", errors);
  requireObject(surface, "thresholds", errors);
  requireObject(surface, "diagnostics", errors);

  for (const key of ["requiredMetrics", "processRoles", "requiredStates", "targetKinds"]) {
    if (surface[key] === undefined) {
      continue;
    }
    if (!Array.isArray(surface[key])) {
      errors.push(`${key} must be an array when set`);
      continue;
    }
    for (const [index, value] of surface[key].entries()) {
      if (typeof value !== "string" || value.length === 0) {
        errors.push(`${key}[${index}] must be a non-empty string`);
      }
    }
  }

  if (surface.diagnostics && typeof surface.diagnostics === "object" && !Array.isArray(surface.diagnostics)) {
    if (surface.diagnostics.timelineRequiredForSourceBuild !== undefined &&
      typeof surface.diagnostics.timelineRequiredForSourceBuild !== "boolean") {
      errors.push("diagnostics.timelineRequiredForSourceBuild must be boolean when set");
    }
    if (surface.diagnostics.expectedSpans !== undefined && !Array.isArray(surface.diagnostics.expectedSpans)) {
      errors.push("diagnostics.expectedSpans must be an array when set");
    }
  }
  validateRoleThresholds(surface.roleThresholds, "roleThresholds", errors);

  assertNoShapeErrors(errors, sourceName);
}

function validateRoleThresholds(value, prefix, errors) {
  if (value === undefined) {
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${prefix} must be an object when set`);
    return;
  }
  for (const [role, thresholds] of Object.entries(value)) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(role)) {
      errors.push(`${prefix}.${role} must use a kebab-case process role id`);
    }
    if (!thresholds || typeof thresholds !== "object" || Array.isArray(thresholds)) {
      errors.push(`${prefix}.${role} must be an object`);
      continue;
    }
    for (const key of ["peakRssMb", "maxCpuPercent"]) {
      if (thresholds[key] !== undefined && (typeof thresholds[key] !== "number" || thresholds[key] < 0)) {
        errors.push(`${prefix}.${role}.${key} must be a non-negative number when set`);
      }
    }
  }
}
