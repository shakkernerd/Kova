import { scenariosDir } from "../paths.mjs";
import { assertNoShapeErrors, loadJsonRegistry, requireArray, requireKebabId, requireObject, requireString } from "./validate.mjs";

export async function loadScenarios(selectedId) {
  return loadJsonRegistry({
    dir: scenariosDir,
    kind: "scenario",
    selectedId,
    validate: validateScenarioShape
  });
}

export function validateScenarioShape(scenario, sourceName = "scenario") {
  const errors = [];

  requireKebabId(scenario, "id", errors);
  requireKebabId(scenario, "surface", errors);
  requireString(scenario, "title", errors);
  requireString(scenario, "objective", errors);
  requireArray(scenario, "tags", errors);
  requireObject(scenario, "thresholds", errors);
  requireArray(scenario, "phases", errors);
  if (scenario.timeoutMs !== undefined && (!Number.isInteger(scenario.timeoutMs) || scenario.timeoutMs <= 0)) {
    errors.push("timeoutMs must be a positive integer when set");
  }
  if (scenario.platforms !== undefined) {
    validatePlatforms(scenario.platforms, "platforms", errors);
  }
  if (scenario.auth !== undefined) {
    validateAuth(scenario.auth, "auth", errors);
  }
  if (scenario.agent !== undefined) {
    validateAgent(scenario.agent, "agent", errors);
  }

  validateStringArray(scenario.tags, "tags", errors);
  validateStringArray(scenario.states, "states", errors, { optional: true });
  validateStringArray(scenario.targetKinds, "targetKinds", errors, { optional: true });
  validatePhases(scenario.phases, errors);

  assertNoShapeErrors(errors, sourceName);
}

function validateAuth(auth, prefix, errors) {
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) {
    errors.push(`${prefix} must be an object`);
    return;
  }
  if (auth.mode !== undefined && !["default", "mock", "live", "skip", "missing", "broken", "none"].includes(auth.mode)) {
    errors.push(`${prefix}.mode must be one of default, mock, live, skip, missing, broken, none`);
  }
}

function validateAgent(agent, prefix, errors) {
  if (!agent || typeof agent !== "object" || Array.isArray(agent)) {
    errors.push(`${prefix} must be an object`);
    return;
  }
  if (agent.expectedText !== undefined && (typeof agent.expectedText !== "string" || agent.expectedText.length === 0)) {
    errors.push(`${prefix}.expectedText must be a non-empty string when set`);
  }
}

function validatePhases(phases, errors) {
  if (!Array.isArray(phases)) {
    return;
  }
  if (phases.length === 0) {
    errors.push("phases must not be empty");
  }

  const phaseIds = new Set();
  for (const [index, phase] of phases.entries()) {
    const prefix = `phases[${index}]`;
    requireKebabId(phase, "id", errors, prefix);
    requireString(phase, "title", errors, prefix);
    requireString(phase, "intent", errors, prefix);
    requireArray(phase, "commands", errors, prefix);
    requireArray(phase, "evidence", errors, prefix);

    if (typeof phase.id === "string") {
      if (phaseIds.has(phase.id)) {
        errors.push(`duplicate phase id '${phase.id}'`);
      }
      phaseIds.add(phase.id);
    }

    validateStringArray(phase.commands, `${prefix}.commands`, errors);
    validateStringArray(phase.evidence, `${prefix}.evidence`, errors);
  }
}

function validatePlatforms(platforms, prefix, errors) {
  if (!platforms || typeof platforms !== "object" || Array.isArray(platforms)) {
    errors.push(`${prefix} must be an object`);
    return;
  }
  for (const key of ["include", "exclude"]) {
    validateStringArray(platforms[key], `${prefix}.${key}`, errors, { optional: true });
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
  for (const [index, value] of values.entries()) {
    if (typeof value !== "string" || value.length === 0) {
      errors.push(`${key}[${index}] must be a non-empty string`);
    }
  }
}

export function validateScenarioRun(scenario, flags) {
  if (scenario.id === "upgrade-existing-user" && flags.execute === true && !flags.source_env) {
    throw new Error("upgrade-existing-user execution requires --source-env <env>");
  }
}

export function materializeCommands(commands, values) {
  return commands.map((command) =>
    command
      .replaceAll("{env}", values.env)
      .replaceAll("{target}", values.target)
      .replaceAll("{from}", values.from)
      .replaceAll("{sourceEnv}", values.sourceEnv)
      .replaceAll("{artifactDir}", values.artifactDir ?? "")
      .replaceAll("{kovaRoot}", values.kovaRoot ?? "")
      .replaceAll("{startSelector}", values.startSelector)
      .replaceAll("{upgradeSelector}", values.upgradeSelector)
      .replaceAll("{fromUpgradeSelector}", values.fromUpgradeSelector)
  );
}
