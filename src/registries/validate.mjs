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
  const traitIds = new Set(states.flatMap((state) => state.traits ?? []));
  const scenarioById = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  const stateById = new Map(states.map((state) => [state.id, state]));
  const surfaceById = new Map(surfaces.map((surface) => [surface.id, surface]));

  for (const scenario of scenarios) {
    if (!surfaceIds.has(scenario.surface)) {
      errors.push(`scenario '${scenario.id}' references unknown surface '${scenario.surface}'`);
      continue;
    }
    validateScenarioContract(scenario, surfaceById.get(scenario.surface), { stateIds, processRoleIds }, errors);
  }

  for (const state of states) {
    for (const surface of state.compatibleSurfaces ?? []) {
      if (!surfaceIds.has(surface)) {
        errors.push(`state '${state.id}' compatibleSurfaces references unknown surface '${surface}'`);
      }
    }
    for (const surface of state.incompatibleSurfaces ?? []) {
      if (!surfaceIds.has(surface)) {
        errors.push(`state '${state.id}' incompatibleSurfaces references unknown surface '${surface}'`);
      }
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
    validateProfileReferences(profile, { scenarioIds, stateIds, surfaceIds, traitIds, scenarioById, stateById, surfaceById }, errors);
  }

  if (errors.length > 0) {
    throw new Error(`registry references are invalid:\n- ${errors.join("\n- ")}`);
  }
}

function validateScenarioContract(scenario, surface, refs, errors) {
  for (const state of scenario.states ?? []) {
    if (!refs.stateIds.has(state)) {
      errors.push(`scenario '${scenario.id}' states references unknown state '${state}'`);
    }
  }
  for (const role of scenario.processRoles ?? []) {
    if (!refs.processRoleIds.has(role)) {
      errors.push(`scenario '${scenario.id}' processRoles references unknown process role '${role}'`);
    }
  }
  const surfaceTargetKinds = new Set(surface.targetKinds ?? []);
  for (const targetKind of scenario.targetKinds ?? []) {
    if (surfaceTargetKinds.size > 0 && !surfaceTargetKinds.has(targetKind)) {
      errors.push(`scenario '${scenario.id}' targetKinds references '${targetKind}' which is not supported by surface '${surface.id}'`);
    }
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
    validateScenarioStatePair({
      profileId: profile.id,
      location: `entries[${index}]`,
      scenarioId: entry.scenario,
      stateId: entry.state,
      refs,
      errors
    });
  }

  for (const key of ["blocking", "warning"]) {
    for (const [index, entry] of (profile.gate?.[key] ?? []).entries()) {
      if (!refs.scenarioIds.has(entry.scenario)) {
        errors.push(`profile '${profile.id}' gate.${key}[${index}] references unknown scenario '${entry.scenario}'`);
      }
      if (entry.state !== undefined && !refs.stateIds.has(entry.state)) {
        errors.push(`profile '${profile.id}' gate.${key}[${index}] references unknown state '${entry.state}'`);
      }
      if (entry.state !== undefined) {
        validateScenarioStatePair({
          profileId: profile.id,
          location: `gate.${key}[${index}]`,
          scenarioId: entry.scenario,
          stateId: entry.state,
          refs,
          errors
        });
      }
    }
  }

  validateCoverageRefs(profile, refs, errors, "surfaces", refs.surfaceIds);
  validateCoverageRefs(profile, refs, errors, "scenarios", refs.scenarioIds);
  validateCoverageRefs(profile, refs, errors, "states", refs.stateIds);
  validateCoverageRefs(profile, refs, errors, "traits", refs.traitIds);
  validateStateSurfaceCoverageRefs(profile, refs, errors);
}

function validateScenarioStatePair({ profileId, location, scenarioId, stateId, refs, errors }) {
  const scenario = refs.scenarioById.get(scenarioId);
  const state = refs.stateById.get(stateId);
  if (!scenario || !state) {
    return;
  }
  const surface = refs.surfaceById.get(scenario.surface);
  if (!surface) {
    return;
  }
  const allowedStates = scenario.states?.length > 0 ? scenario.states : surface.requiredStates ?? [];
  if (allowedStates.length > 0 && !allowedStates.includes(state.id)) {
    errors.push(`profile '${profileId}' ${location} pairs scenario '${scenario.id}' with state '${state.id}', but surface/scenario allows only: ${allowedStates.join(", ")}`);
  }
  if ((state.compatibleSurfaces ?? []).length > 0 && !state.compatibleSurfaces.includes(scenario.surface)) {
    errors.push(`profile '${profileId}' ${location} pairs state '${state.id}' with incompatible surface '${scenario.surface}'; compatible surfaces: ${state.compatibleSurfaces.join(", ")}`);
  }
  if ((state.incompatibleSurfaces ?? []).includes(scenario.surface)) {
    errors.push(`profile '${profileId}' ${location} pairs state '${state.id}' with explicitly incompatible surface '${scenario.surface}'`);
  }
}

function validateStateSurfaceCoverageRefs(profile, refs, errors) {
  const coverage = profile.gate?.coverage?.stateSurfaces;
  if (!coverage) {
    return;
  }
  for (const level of ["blocking", "warning"]) {
    for (const value of coverage[level] ?? []) {
      const [surface, state, extra] = String(value).split(":");
      if (!surface || !state || extra !== undefined) {
        errors.push(`profile '${profile.id}' gate.coverage.stateSurfaces.${level} must use surface:state, got '${value}'`);
        continue;
      }
      if (!refs.surfaceIds.has(surface)) {
        errors.push(`profile '${profile.id}' gate.coverage.stateSurfaces.${level} references unknown surface '${surface}'`);
      }
      if (!refs.stateIds.has(state)) {
        errors.push(`profile '${profile.id}' gate.coverage.stateSurfaces.${level} references unknown state '${state}'`);
      }
      validateStateSurfacePair({
        profileId: profile.id,
        location: `gate.coverage.stateSurfaces.${level}`,
        surfaceId: surface,
        stateId: state,
        refs,
        errors
      });
    }
  }
}

function validateStateSurfacePair({ profileId, location, surfaceId, stateId, refs, errors }) {
  const surface = refs.surfaceById.get(surfaceId);
  const state = refs.stateById.get(stateId);
  if (!surface || !state) {
    return;
  }
  if ((surface.requiredStates ?? []).length > 0 && !surface.requiredStates.includes(state.id)) {
    errors.push(`profile '${profileId}' ${location} requires '${surface.id}:${state.id}', but surface allows only: ${surface.requiredStates.join(", ")}`);
  }
  if ((state.compatibleSurfaces ?? []).length > 0 && !state.compatibleSurfaces.includes(surface.id)) {
    errors.push(`profile '${profileId}' ${location} requires '${surface.id}:${state.id}', but state compatible surfaces are: ${state.compatibleSurfaces.join(", ")}`);
  }
  if ((state.incompatibleSurfaces ?? []).includes(surface.id)) {
    errors.push(`profile '${profileId}' ${location} requires explicitly incompatible state/surface pair '${surface.id}:${state.id}'`);
  }
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
