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
  if (scenario.mockProvider !== undefined) {
    validateMockProvider(scenario.mockProvider, "mockProvider", errors);
  }

  validateStringArray(scenario.tags, "tags", errors);
  validateStringArray(scenario.states, "states", errors, { optional: true });
  validateStringArray(scenario.targetKinds, "targetKinds", errors, { optional: true });
  validateStringArray(scenario.targetValues, "targetValues", errors, { optional: true });
  validateStringArray(scenario.fromKinds, "fromKinds", errors, { optional: true });
  validateStringArray(scenario.fromValues, "fromValues", errors, { optional: true });
  if (scenario.requiresFrom !== undefined && typeof scenario.requiresFrom !== "boolean") {
    errors.push("requiresFrom must be a boolean when set");
  }
  validatePhases(scenario.phases, errors);
  validateCloneFirstContract(scenario, errors);

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
  if (agent.expectedFailure !== undefined && typeof agent.expectedFailure !== "boolean") {
    errors.push(`${prefix}.expectedFailure must be a boolean when set`);
  }
}

function validateMockProvider(mockProvider, prefix, errors) {
  if (!mockProvider || typeof mockProvider !== "object" || Array.isArray(mockProvider)) {
    errors.push(`${prefix} must be an object`);
    return;
  }
  const modes = ["normal", "slow", "timeout", "malformed", "streaming-stall", "error-then-recover", "concurrent-pressure"];
  if (mockProvider.mode !== undefined && !modes.includes(mockProvider.mode)) {
    errors.push(`${prefix}.mode must be one of ${modes.join(", ")}`);
  }
  for (const key of ["delayMs", "stallMs", "errorStatus"]) {
    if (mockProvider[key] !== undefined && (!Number.isInteger(mockProvider[key]) || mockProvider[key] < 0)) {
      errors.push(`${prefix}.${key} must be a non-negative integer when set`);
    }
  }
  if (mockProvider.concurrency !== undefined && (!Number.isInteger(mockProvider.concurrency) || mockProvider.concurrency <= 0)) {
    errors.push(`${prefix}.concurrency must be a positive integer when set`);
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
    if (phase.expectedAgentFailure !== undefined && typeof phase.expectedAgentFailure !== "boolean") {
      errors.push(`${prefix}.expectedAgentFailure must be a boolean when set`);
    }
  }
}

function validateCloneFirstContract(scenario, errors) {
  if (!Array.isArray(scenario.phases)) {
    return;
  }
  const commands = scenario.phases.flatMap((phase) => phase.commands ?? []);
  if (!commands.some((command) => command.includes("{sourceEnv}"))) {
    return;
  }
  const firstCommand = commands[0] ?? "";
  if (!/^ocm\s+env\s+clone\s+\{sourceEnv\}\s+\{env\}(?:\s|$)/.test(firstCommand)) {
    errors.push("scenarios that use {sourceEnv} must start by cloning it into {env}");
  }
  const sourceCommands = commands.filter((command) => command.includes("{sourceEnv}"));
  if (sourceCommands.length !== 1) {
    errors.push("scenarios that use {sourceEnv} may reference it only in the first clone command");
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

export function validateScenarioRun(scenario, flags, context = {}) {
  const needsSourceEnv = scenarioUsesSourceEnv(scenario);
  if (needsSourceEnv && flags.execute === true && !flags.source_env) {
    throw new Error(`${scenario.id} execution requires --source-env <env>`);
  }
  validateTargetContract(scenario, context.targetPlan, "target", "targetKinds", "targetValues");
  if (scenario.requiresFrom === true && !context.fromPlan) {
    throw new Error(`${scenario.id} requires --from <selector>`);
  }
  if (context.fromPlan) {
    validateTargetContract(scenario, context.fromPlan, "from", "fromKinds", "fromValues");
  }
}

function scenarioUsesSourceEnv(scenario) {
  return (scenario.phases ?? []).some((phase) =>
    (phase.commands ?? []).some((command) => command.includes("{sourceEnv}"))
  );
}

function validateTargetContract(scenario, plan, role, kindKey, valueKey) {
  if (!plan) {
    return;
  }
  const allowedKinds = scenario[kindKey] ?? [];
  if (allowedKinds.length > 0 && !allowedKinds.includes(plan.kind)) {
    throw new Error(`${scenario.id} supports ${role} kind ${allowedKinds.join(", ")}, got ${plan.kind}`);
  }
  const allowedValues = scenario[valueKey] ?? [];
  if (allowedValues.length > 0 && !allowedValues.includes(plan.value)) {
    throw new Error(`${scenario.id} supports ${role} value ${allowedValues.join(", ")}, got ${plan.value}`);
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
