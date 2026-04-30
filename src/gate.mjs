export function preflightGateRun({ entries, flags }) {
  if (flags?.gate !== true || flags?.execute !== true) {
    return;
  }

  const selected = entries.filter((entry) => !entry.skipReason);
  const needsSourceEnv = selected.some((entry) => entry.scenario?.id === "upgrade-existing-user");
  if (needsSourceEnv && !flags.source_env) {
    throw new Error("release gate preflight failed: --source-env <env> is required because selected gate scenario upgrade-existing-user clones existing user state");
  }
}

export function evaluateGate(report, profile) {
  const policy = normalizeGatePolicy(profile);
  const records = report.records ?? [];
  const cards = [];
  const partial = isPartialGate(report);
  const missingRequired = [];

  if (report.mode !== "execution") {
    cards.push({
      severity: "blocking",
      kind: "not-executed",
      scenario: null,
      state: null,
      status: report.mode,
      title: "Gate Not Executed",
      summary: "Release gate requires an execution report; this report was not produced with --execute.",
      expected: "execution",
      actual: report.mode,
      impact: "Kova cannot make a ship/no-ship decision from a dry-run plan.",
      likelyOwner: "Kova"
    });
  }

  const recordKeys = new Set(records.map(recordKey));
  for (const required of policy.blocking) {
    if (!recordKeys.has(policyKey(required))) {
      missingRequired.push(required);
      cards.push({
        severity: partial ? "info" : "blocking",
        kind: partial ? "filtered-required-scenario" : "missing-required-scenario",
        scenario: required.scenario,
        state: required.state ?? null,
        status: "MISSING",
        title: "Required Scenario Missing",
        summary: partial
          ? `Required release gate scenario ${formatPolicyEntry(required)} was not present because this was a filtered gate slice.`
          : `Required release gate scenario ${formatPolicyEntry(required)} was not present in the report.`,
        expected: "scenario selected and executed",
        actual: partial ? "filtered out" : "missing",
        impact: partial
          ? "This partial run can reject a release if selected scenarios fail, but it cannot approve the full release gate."
          : "The release gate is incomplete and cannot approve the OpenClaw build.",
        likelyOwner: "Kova"
      });
    }
  }

  for (const card of buildCoverageCards(report, policy, partial)) {
    cards.push(card);
    if (card.severity === "blocking" || card.severity === "info") {
      missingRequired.push({
        scenario: card.scenario,
        state: card.state,
        coverage: card.coverage
      });
    }
  }

  for (const record of records) {
    if (record.status === "PASS") {
      continue;
    }
    const severity = severityForRecord(record, policy);
    cards.push(buildRecordCard(record, severity));
  }

  for (const regression of report.baseline?.comparison?.regressions ?? []) {
    cards.push(buildPerformanceRegressionCard(regression));
  }

  const blockingCards = cards.filter((card) => card.severity === "blocking");
  const warningCards = cards.filter((card) => card.severity === "warning");
  const infoCards = cards.filter((card) => card.severity === "info");
  const blockedByHarness = blockingCards.some((card) =>
    ["not-executed", "missing-required-scenario", "blocked", "skipped", "dry-run"].includes(card.kind)
  );
  const openClawBlockingFailures = blockingCards.filter((card) => card.kind === "openclaw-failure");
  const incomplete = missingRequired.length > 0;
  const verdict = blockedByHarness
    ? "BLOCKED"
    : openClawBlockingFailures.length > 0
      ? "DO_NOT_SHIP"
      : blockingCards.length > 0
        ? "DO_NOT_SHIP"
        : incomplete
          ? "BLOCKED"
          : "SHIP";

  return {
    schemaVersion: "kova.gate.v1",
    enabled: true,
    profileId: profile?.id ?? null,
    policyId: policy.id,
    verdict,
    ok: verdict === "SHIP",
    complete: !incomplete,
    partial,
    missingRequiredCount: missingRequired.length,
    blockingCount: blockingCards.length,
    warningCount: warningCards.length,
    infoCount: infoCards.length,
    required: policy.blocking,
    warning: policy.warning,
    coverage: policy.coverage,
    cards
  };
}

function isPartialGate(report) {
  const controls = report.controls;
  return (controls?.include?.length ?? 0) > 0 || (controls?.exclude?.length ?? 0) > 0;
}

function normalizeGatePolicy(profile) {
  const gate = profile?.gate && typeof profile.gate === "object" ? profile.gate : {};
  const entries = Array.isArray(profile?.entries) ? profile.entries : [];
  const warning = normalizePolicyEntries(gate.warning ?? []);
  const blocking = normalizePolicyEntries(gate.blocking ?? entries)
    .filter((entry) => !warning.some((warningEntry) => policyKey(warningEntry) === policyKey(entry)));

  return {
    id: typeof gate.id === "string" && gate.id ? gate.id : `${profile?.id ?? "matrix"}-gate`,
    blocking,
    warning,
    coverage: normalizeCoveragePolicy(gate.coverage)
  };
}

function normalizeCoveragePolicy(coverage) {
  const input = coverage && typeof coverage === "object" ? coverage : {};
  return {
    surfaces: normalizeCoverageSet(input.surfaces),
    platforms: normalizeCoverageSet(input.platforms),
    states: normalizeCoverageSet(input.states),
    traits: normalizeCoverageSet(input.traits),
    scenarios: normalizeCoverageSet(input.scenarios),
    stateSurfaces: normalizeCoverageSet(input.stateSurfaces)
  };
}

function normalizeCoverageSet(value) {
  const input = value && typeof value === "object" ? value : {};
  return {
    blocking: normalizeStringList(input.blocking),
    warning: normalizeStringList(input.warning)
  };
}

function normalizeStringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.length > 0) : [];
}

function buildCoverageCards(report, policy, partial) {
  const cards = [];
  const records = report.records ?? [];
  const platformKeys = platformCoverageKeys(report.platform);
  const scenarioKeys = new Set(records.map((record) => record.scenario).filter(Boolean));
  const stateKeys = new Set(records.map((record) => record.state?.id).filter(Boolean));
  const surfaceKeys = new Set(records.map((record) => record.surface ?? record.measurements?.surface).filter(Boolean));
  const traitKeys = new Set(records.flatMap((record) => record.state?.traits ?? []).filter(Boolean));
  const stateSurfaceKeys = new Set(records
    .map((record) => {
      const surface = record.surface ?? record.measurements?.surface;
      const state = record.state?.id;
      return surface && state ? `${surface}:${state}` : null;
    })
    .filter(Boolean));

  addCoverageCards(cards, {
    kind: "surface",
    expected: policy.coverage.surfaces,
    observed: surfaceKeys,
    partial,
    statusText: `${surfaceKeys.size} surface(s) present`
  });
  addCoverageCards(cards, {
    kind: "platform",
    expected: policy.coverage.platforms,
    observed: platformKeys,
    partial,
    statusText: report.platform ? `${report.platform.os}/${report.platform.arch}` : "unknown platform"
  });
  addCoverageCards(cards, {
    kind: "scenario",
    expected: policy.coverage.scenarios,
    observed: scenarioKeys,
    partial,
    statusText: `${scenarioKeys.size} scenario(s) present`
  });
  addCoverageCards(cards, {
    kind: "state",
    expected: policy.coverage.states,
    observed: stateKeys,
    partial,
    statusText: `${stateKeys.size} state(s) present`
  });
  addCoverageCards(cards, {
    kind: "trait",
    expected: policy.coverage.traits,
    observed: traitKeys,
    partial,
    statusText: `${traitKeys.size} state trait(s) present`
  });
  addCoverageCards(cards, {
    kind: "state-surface",
    expected: policy.coverage.stateSurfaces,
    observed: stateSurfaceKeys,
    partial,
    statusText: `${stateSurfaceKeys.size} state/surface pair(s) present`
  });

  return cards;
}

function addCoverageCards(cards, { kind, expected, observed, partial, statusText }) {
  for (const value of expected.blocking) {
    if (observed.has(value)) {
      continue;
    }
    cards.push(coverageCard({ severity: partial ? "info" : "blocking", kind, value, partial, statusText }));
  }
  for (const value of expected.warning) {
    if (observed.has(value)) {
      continue;
    }
    cards.push(coverageCard({ severity: "warning", kind, value, partial, statusText }));
  }
}

function coverageCard({ severity, kind, value, partial, statusText }) {
  const filtered = partial && severity === "info";
  return {
    severity,
    kind: filtered ? "filtered-required-coverage" : "missing-required-coverage",
    coverage: kind,
    scenario: kind === "scenario" ? value : null,
    state: kind === "state" ? value : stateFromCoverage(kind, value),
    status: "MISSING",
    title: `Required ${kind} Coverage Missing`,
    summary: filtered
      ? `Required release gate ${kind} coverage ${value} was not present because this was a filtered gate slice.`
      : `Required release gate ${kind} coverage ${value} was not present in the report.`,
    expected: `${kind} coverage ${value}`,
    actual: statusText,
    impact: filtered
      ? "This partial run can reject a release if selected scenarios fail, but it cannot approve the full release gate."
      : "The release gate is incomplete and cannot approve the OpenClaw build.",
    likelyOwner: "Kova"
  };
}

function stateFromCoverage(kind, value) {
  if (kind !== "state-surface") {
    return null;
  }
  return String(value).split(":")[1] ?? null;
}

function platformCoverageKeys(platform) {
  if (!platform) {
    return new Set();
  }
  const keys = [
    platform.os,
    platform.arch,
    `${platform.os}-${platform.arch}`
  ];
  if (platform.os === "linux" && /microsoft|wsl/i.test(String(platform.release ?? ""))) {
    keys.push("wsl2");
  }
  return new Set(keys.filter(Boolean));
}

function normalizePolicyEntries(entries) {
  if (!Array.isArray(entries)) {
    return [];
  }
  return entries
    .map((entry) => ({
      scenario: typeof entry?.scenario === "string" ? entry.scenario : null,
      state: typeof entry?.state === "string" ? entry.state : null
    }))
    .filter((entry) => entry.scenario);
}

function severityForRecord(record, policy) {
  const key = recordKey(record);
  if (policy.warning.some((entry) => policyKey(entry) === key)) {
    return "warning";
  }
  return "blocking";
}

function buildRecordCard(record, severity) {
  const failed = firstFailedCommand(record);
  const kind = recordKind(record);
  const violations = record.violations ?? [];
  const firstViolation = violations[0]?.message ?? null;
  const summary = firstViolation ?? summarizeFailedCommand(failed) ?? `${record.status} ${record.scenario}`;

  return {
    severity,
    kind,
    scenario: record.scenario,
    state: record.state?.id ?? null,
    status: record.status,
    title: record.title,
    summary,
    expected: severity === "blocking" ? "PASS for release gate" : "PASS or accepted warning",
    actual: record.status,
    impact: impactForRecord(record, severity),
    likelyOwner: record.likelyOwner ?? "OpenClaw",
    failedCommand: failed?.command ?? null,
    violations: violations.map((violation) => violation.message),
    measurements: summarizeGateMeasurements(record.measurements)
  };
}

function buildPerformanceRegressionCard(regression) {
  return {
    severity: "blocking",
    kind: "performance-regression",
    scenario: regression.scenario ?? null,
    state: regression.state ?? null,
    status: "REGRESSED",
    title: "Performance Regression",
    summary: regression.message,
    expected: `<= ${regression.thresholdPercent}% regression`,
    actual: `${regression.increasePercent}% regression`,
    impact: "OpenClaw functionally passed but became slower or heavier than the accepted baseline.",
    likelyOwner: "OpenClaw",
    failedCommand: null,
    violations: [regression.message],
    measurements: {
      metric: regression.metric,
      baselineMedian: regression.baselineMedian,
      currentMedian: regression.currentMedian,
      baselineP95: regression.baselineP95,
      currentP95: regression.currentP95
    }
  };
}

function recordKind(record) {
  if (record.status === "BLOCKED") {
    return "blocked";
  }
  if (record.status === "SKIPPED") {
    return "skipped";
  }
  if (record.status === "DRY-RUN") {
    return "dry-run";
  }
  return "openclaw-failure";
}

function impactForRecord(record, severity) {
  if (severity === "warning") {
    return "This does not block the release gate, but it should be reviewed before shipping.";
  }
  if (record.status === "BLOCKED") {
    return "The release gate could not complete enough evidence to approve the OpenClaw build.";
  }
  return "This is a blocking OpenClaw release risk until fixed or explicitly reclassified.";
}

function summarizeGateMeasurements(measurements) {
  if (!measurements) {
    return null;
  }
  return {
    readinessClassification: measurements.readinessClassification ?? null,
    timeToHealthReadyMs: measurements.timeToHealthReadyMs ?? null,
    peakRssMb: measurements.peakRssMb ?? null,
    cpuPercentMax: measurements.cpuPercentMax ?? null,
    missingDependencyErrors: measurements.missingDependencyErrors ?? null,
    pluginLoadFailures: measurements.pluginLoadFailures ?? null,
    gatewayRestartCount: measurements.gatewayRestartCount ?? null,
    runtimeDepsStagingMs: measurements.runtimeDepsStagingMs ?? null
  };
}

function firstFailedCommand(record) {
  for (const phase of record.phases ?? []) {
    for (const result of phase.results ?? []) {
      if (result.status !== 0 || result.timedOut) {
        return result;
      }
    }
  }
  return null;
}

function summarizeFailedCommand(result) {
  if (!result) {
    return null;
  }
  const output = (result.stderr?.trim() || result.stdout?.trim() || "").split("\n").map((line) => line.trim()).filter(Boolean);
  const line = output.find((item) => /cannot find|missing|failed|error|timeout|econnrefused/i.test(item)) ?? output[0];
  if (line) {
    return line.length <= 220 ? line : `${line.slice(0, 217)}...`;
  }
  return result.timedOut ? `command timed out: ${result.command}` : `command exited ${result.status}: ${result.command}`;
}

function recordKey(record) {
  return `${record.scenario}:${record.state?.id ?? ""}`;
}

function policyKey(entry) {
  return `${entry.scenario}:${entry.state ?? ""}`;
}

function formatPolicyEntry(entry) {
  return entry.state ? `${entry.scenario}/${entry.state}` : entry.scenario;
}
