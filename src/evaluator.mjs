export function evaluateRecord(record, scenario) {
  if (record.status !== "PASS") {
    return record;
  }

  const thresholds = scenario.thresholds ?? {};
  const violations = [];
  const allResults = collectResults(record);
  const peakRssMb = collectPeakRss(record);
  const missingDependencyErrors = countMissingDependencyErrors(allResults);
  const finalGatewayState = record.finalMetrics?.service?.gatewayState ?? null;
  const healthFailures = countHealthFailures(record);
  const healthP95Ms = collectHealthP95(record);

  checkDuration(violations, allResults, "statusMs", thresholds.statusMs, (command) => command.includes(" -- status"));
  checkDuration(violations, allResults, "pluginsListMs", thresholds.pluginsListMs, (command) => command.includes(" -- plugins list"));
  checkDuration(violations, allResults, "pluginUpdateDryRunMs", thresholds.pluginUpdateDryRunMs, (command) =>
    command.includes(" -- plugins update") && command.includes("--dry-run")
  );
  checkDuration(violations, allResults, "modelsListMs", thresholds.modelsListMs, (command) => command.includes(" -- models list"));

  if (typeof thresholds.peakRssMb === "number" && peakRssMb !== null && peakRssMb > thresholds.peakRssMb) {
    violations.push({
      kind: "threshold",
      metric: "peakRssMb",
      expected: `<= ${thresholds.peakRssMb}`,
      actual: peakRssMb,
      message: `peak RSS ${peakRssMb} MB exceeded threshold ${thresholds.peakRssMb} MB`
    });
  }

  const allowedMissingDependencyErrors =
    typeof thresholds.missingDependencyErrors === "number" ? thresholds.missingDependencyErrors : 0;
  if (missingDependencyErrors > allowedMissingDependencyErrors) {
    violations.push({
      kind: "log",
      metric: "missingDependencyErrors",
      expected: `<= ${allowedMissingDependencyErrors}`,
      actual: missingDependencyErrors,
      message: `${missingDependencyErrors} missing dependency/plugin load error patterns found`
    });
  }

  if (finalGatewayState && finalGatewayState !== "running") {
    violations.push({
      kind: "gateway",
      metric: "finalGatewayState",
      expected: "running",
      actual: finalGatewayState,
      message: `final gateway state was ${finalGatewayState}`
    });
  }

  if (typeof thresholds.healthFailures === "number" && healthFailures > thresholds.healthFailures) {
    violations.push({
      kind: "health",
      metric: "healthFailures",
      expected: `<= ${thresholds.healthFailures}`,
      actual: healthFailures,
      message: `${healthFailures} gateway health checks failed, over threshold ${thresholds.healthFailures}`
    });
  }

  if (typeof thresholds.healthP95Ms === "number" && healthP95Ms !== null && healthP95Ms > thresholds.healthP95Ms) {
    violations.push({
      kind: "health",
      metric: "healthP95Ms",
      expected: `<= ${thresholds.healthP95Ms}`,
      actual: healthP95Ms,
      message: `gateway health p95 ${healthP95Ms}ms exceeded threshold ${thresholds.healthP95Ms}ms`
    });
  }

  record.measurements = {
    peakRssMb,
    missingDependencyErrors,
    finalGatewayState,
    healthFailures,
    healthP95Ms
  };

  if (violations.length > 0) {
    record.status = "FAIL";
    record.violations = violations;
  }

  return record;
}

function countHealthFailures(record) {
  let count = 0;
  for (const phase of record.phases ?? []) {
    count += phase.metrics?.healthSummary?.failureCount ?? healthFailureCount([phase.metrics?.health]);
  }

  count += record.finalMetrics?.healthSummary?.failureCount ?? healthFailureCount([record.finalMetrics?.health]);
  return count;
}

function collectHealthP95(record) {
  const p95Values = [];
  for (const phase of record.phases ?? []) {
    const p95 = phase.metrics?.healthSummary?.p95Ms;
    if (typeof p95 === "number") {
      p95Values.push(p95);
    }
  }

  const finalP95 = record.finalMetrics?.healthSummary?.p95Ms;
  if (typeof finalP95 === "number") {
    p95Values.push(finalP95);
  }

  if (p95Values.length === 0) {
    return null;
  }
  return Math.max(...p95Values);
}

function healthFailureCount(samples) {
  return samples.filter((sample) => sample && !sample.ok).length;
}

function checkDuration(violations, results, metric, threshold, predicate) {
  if (typeof threshold !== "number") {
    return;
  }

  for (const result of results) {
    if (!predicate(result.command)) {
      continue;
    }
    if (result.durationMs > threshold) {
      violations.push({
        kind: "threshold",
        metric,
        command: result.command,
        expected: `<= ${threshold}`,
        actual: result.durationMs,
        message: `${result.command} took ${result.durationMs}ms, over threshold ${threshold}ms`
      });
    }
  }
}

function collectResults(record) {
  const results = [];
  for (const phase of record.phases ?? []) {
    for (const result of phase.results ?? []) {
      results.push(result);
    }
  }
  return results;
}

function collectPeakRss(record) {
  let peak = null;
  for (const phase of record.phases ?? []) {
    const rss = phase.metrics?.process?.rssMb;
    if (typeof rss === "number") {
      peak = peak === null ? rss : Math.max(peak, rss);
    }
  }

  const finalRss = record.finalMetrics?.process?.rssMb;
  if (typeof finalRss === "number") {
    peak = peak === null ? finalRss : Math.max(peak, finalRss);
  }

  return peak;
}

function countMissingDependencyErrors(results) {
  let count = 0;
  const pattern = /cannot find module|missing dependenc|missing runtime dep|failed to load/i;
  for (const result of results) {
    const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    for (const line of text.split("\n")) {
      if (pattern.test(line)) {
        count += 1;
      }
    }
  }
  return count;
}
