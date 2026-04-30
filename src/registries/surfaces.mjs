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

  assertNoShapeErrors(errors, sourceName);
}
