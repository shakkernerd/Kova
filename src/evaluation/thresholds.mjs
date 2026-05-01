export function resolveThresholdPolicy({ profile = null, surface = null, scenario = null } = {}) {
  const surfaceCalibration = profile?.calibration?.surfaces?.[surface?.id] ?? {};
  const thresholds = mergeObjects(
    surface?.thresholds,
    surfaceCalibration.thresholds,
    scenario?.thresholds
  );
  const roleThresholds = mergeRoleThresholds(
    profile?.calibration?.roles,
    surface?.roleThresholds,
    surfaceCalibration.roleThresholds,
    scenario?.thresholds?.roleThresholds
  );

  return {
    thresholds,
    roleThresholds,
    report: {
      schemaVersion: "kova.thresholdPolicy.v1",
      profileId: profile?.id ?? null,
      surfaceId: surface?.id ?? null,
      scenarioId: scenario?.id ?? null,
      sources: thresholdSources({ profile, surface, surfaceCalibration, scenario }),
      thresholds,
      roleThresholds
    }
  };
}

function thresholdSources({ profile, surface, surfaceCalibration, scenario }) {
  const sources = [];
  if (surface?.thresholds && Object.keys(surface.thresholds).length > 0) {
    sources.push({ kind: "surface", id: surface.id, thresholds: Object.keys(surface.thresholds).sort() });
  }
  if (surface?.roleThresholds && Object.keys(surface.roleThresholds).length > 0) {
    sources.push({ kind: "surface-role", id: surface.id, roles: Object.keys(surface.roleThresholds).sort() });
  }
  if (surfaceCalibration?.thresholds && Object.keys(surfaceCalibration.thresholds).length > 0) {
    sources.push({ kind: "profile-surface", id: `${profile?.id}:${surface?.id}`, thresholds: Object.keys(surfaceCalibration.thresholds).sort() });
  }
  if (surfaceCalibration?.roleThresholds && Object.keys(surfaceCalibration.roleThresholds).length > 0) {
    sources.push({ kind: "profile-surface-role", id: `${profile?.id}:${surface?.id}`, roles: Object.keys(surfaceCalibration.roleThresholds).sort() });
  }
  if (profile?.calibration?.roles && Object.keys(profile.calibration.roles).length > 0) {
    sources.push({ kind: "profile-role", id: profile.id, roles: Object.keys(profile.calibration.roles).sort() });
  }
  if (scenario?.thresholds && Object.keys(scenario.thresholds).length > 0) {
    sources.push({ kind: "scenario", id: scenario.id, thresholds: Object.keys(scenario.thresholds).sort() });
  }
  return sources;
}

function mergeObjects(...objects) {
  const merged = {};
  for (const object of objects) {
    if (!object || typeof object !== "object" || Array.isArray(object)) {
      continue;
    }
    for (const [key, value] of Object.entries(object)) {
      if (key === "roleThresholds") {
        continue;
      }
      merged[key] = value;
    }
  }
  return merged;
}

function mergeRoleThresholds(...sets) {
  const merged = {};
  for (const set of sets) {
    if (!set || typeof set !== "object" || Array.isArray(set)) {
      continue;
    }
    for (const [role, thresholds] of Object.entries(set)) {
      merged[role] = {
        ...(merged[role] ?? {}),
        ...(thresholds ?? {})
      };
    }
  }
  return merged;
}
