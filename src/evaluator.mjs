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

  record.measurements = {
    peakRssMb,
    missingDependencyErrors,
    finalGatewayState
  };

  if (violations.length > 0) {
    record.status = "FAIL";
    record.violations = violations;
  }

  return record;
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

