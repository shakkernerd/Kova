import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { statesDir } from "./paths.mjs";

export async function loadStates(selectedId) {
  const names = await readdir(statesDir);
  const paths = names.filter((name) => name.endsWith(".json")).sort();
  const states = [];
  const ids = new Set();

  for (const name of paths) {
    const raw = await readFile(join(statesDir, name), "utf8");
    const state = JSON.parse(raw);
    validateStateShape(state, name);
    if (ids.has(state.id)) {
      throw new Error(`duplicate state id '${state.id}' in ${name}`);
    }
    ids.add(state.id);
    states.push(state);
  }

  const filtered = selectedId ? states.filter((state) => state.id === selectedId) : states;
  if (filtered.length === 0) {
    throw new Error(`no state found for ${selectedId}`);
  }
  return filtered;
}

export async function loadState(selectedId = "fresh") {
  const [state] = await loadStates(selectedId);
  return state;
}

export function validateStateShape(state, sourceName = "state") {
  const errors = [];

  requireString(state, "id", errors);
  requireString(state, "title", errors);
  requireString(state, "objective", errors);
  requireArray(state, "tags", errors);
  requireArray(state, "setup", errors);

  if (typeof state.id === "string" && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(state.id)) {
    errors.push("id must be kebab-case lowercase alphanumeric");
  }

  if (Array.isArray(state.setup)) {
    for (const [index, step] of state.setup.entries()) {
      const prefix = `setup[${index}]`;
      requireString(step, "id", errors, prefix);
      requireString(step, "title", errors, prefix);
      requireString(step, "intent", errors, prefix);
      requireString(step, "afterPhase", errors, prefix);
      requireArray(step, "commands", errors, prefix);
      requireArray(step, "evidence", errors, prefix);

      if (Array.isArray(step.commands)) {
        for (const [commandIndex, command] of step.commands.entries()) {
          if (typeof command !== "string" || command.length === 0) {
            errors.push(`${prefix}.commands[${commandIndex}] must be a non-empty string`);
          }
        }
      }
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

