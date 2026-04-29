export function evaluateRecord(record, scenario) {
  if (record.status !== "PASS") {
    return record;
  }

  const thresholds = scenario.thresholds ?? {};
  const violations = [];
  const allResults = collectResults(record);
  const peakRssMb = collectPeakRss(record);
  const missingDependencyErrors = countMissingDependencyErrors(allResults) + countLogMetric(record, "missingDependencyErrors");
  const pluginLoadFailures = countLogMetric(record, "pluginLoadFailures");
  const metadataScanMentions = countLogMetric(record, "metadataScanMentions");
  const configNormalizationMentions = countLogMetric(record, "configNormalizationMentions");
  const gatewayRestartCount = countGatewayRestarts(record);
  const providerLoadMentions = countLogMetric(record, "providerLoadMentions");
  const modelCatalogMentions = countLogMetric(record, "modelCatalogMentions");
  const providerTimeoutMentions = countLogMetric(record, "providerTimeoutMentions");
  const eventLoopDelayMentions = countLogMetric(record, "eventLoopDelayMentions");
  const v8DiagnosticMentions = countLogMetric(record, "v8DiagnosticMentions");
  const v8ReportCount = countDiagnosticMetric(record, "v8ReportCount");
  const heapSnapshotCount = countDiagnosticMetric(record, "heapSnapshotCount");
  const finalGatewayState = record.finalMetrics?.service?.gatewayState ?? null;
  const healthFailures = countHealthFailures(record);
  const healthP95Ms = collectHealthP95(record);
  const listeningFailures = countListeningFailures(record);
  const tcpConnectMaxMs = collectTcpConnectMax(record);
  const timeToListeningMs = collectTimeToListening(record);
  const timeToHealthReadyMs = collectTimeToHealthReady(record);
  const readinessFailures = countReadinessFailures(record);
  const coldReadyMs = maxDurationWhere(allResults, (command) => command.startsWith("ocm start "));
  const warmReadyMs = maxDurationWhere(allResults, (command) => command.startsWith("ocm service restart "));
  const upgradeMs = maxDurationWhere(allResults, (command) => command.startsWith("ocm upgrade "));
  const statusMs = maxDurationWhere(allResults, (command) => command.includes(" -- status"));
  const pluginsListMs = maxDurationWhere(allResults, (command) => command.includes(" -- plugins list"));
  const modelsListMs = maxDurationWhere(allResults, (command) => command.includes(" -- models list"));

  checkDuration(violations, allResults, "statusMs", thresholds.statusMs, (command) => command.includes(" -- status"));
  checkDuration(violations, allResults, "pluginsListMs", thresholds.pluginsListMs, (command) => command.includes(" -- plugins list"));
  checkDuration(violations, allResults, "pluginUpdateDryRunMs", thresholds.pluginUpdateDryRunMs, (command) =>
    command.includes(" -- plugins update") && command.includes("--dry-run")
  );
  checkDuration(violations, allResults, "modelsListMs", thresholds.modelsListMs, (command) => command.includes(" -- models list"));
  checkDuration(violations, allResults, "coldReadyMs", thresholds.coldReadyMs ?? thresholds.gatewayReadyMs, (command) =>
    command.startsWith("ocm start ")
  );
  checkDuration(violations, allResults, "warmReadyMs", thresholds.warmReadyMs ?? thresholds.restartReadyMs, (command) =>
    command.startsWith("ocm service restart ")
  );
  checkDuration(violations, allResults, "upgradeMs", thresholds.upgradeMs, (command) => command.startsWith("ocm upgrade "));

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

  if (typeof thresholds.pluginLoadFailures === "number" && pluginLoadFailures > thresholds.pluginLoadFailures) {
    violations.push({
      kind: "log",
      metric: "pluginLoadFailures",
      expected: `<= ${thresholds.pluginLoadFailures}`,
      actual: pluginLoadFailures,
      message: `${pluginLoadFailures} plugin load failure patterns found`
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

  if (listeningFailures > 0) {
    violations.push({
      kind: "gateway",
      metric: "listeningFailures",
      expected: "0",
      actual: listeningFailures,
      message: `${listeningFailures} gateway TCP listening probes failed`
    });
  }

  if (readinessFailures > 0) {
    violations.push({
      kind: "gateway",
      metric: "readinessFailures",
      expected: "0",
      actual: readinessFailures,
      message: `${readinessFailures} gateway readiness windows expired before health was ready`
    });
  }

  const gatewayReadyThreshold = thresholds.gatewayReadyMs ?? thresholds.coldReadyMs;
  if (typeof gatewayReadyThreshold === "number" && timeToHealthReadyMs !== null && timeToHealthReadyMs > gatewayReadyThreshold) {
    violations.push({
      kind: "gateway",
      metric: "timeToHealthReadyMs",
      expected: `<= ${gatewayReadyThreshold}`,
      actual: timeToHealthReadyMs,
      message: `gateway health ready took ${timeToHealthReadyMs}ms, over threshold ${gatewayReadyThreshold}ms`
    });
  }

  if (typeof thresholds.gatewayRestarts === "number" && gatewayRestartCount > thresholds.gatewayRestarts) {
    violations.push({
      kind: "gateway",
      metric: "gatewayRestartCount",
      expected: `<= ${thresholds.gatewayRestarts}`,
      actual: gatewayRestartCount,
      message: `${gatewayRestartCount} gateway restart signals found`
    });
  }

  const allowedProviderTimeouts = typeof thresholds.providerTimeoutMentions === "number" ? thresholds.providerTimeoutMentions : 0;
  if (providerTimeoutMentions > allowedProviderTimeouts) {
    violations.push({
      kind: "provider",
      metric: "providerTimeoutMentions",
      expected: `<= ${allowedProviderTimeouts}`,
      actual: providerTimeoutMentions,
      message: `${providerTimeoutMentions} provider/model timeout signals found`
    });
  }

  const allowedEventLoopMentions = typeof thresholds.eventLoopDelayMentions === "number" ? thresholds.eventLoopDelayMentions : 0;
  if (eventLoopDelayMentions > allowedEventLoopMentions) {
    violations.push({
      kind: "performance",
      metric: "eventLoopDelayMentions",
      expected: `<= ${allowedEventLoopMentions}`,
      actual: eventLoopDelayMentions,
      message: `${eventLoopDelayMentions} event-loop delay signals found`
    });
  }

  record.measurements = {
    peakRssMb,
    coldReadyMs,
    warmReadyMs,
    upgradeMs,
    statusMs,
    pluginsListMs,
    modelsListMs,
    tcpConnectMaxMs,
    timeToListeningMs,
    timeToHealthReadyMs,
    missingDependencyErrors,
    finalGatewayState,
    healthFailures,
    healthP95Ms,
    listeningFailures,
    readinessFailures,
    gatewayRestartCount,
    pluginLoadFailures,
    metadataScanMentions,
    configNormalizationMentions,
    providerLoadMentions,
    modelCatalogMentions,
    providerTimeoutMentions,
    eventLoopDelayMentions,
    v8DiagnosticMentions,
    v8ReportCount,
    heapSnapshotCount
  };

  if (violations.length > 0) {
    record.status = "FAIL";
    record.violations = violations;
  }

  return record;
}

function maxDurationWhere(results, predicate) {
  const durations = results
    .filter((result) => predicate(result.command))
    .map((result) => result.durationMs)
    .filter((duration) => typeof duration === "number");
  return durations.length === 0 ? null : Math.max(...durations);
}

function countHealthFailures(record) {
  let count = 0;
  for (const phase of record.phases ?? []) {
    count += phase.metrics?.healthSummary?.failureCount ?? healthFailureCount([phase.metrics?.health]);
  }

  count += record.finalMetrics?.healthSummary?.failureCount ?? healthFailureCount([record.finalMetrics?.health]);
  return count;
}

function countListeningFailures(record) {
  let count = 0;
  for (const phase of record.phases ?? []) {
    if (phase.metrics?.readiness && phase.metrics.readiness.listeningReady === false && phase.metrics.readiness.deadlineMs > 0) {
      count += 1;
    }
  }
  if (record.finalMetrics?.readiness && record.finalMetrics.readiness.listeningReady === false && record.finalMetrics.readiness.deadlineMs > 0) {
    count += 1;
  }
  return count;
}

function countReadinessFailures(record) {
  let count = 0;
  for (const phase of record.phases ?? []) {
    if (phase.metrics?.readiness && phase.metrics.readiness.ready === false && phase.metrics.readiness.deadlineMs > 0) {
      count += 1;
    }
  }
  if (record.finalMetrics?.readiness && record.finalMetrics.readiness.ready === false && record.finalMetrics.readiness.deadlineMs > 0) {
    count += 1;
  }
  return count;
}

function collectTcpConnectMax(record) {
  const durations = [];
  for (const phase of record.phases ?? []) {
    const duration = phase.metrics?.listening?.durationMs;
    if (typeof duration === "number") {
      durations.push(duration);
    }
  }
  const finalDuration = record.finalMetrics?.listening?.durationMs;
  if (typeof finalDuration === "number") {
    durations.push(finalDuration);
  }
  return durations.length === 0 ? null : Math.max(...durations);
}

function collectTimeToListening(record) {
  const values = [];
  for (const phase of record.phases ?? []) {
    const value = phase.metrics?.readiness?.listeningReadyAtMs;
    if (typeof value === "number") {
      values.push(value);
    }
  }
  const finalValue = record.finalMetrics?.readiness?.listeningReadyAtMs;
  if (typeof finalValue === "number") {
    values.push(finalValue);
  }
  return values.length === 0 ? null : Math.max(...values);
}

function collectTimeToHealthReady(record) {
  const values = [];
  for (const phase of record.phases ?? []) {
    const value = phase.metrics?.readiness?.healthReadyAtMs;
    if (typeof value === "number") {
      values.push(value);
    }
  }
  const finalValue = record.finalMetrics?.readiness?.healthReadyAtMs;
  if (typeof finalValue === "number") {
    values.push(finalValue);
  }
  return values.length === 0 ? null : Math.max(...values);
}

function countGatewayRestarts(record) {
  const results = collectResults(record);
  const commandRestarts = results.filter((result) => result.command.startsWith("ocm service restart ")).length;
  return commandRestarts + countLogMetric(record, "gatewayRestartMentions");
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

function countLogMetric(record, key) {
  let count = 0;
  for (const phase of record.phases ?? []) {
    const value = phase.metrics?.logs?.[key];
    if (typeof value === "number") {
      count = Math.max(count, value);
    }
  }

  const finalValue = record.finalMetrics?.logs?.[key];
  if (typeof finalValue === "number") {
    count = Math.max(count, finalValue);
  }
  return count;
}

function countDiagnosticMetric(record, key) {
  let count = 0;
  for (const phase of record.phases ?? []) {
    const value = phase.metrics?.diagnostics?.[key];
    if (typeof value === "number") {
      count = Math.max(count, value);
    }
  }

  const finalValue = record.finalMetrics?.diagnostics?.[key];
  if (typeof finalValue === "number") {
    count = Math.max(count, finalValue);
  }
  return count;
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
