import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export async function loadJsonRegistry({ dir, kind, selectedId, validate }) {
  const names = await readdir(dir);
  const paths = names.filter((name) => name.endsWith(".json")).sort();
  const items = [];
  const ids = new Set();

  for (const name of paths) {
    const raw = await readFile(join(dir, name), "utf8");
    const item = JSON.parse(raw);
    validate(item, name);
    if (ids.has(item.id)) {
      throw new Error(`duplicate ${kind} id '${item.id}' in ${name}`);
    }
    ids.add(item.id);
    items.push(item);
  }

  const filtered = selectedId ? items.filter((item) => item.id === selectedId) : items;
  if (filtered.length === 0) {
    throw new Error(`no ${kind} found for ${selectedId}`);
  }
  return filtered;
}

export function validateRegistryReferences({ scenarios, states, profiles, surfaces, processRoles }) {
  const errors = [];
  const scenarioIds = idSet(scenarios);
  const stateIds = idSet(states);
  const surfaceIds = idSet(surfaces);
  const processRoleIds = idSet(processRoles);

  for (const scenario of scenarios) {
    if (!surfaceIds.has(scenario.surface)) {
      errors.push(`scenario '${scenario.id}' references unknown surface '${scenario.surface}'`);
    }
  }

  for (const surface of surfaces) {
    for (const role of surface.processRoles ?? []) {
      if (!processRoleIds.has(role)) {
        errors.push(`surface '${surface.id}' references unknown process role '${role}'`);
      }
    }
    for (const role of Object.keys(surface.roleThresholds ?? {})) {
      if (!processRoleIds.has(role)) {
        errors.push(`surface '${surface.id}' roleThresholds references unknown process role '${role}'`);
      }
    }
    for (const state of surface.requiredStates ?? []) {
      if (!stateIds.has(state)) {
        errors.push(`surface '${surface.id}' references unknown required state '${state}'`);
      }
    }
  }

  for (const profile of profiles) {
    validateProfileReferences(profile, { scenarioIds, stateIds, surfaceIds }, errors);
  }

  if (errors.length > 0) {
    throw new Error(`registry references are invalid:\n- ${errors.join("\n- ")}`);
  }
}

function validateProfileReferences(profile, refs, errors) {
  for (const [index, entry] of (profile.entries ?? []).entries()) {
    if (!refs.scenarioIds.has(entry.scenario)) {
      errors.push(`profile '${profile.id}' entries[${index}] references unknown scenario '${entry.scenario}'`);
    }
    if (!refs.stateIds.has(entry.state)) {
      errors.push(`profile '${profile.id}' entries[${index}] references unknown state '${entry.state}'`);
    }
  }

  for (const key of ["blocking", "warning"]) {
    for (const [index, entry] of (profile.gate?.[key] ?? []).entries()) {
      if (!refs.scenarioIds.has(entry.scenario)) {
        errors.push(`profile '${profile.id}' gate.${key}[${index}] references unknown scenario '${entry.scenario}'`);
      }
      if (entry.state !== undefined && !refs.stateIds.has(entry.state)) {
        errors.push(`profile '${profile.id}' gate.${key}[${index}] references unknown state '${entry.state}'`);
      }
    }
  }

  validateCoverageRefs(profile, refs, errors, "surfaces", refs.surfaceIds);
  validateCoverageRefs(profile, refs, errors, "scenarios", refs.scenarioIds);
  validateCoverageRefs(profile, refs, errors, "states", refs.stateIds);
}

function validateCoverageRefs(profile, _refs, errors, key, allowedIds) {
  const coverage = profile.gate?.coverage?.[key];
  if (!coverage) {
    return;
  }
  for (const level of ["blocking", "warning"]) {
    for (const id of coverage[level] ?? []) {
      if (!allowedIds.has(id)) {
        errors.push(`profile '${profile.id}' gate.coverage.${key}.${level} references unknown ${key.slice(0, -1)} '${id}'`);
      }
    }
  }
}

function idSet(items) {
  return new Set(items.map((item) => item.id));
}

export function requireString(value, key, errors, prefix = "") {
  if (typeof value?.[key] !== "string" || value[key].length === 0) {
    errors.push(`${path(prefix, key)} must be a non-empty string`);
  }
}

export function requireArray(value, key, errors, prefix = "") {
  if (!Array.isArray(value?.[key])) {
    errors.push(`${path(prefix, key)} must be an array`);
  }
}

export function requireObject(value, key, errors, prefix = "") {
  if (!value?.[key] || typeof value[key] !== "object" || Array.isArray(value[key])) {
    errors.push(`${path(prefix, key)} must be an object`);
  }
}

export function requireKebabId(value, key, errors, prefix = "") {
  requireString(value, key, errors, prefix);
  if (typeof value?.[key] === "string" && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value[key])) {
    errors.push(`${path(prefix, key)} must be kebab-case lowercase alphanumeric`);
  }
}

export function assertNoShapeErrors(errors, sourceName) {
  if (errors.length > 0) {
    throw new Error(`${sourceName} is invalid:\n- ${errors.join("\n- ")}`);
  }
}

function path(prefix, key) {
  return prefix ? `${prefix}.${key}` : key;
}
