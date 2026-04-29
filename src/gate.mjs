export function evaluateGate(report, profile) {
  const policy = normalizeGatePolicy(profile);
  const records = report.records ?? [];
  const cards = [];

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
      cards.push({
        severity: "blocking",
        kind: "missing-required-scenario",
        scenario: required.scenario,
        state: required.state ?? null,
        status: "MISSING",
        title: "Required Scenario Missing",
        summary: `Required release gate scenario ${formatPolicyEntry(required)} was not present in the report.`,
        expected: "scenario selected and executed",
        actual: "missing",
        impact: "The release gate is incomplete and cannot approve the OpenClaw build.",
        likelyOwner: "Kova"
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

  const blockingCards = cards.filter((card) => card.severity === "blocking");
  const warningCards = cards.filter((card) => card.severity === "warning");
  const blocked = blockingCards.some((card) =>
    ["not-executed", "missing-required-scenario", "blocked", "skipped", "dry-run"].includes(card.kind)
  );
  const verdict = blocked ? "BLOCKED" : blockingCards.length > 0 ? "DO_NOT_SHIP" : "SHIP";

  return {
    schemaVersion: "kova.gate.v1",
    enabled: true,
    profileId: profile?.id ?? null,
    policyId: policy.id,
    verdict,
    ok: verdict === "SHIP",
    blockingCount: blockingCards.length,
    warningCount: warningCards.length,
    infoCount: cards.filter((card) => card.severity === "info").length,
    required: policy.blocking,
    warning: policy.warning,
    cards
  };
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
    warning
  };
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
