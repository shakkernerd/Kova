import { processRolesDir } from "../paths.mjs";
import { assertNoShapeErrors, loadJsonRegistry, requireArray, requireKebabId, requireString } from "./validate.mjs";

export async function loadProcessRoles(selectedId) {
  return loadJsonRegistry({
    dir: processRolesDir,
    kind: "process role",
    selectedId,
    validate: validateProcessRoleShape
  });
}

export function validateProcessRoleShape(role, sourceName = "process-role") {
  const errors = [];
  requireKebabId(role, "id", errors);
  requireString(role, "title", errors);
  requireString(role, "description", errors);
  requireArray(role, "commandPatterns", errors);
  requireArray(role, "processPatterns", errors);

  for (const key of ["commandPatterns", "processPatterns"]) {
    if (!Array.isArray(role[key])) {
      continue;
    }
    for (const [index, pattern] of role[key].entries()) {
      if (typeof pattern !== "string") {
        errors.push(`${key}[${index}] must be a string`);
      }
    }
  }

  assertNoShapeErrors(errors, sourceName);
}
