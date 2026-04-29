import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { scenariosDir } from "./paths.mjs";

export async function loadScenarios(selectedId) {
  const names = await readdir(scenariosDir);
  const paths = names.filter((name) => name.endsWith(".json")).sort();
  const scenarios = [];
  const ids = new Set();

  for (const name of paths) {
    const raw = await readFile(join(scenariosDir, name), "utf8");
    const scenario = JSON.parse(raw);
    validateScenarioShape(scenario, name);
    if (ids.has(scenario.id)) {
      throw new Error(`duplicate scenario id '${scenario.id}' in ${name}`);
    }
    ids.add(scenario.id);
    scenarios.push(scenario);
  }

  const filtered = selectedId ? scenarios.filter((scenario) => scenario.id === selectedId) : scenarios;
  if (filtered.length === 0) {
    throw new Error(`no scenario found for ${selectedId}`);
  }
  return filtered;
}

export function validateScenarioShape(scenario, sourceName = "scenario") {
  const errors = [];

  requireString(scenario, "id", errors);
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

  if (typeof scenario.id === "string" && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(scenario.id)) {
    errors.push("id must be kebab-case lowercase alphanumeric");
  }

  if (Array.isArray(scenario.tags)) {
    for (const [index, tag] of scenario.tags.entries()) {
      if (typeof tag !== "string" || tag.length === 0) {
        errors.push(`tags[${index}] must be a non-empty string`);
      }
    }
  }

  if (Array.isArray(scenario.phases)) {
    if (scenario.phases.length === 0) {
      errors.push("phases must not be empty");
    }

    const phaseIds = new Set();
    for (const [index, phase] of scenario.phases.entries()) {
      const prefix = `phases[${index}]`;
      requireString(phase, "id", errors, prefix);
      requireString(phase, "title", errors, prefix);
      requireString(phase, "intent", errors, prefix);
      requireArray(phase, "commands", errors, prefix);
      requireArray(phase, "evidence", errors, prefix);

      if (typeof phase.id === "string") {
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(phase.id)) {
          errors.push(`${prefix}.id must be kebab-case lowercase alphanumeric`);
        }
        if (phaseIds.has(phase.id)) {
          errors.push(`duplicate phase id '${phase.id}'`);
        }
        phaseIds.add(phase.id);
      }

      if (Array.isArray(phase.commands)) {
        for (const [commandIndex, command] of phase.commands.entries()) {
          if (typeof command !== "string" || command.length === 0) {
            errors.push(`${prefix}.commands[${commandIndex}] must be a non-empty string`);
          }
        }
      }

      if (Array.isArray(phase.evidence)) {
        for (const [evidenceIndex, item] of phase.evidence.entries()) {
          if (typeof item !== "string" || item.length === 0) {
            errors.push(`${prefix}.evidence[${evidenceIndex}] must be a non-empty string`);
          }
        }
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`${sourceName} is invalid:\n- ${errors.join("\n- ")}`);
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

function requireObject(value, key, errors, prefix = "") {
  if (!value?.[key] || typeof value[key] !== "object" || Array.isArray(value[key])) {
    errors.push(`${path(prefix, key)} must be an object`);
  }
}

function path(prefix, key) {
  return prefix ? `${prefix}.${key}` : key;
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
      .replaceAll("{startSelector}", values.startSelector)
      .replaceAll("{upgradeSelector}", values.upgradeSelector)
      .replaceAll("{fromUpgradeSelector}", values.fromUpgradeSelector)
  );
}
