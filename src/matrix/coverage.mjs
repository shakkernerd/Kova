import { platformCoverageKeys } from "../platform.mjs";

export function buildCoverage({ surfaces, scenarios, states, profiles, platform }) {
  const scenarioSurfaceMap = scenarios
    .map((scenario) => ({
      scenario: scenario.id,
      surface: scenario.surface
    }))
    .sort(byScenario);
  const scenariosBySurface = new Map();
  for (const item of scenarioSurfaceMap) {
    const list = scenariosBySurface.get(item.surface) ?? [];
    list.push(item.scenario);
    scenariosBySurface.set(item.surface, list);
  }

  return {
    schemaVersion: "kova.coverage.v1",
    surfaces: surfaces.map((surface) => ({
      id: surface.id,
      title: surface.title,
      ownerArea: surface.ownerArea,
      scenarioCount: scenariosBySurface.get(surface.id)?.length ?? 0,
      scenarios: scenariosBySurface.get(surface.id) ?? []
    })),
    scenarioSurfaceMap,
    surfacesWithoutScenarios: surfaces
      .filter((surface) => !scenariosBySurface.has(surface.id))
      .map((surface) => surface.id),
    profiles: profiles.map((profile) => profileCoverage(profile, { scenarios, states, platform }))
  };
}

function profileCoverage(profile, { scenarios, states, platform }) {
  const scenarioById = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  const entryScenarios = new Set();
  const entryStates = new Set();
  const entrySurfaces = new Set();
  const entryStateSurfaces = new Set();

  for (const entry of profile.entries ?? []) {
    entryScenarios.add(entry.scenario);
    entryStates.add(entry.state);
    const scenario = scenarioById.get(entry.scenario);
    if (scenario?.surface) {
      entrySurfaces.add(scenario.surface);
      entryStateSurfaces.add(`${scenario.surface}:${entry.state}`);
    }
  }

  const requiredSurfaces = coverageIds(profile, "surfaces");
  const requiredScenarios = coverageIds(profile, "scenarios");
  const requiredStates = coverageIds(profile, "states");
  const requiredTraits = coverageIds(profile, "traits");
  const requiredStateSurfaces = coverageIds(profile, "stateSurfaces");
  const requiredPlatforms = coverageIds(profile, "platforms");
  const coveredTraits = coveredStateTraits(profile, states);
  const currentPlatformKeys = platformCoverageKeys(platform);

  return {
    id: profile.id,
    entryCount: profile.entries?.length ?? 0,
    surfaces: [...entrySurfaces].sort(),
    states: [...entryStates].sort(),
    scenarios: [...entryScenarios].sort(),
    stateSurfaces: [...entryStateSurfaces].sort(),
    required: {
      surfaces: requiredSurfaces,
      scenarios: requiredScenarios,
      states: requiredStates,
      traits: requiredTraits,
      platforms: requiredPlatforms,
      stateSurfaces: requiredStateSurfaces
    },
    gaps: {
      surfaces: requiredSurfaces.filter((id) => !entrySurfaces.has(id)),
      scenarios: requiredScenarios.filter((id) => !entryScenarios.has(id)),
      states: requiredStates.filter((id) => !entryStates.has(id)),
      traits: requiredTraits.filter((id) => !coveredTraits.has(id)),
      platforms: requiredPlatforms.filter((id) => !currentPlatformKeys.has(id)),
      stateSurfaces: requiredStateSurfaces.filter((id) => !entryStateSurfaces.has(id))
    },
    currentPlatformKeys: [...currentPlatformKeys].sort(),
    stateTraitCoverage: stateTraitCoverage(profile, states),
    stateSurfaceCoverage: stateSurfaceCoverage(profile, { scenarios, states }),
    traitSurfaceCoverage: traitSurfaceCoverage(profile, { scenarios, states })
  };
}

function coveredStateTraits(profile, states) {
  const stateById = new Map(states.map((state) => [state.id, state]));
  const traits = new Set();
  for (const entry of profile.entries ?? []) {
    for (const trait of stateById.get(entry.state)?.traits ?? []) {
      traits.add(trait);
    }
  }
  return traits;
}

function stateTraitCoverage(profile, states) {
  const stateById = new Map(states.map((state) => [state.id, state]));
  const traits = new Map();
  for (const entry of profile.entries ?? []) {
    for (const trait of stateById.get(entry.state)?.traits ?? stateById.get(entry.state)?.tags ?? []) {
      const statesForTrait = traits.get(trait) ?? new Set();
      statesForTrait.add(entry.state);
      traits.set(trait, statesForTrait);
    }
  }
  return Object.fromEntries([...traits.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([trait, ids]) => [trait, [...ids].sort()]));
}

function stateSurfaceCoverage(profile, { scenarios, states }) {
  const scenarioById = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  const stateById = new Map(states.map((state) => [state.id, state]));
  const surfaces = new Map();
  for (const entry of profile.entries ?? []) {
    const surface = scenarioById.get(entry.scenario)?.surface;
    const state = stateById.get(entry.state);
    if (!surface || !state) {
      continue;
    }
    const list = surfaces.get(surface) ?? new Set();
    list.add(state.id);
    surfaces.set(surface, list);
  }
  return Object.fromEntries([...surfaces.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([surface, ids]) => [surface, [...ids].sort()]));
}

function traitSurfaceCoverage(profile, { scenarios, states }) {
  const scenarioById = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  const stateById = new Map(states.map((state) => [state.id, state]));
  const traits = new Map();
  for (const entry of profile.entries ?? []) {
    const surface = scenarioById.get(entry.scenario)?.surface;
    const state = stateById.get(entry.state);
    if (!surface || !state) {
      continue;
    }
    for (const trait of state.traits ?? []) {
      const list = traits.get(trait) ?? new Set();
      list.add(surface);
      traits.set(trait, list);
    }
  }
  return Object.fromEntries([...traits.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([trait, surfaces]) => [trait, [...surfaces].sort()]));
}

function coverageIds(profile, key) {
  const coverage = profile.gate?.coverage?.[key];
  if (!coverage) {
    return [];
  }
  return [...new Set([...(coverage.blocking ?? []), ...(coverage.warning ?? [])])].sort();
}

function byScenario(left, right) {
  return left.scenario.localeCompare(right.scenario);
}
