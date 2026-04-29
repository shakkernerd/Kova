export function summarizeRecords(records) {
  const statuses = {};
  for (const record of records) {
    statuses[record.status] = (statuses[record.status] ?? 0) + 1;
  }

  return {
    total: records.length,
    statuses
  };
}

export function renderMarkdownReport(report) {
  const lines = [
    "# Kova OpenClaw Runtime Report",
    "",
    `Generated: ${report.generatedAt}`,
    `Run ID: \`${report.runId}\``,
    `Mode: ${report.mode}`,
    `Platform: ${report.platform.os} ${report.platform.release} (${report.platform.arch}) · ${report.platform.node}`,
    "",
    "## Summary",
    "",
    `- Total scenarios: ${report.summary.total}`,
    ...Object.entries(report.summary.statuses).map(([status, count]) => `- ${status}: ${count}`),
    ""
  ];
  if (report.gate) {
    lines.push(...formatGateSection(report.gate));
  }

  if (report.targetCleanup) {
    lines.push("## Target Cleanup");
    lines.push("");
    lines.push(`- Runtime: \`${report.targetCleanup.runtimeName}\``);
    lines.push(`- Result: ${report.targetCleanup.status}`);
    lines.push(`- Command: \`${report.targetCleanup.command}\``);
    if (report.targetCleanup.reason) {
      lines.push(`- Reason: ${report.targetCleanup.reason}`);
    }
    if (report.targetCleanup.result) {
      lines.push(`- Exit: ${report.targetCleanup.result.status}`);
      lines.push(`- Duration: ${report.targetCleanup.result.durationMs}ms`);
    }
    lines.push("");
  }

  for (const record of report.records) {
    lines.push(`## ${record.title}`);
    lines.push("");
    lines.push(`- Scenario: \`${record.scenario}\``);
    lines.push(`- Result: ${record.status}`);
    lines.push(`- OpenClaw target: \`${record.target}\``);
    if (record.from) {
      lines.push(`- OpenClaw source: \`${record.from}\``);
    }
    if (record.state) {
      lines.push(`- State: \`${record.state.id}\` (${record.state.title})`);
    }
    lines.push(`- Harness env: \`${record.envName}\``);
    lines.push(`- Likely owner on failure: ${record.likelyOwner}`);
    lines.push(`- Objective: ${record.objective}`);
    if (record.measurements) {
      lines.push(`- Peak RSS: ${record.measurements.peakRssMb ?? "unknown"} MB`);
      lines.push(`- Max CPU: ${record.measurements.cpuPercentMax ?? "unknown"}%`);
      lines.push(`- Resource samples: ${record.measurements.resourceSampleCount ?? "unknown"}`);
      lines.push(`- Command tree peak RSS: ${record.measurements.resourcePeakCommandTreeRssMb ?? "unknown"} MB`);
      lines.push(`- Gateway peak RSS: ${record.measurements.resourcePeakGatewayRssMb ?? "unknown"} MB`);
      lines.push(`- Cold ready: ${record.measurements.coldReadyMs ?? "unknown"} ms`);
      lines.push(`- Warm ready: ${record.measurements.warmReadyMs ?? "unknown"} ms`);
      lines.push(`- Time to listening: ${record.measurements.timeToListeningMs ?? "unknown"} ms`);
      lines.push(`- Time to health ready: ${record.measurements.timeToHealthReadyMs ?? "unknown"} ms`);
      lines.push(`- Readiness classification: ${record.measurements.readinessClassification ?? "unknown"}`);
      if (record.measurements.readinessClassificationReason) {
        lines.push(`- Readiness reason: ${record.measurements.readinessClassificationReason}`);
      }
      lines.push(`- TCP connect max: ${record.measurements.tcpConnectMaxMs ?? "unknown"} ms`);
      lines.push(`- Missing dependency errors: ${record.measurements.missingDependencyErrors ?? "unknown"}`);
      lines.push(`- Final gateway state: ${record.measurements.finalGatewayState ?? "unknown"}`);
      lines.push(`- Health failures: ${record.measurements.healthFailures ?? "unknown"}`);
      lines.push(`- Health p95: ${record.measurements.healthP95Ms ?? "unknown"} ms`);
      lines.push(`- Readiness failures: ${record.measurements.readinessFailures ?? "unknown"}`);
      lines.push(`- Gateway restarts: ${record.measurements.gatewayRestartCount ?? "unknown"}`);
      lines.push(`- Plugin load failures: ${record.measurements.pluginLoadFailures ?? "unknown"}`);
      lines.push(`- Metadata scan mentions: ${record.measurements.metadataScanMentions ?? "unknown"}`);
      lines.push(`- Config normalization mentions: ${record.measurements.configNormalizationMentions ?? "unknown"}`);
      lines.push(`- Provider/model timeout mentions: ${record.measurements.providerTimeoutMentions ?? "unknown"}`);
      lines.push(`- Event-loop delay mentions: ${record.measurements.eventLoopDelayMentions ?? "unknown"}`);
      lines.push(`- OpenClaw timeline: ${record.measurements.openclawTimelineAvailable ? "available" : "unavailable"} (${record.measurements.openclawTimelineEventCount ?? 0} events, ${record.measurements.openclawTimelineParseErrors ?? 0} parse errors)`);
      lines.push(`- Slowest OpenClaw span: ${record.measurements.openclawSlowestSpanName ?? "unknown"} ${record.measurements.openclawSlowestSpanMs ?? "unknown"} ms`);
      lines.push(`- OpenClaw event-loop max: ${record.measurements.openclawEventLoopMaxMs ?? "unknown"} ms`);
      lines.push(`- OpenClaw provider request max: ${record.measurements.openclawProviderRequestMaxMs ?? "unknown"} ms`);
      lines.push(`- Structured event-loop delay: ${record.measurements.eventLoopDelayMs ?? "unknown"} ms`);
      lines.push(`- Runtime deps staging: ${record.measurements.runtimeDepsStagingMs ?? "unknown"} ms`);
      lines.push(`- Provider/model timing: ${record.measurements.providerModelTimingMs ?? "unknown"} ms`);
      lines.push(`- Agent turn: ${record.measurements.agentTurnMs ?? "unknown"} ms (${record.measurements.agentResponseOk ?? "not-run"})`);
      lines.push(`- V8 reports / heap snapshots: ${record.measurements.v8ReportCount ?? "unknown"} / ${record.measurements.heapSnapshotCount ?? "unknown"}`);
      lines.push(`- Node CPU/heap/trace profiles: ${record.measurements.nodeCpuProfileCount ?? "unknown"} / ${record.measurements.nodeHeapProfileCount ?? "unknown"} / ${record.measurements.nodeTraceEventCount ?? "unknown"}`);
      lines.push(`- Node profile top function: ${record.measurements.nodeProfileTopFunction ?? "unknown"} ${record.measurements.nodeProfileTopFunctionMs ?? "unknown"} ms`);
      lines.push(`- Diagnostic / heap bytes: ${record.measurements.diagnosticArtifactBytes ?? "unknown"} / ${record.measurements.heapSnapshotBytes ?? "unknown"}`);
      lines.push(`- Node profile bytes: ${record.measurements.nodeProfileArtifactBytes ?? "unknown"}`);
      if (record.measurements.resourceTopByCpu?.length > 0) {
        const top = record.measurements.resourceTopByCpu[0];
        lines.push(`- Top CPU process: pid ${top.pid} ${top.maxCpuPercent}% ${top.role} ${shortCommand(top.command)}`);
      }
      if (record.measurements.resourceTopByRss?.length > 0) {
        const top = record.measurements.resourceTopByRss[0];
        lines.push(`- Top RSS process: pid ${top.pid} ${top.peakRssMb} MB ${top.role} ${shortCommand(top.command)}`);
      }
    }
    lines.push("");
    if (record.violations?.length > 0) {
      lines.push("### Violations");
      lines.push("");
      for (const violation of record.violations) {
        lines.push(`- ${violation.message}`);
      }
      lines.push("");
    }
    lines.push("### Phases");
    lines.push("");

    for (const phase of record.phases) {
      lines.push(`#### ${phase.title}`);
      lines.push("");
      lines.push(phase.intent);
      lines.push("");
      if (phase.commands.length > 0) {
        lines.push("Commands:");
        lines.push("");
        for (const command of phase.commands) {
          lines.push(`- \`${command}\``);
        }
        lines.push("");
      }
      if (phase.evidence.length > 0) {
        lines.push("Evidence to capture:");
        lines.push("");
        for (const item of phase.evidence) {
          lines.push(`- ${item}`);
        }
        lines.push("");
      }
      if (phase.results?.length > 0) {
        lines.push("Results:");
        lines.push("");
        for (const result of phase.results) {
          lines.push(`- \`${result.command}\``);
          lines.push(`  - status: ${result.status}${result.timedOut ? " (timeout)" : ""}`);
          lines.push(`  - duration: ${result.durationMs}ms`);
          if (result.resourceSamples) {
            lines.push(`  - resource samples: ${result.resourceSamples.sampleCount}`);
            lines.push(`  - peak sampled RSS: ${result.resourceSamples.peakTotalRssMb ?? "unknown"} MB`);
            lines.push(`  - max sampled CPU: ${result.resourceSamples.maxTotalCpuPercent ?? "unknown"}%`);
            if (result.resourceSamples.topByCpu?.length > 0) {
              const top = result.resourceSamples.topByCpu[0];
              lines.push(`  - top CPU: pid ${top.pid} ${top.maxCpuPercent}% ${top.role} ${shortCommand(top.command)}`);
            }
            if (result.resourceSamples.artifactPath) {
              lines.push(`  - resource artifact: ${result.resourceSamples.artifactPath}`);
            }
          }
          const includeOutput = result.status !== 0 || result.timedOut;
          if (includeOutput && result.stdout.trim()) {
            lines.push("  - stdout:");
            lines.push("");
            lines.push(indentFence(result.stdout));
            lines.push("");
          }
          if (includeOutput && result.stderr.trim()) {
            lines.push("  - stderr:");
            lines.push("");
            lines.push(indentFence(result.stderr));
            lines.push("");
          }
        }
        lines.push("");
      }
      if (phase.metrics) {
        lines.push("Metrics:");
        lines.push("");
        lines.push(...formatMetrics(phase.metrics));
        lines.push("");
      }
    }

    lines.push("### Cleanup");
    lines.push("");
    lines.push(`- ${record.cleanup ?? "not-run"}`);
    if (record.cleanupResult) {
      lines.push(`- cleanup command: \`${record.cleanupResult.command}\``);
      lines.push(`- cleanup status: ${record.cleanupResult.status}`);
      lines.push(`- cleanup duration: ${record.cleanupResult.durationMs}ms`);
      if (record.cleanupResult.stderr.trim()) {
        lines.push("");
        lines.push("Cleanup stderr:");
        lines.push("");
        lines.push(indentFence(record.cleanupResult.stderr));
      }
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function formatMetrics(metrics) {
  const lines = [];
  if (metrics.service) {
    lines.push(`- gateway state: ${metrics.service.gatewayState ?? "unknown"}`);
    lines.push(`- child pid: ${metrics.service.childPid ?? "none"}`);
    lines.push(`- gateway port: ${metrics.service.gatewayPort ?? "unknown"}`);
    if (metrics.service.issue) {
      lines.push(`- issue: ${metrics.service.issue}`);
    }
  } else if (metrics.error) {
    lines.push(`- unavailable: ${metrics.error}`);
  }

  if (metrics.process) {
    if (metrics.process.rssMb !== null) {
      lines.push(`- RSS: ${metrics.process.rssMb} MB`);
    }
    if (metrics.process.cpuPercent !== null) {
      lines.push(`- CPU: ${metrics.process.cpuPercent}%`);
    }
  }

  if (metrics.readiness) {
    lines.push(`- readiness: ${metrics.readiness.ready ? "ready" : "not-ready"} after ${metrics.readiness.attempts} attempt(s)`);
    lines.push(`- readiness classification: ${metrics.readiness.classification?.state ?? "unknown"}`);
    if (metrics.readiness.classification?.reason) {
      lines.push(`- readiness reason: ${metrics.readiness.classification.reason}`);
    }
    lines.push(`- readiness threshold/deadline: ${metrics.readiness.thresholdMs ?? "unknown"}ms / ${metrics.readiness.deadlineMs ?? "unknown"}ms`);
    lines.push(`- time to listening: ${metrics.readiness.listeningReadyAtMs ?? "not-ready"}ms`);
    lines.push(`- time to health ready: ${metrics.readiness.healthReadyAtMs ?? "not-ready"}ms`);
  }

  if (metrics.listening) {
    lines.push(`- tcp listening: ${metrics.listening.ok ? "ok" : "not-ok"} in ${metrics.listening.durationMs}ms`);
    if (metrics.listening.error) {
      lines.push(`- tcp error: ${metrics.listening.error}`);
    }
  }

  if (metrics.health) {
    lines.push(`- health: ${metrics.health.ok ? "ok" : "not-ok"}${metrics.health.status ? ` (${metrics.health.status})` : ""} in ${metrics.health.durationMs}ms`);
    if (metrics.health.error) {
      lines.push(`- health error: ${metrics.health.error}`);
    }
  }

  if (metrics.healthSummary) {
    lines.push(`- health samples: ${metrics.healthSummary.okCount}/${metrics.healthSummary.count} ok`);
    lines.push(`- health latency p95/max: ${metrics.healthSummary.p95Ms ?? "unknown"}ms / ${metrics.healthSummary.maxMs ?? "unknown"}ms`);
  }

  if (metrics.logs) {
    lines.push(`- log missing dependency errors: ${metrics.logs.missingDependencyErrors}`);
    lines.push(`- log plugin load failures: ${metrics.logs.pluginLoadFailures}`);
    lines.push(`- log metadata scan mentions: ${metrics.logs.metadataScanMentions}`);
    lines.push(`- log config normalization mentions: ${metrics.logs.configNormalizationMentions}`);
    lines.push(`- log gateway restart mentions: ${metrics.logs.gatewayRestartMentions}`);
    lines.push(`- log provider/model timeout mentions: ${metrics.logs.providerTimeoutMentions}`);
    lines.push(`- log event-loop delay mentions: ${metrics.logs.eventLoopDelayMentions}`);
    if (metrics.logs.observedWindowMs !== null) {
      lines.push(`- log observed window: ${metrics.logs.observedWindowMs}ms`);
    }
  }

  if (metrics.diagnostics) {
    lines.push(`- diagnostic files: ${metrics.diagnostics.fileCount}`);
    lines.push(`- V8 reports: ${metrics.diagnostics.v8ReportCount}`);
    lines.push(`- heap snapshots: ${metrics.diagnostics.heapSnapshotCount}`);
    lines.push(`- diagnostic artifact bytes: ${metrics.diagnostics.artifactBytes}`);
  }

  if (metrics.heapSnapshot) {
    lines.push(`- heap snapshot trigger: ${metrics.heapSnapshot.fileCount} file(s), ${metrics.heapSnapshot.artifactBytes} bytes`);
  }

  if (metrics.nodeProfiles) {
    lines.push(`- Node profile artifacts: ${metrics.nodeProfiles.fileCount}`);
    lines.push(`- Node CPU profiles: ${metrics.nodeProfiles.cpuProfileCount}`);
    lines.push(`- Node heap profiles: ${metrics.nodeProfiles.heapProfileCount}`);
    lines.push(`- Node trace events: ${metrics.nodeProfiles.traceEventCount}`);
    lines.push(`- Node profile artifact bytes: ${metrics.nodeProfiles.artifactBytes}`);
    if (metrics.nodeProfiles.cpuProfileSummary?.topFunctions?.length > 0) {
      const top = metrics.nodeProfiles.cpuProfileSummary.topFunctions[0];
      lines.push(`- Node top CPU function: ${top.functionName} ${top.selfMs}ms ${shortLocation(top.url, top.lineNumber)}`);
    }
  }

  if (metrics.openclawDiagnostics) {
    lines.push(`- OpenClaw diagnostics source: ${metrics.openclawDiagnostics.source}`);
    lines.push(`- OpenClaw diagnostic events: ${metrics.openclawDiagnostics.eventCount}`);
    lines.push(`- plugin metadata scans: ${metrics.openclawDiagnostics.pluginMetadataScanCount ?? "unknown"}`);
    lines.push(`- config normalizations: ${metrics.openclawDiagnostics.configNormalizationCount ?? "unknown"}`);
    lines.push(`- runtime deps staging: ${metrics.openclawDiagnostics.runtimeDepsStagingMs ?? "unknown"}ms`);
    lines.push(`- event-loop delay: ${metrics.openclawDiagnostics.eventLoopDelayMs ?? "unknown"}ms`);
    lines.push(`- provider/model timing: ${metrics.openclawDiagnostics.providerModelTimingMs ?? "unknown"}ms`);
  }

  if (metrics.timeline) {
    lines.push(`- OpenClaw timeline: ${metrics.timeline.available ? "available" : "unavailable"}`);
    lines.push(`- OpenClaw timeline events: ${metrics.timeline.eventCount ?? 0}`);
    lines.push(`- OpenClaw timeline parse errors: ${metrics.timeline.parseErrorCount ?? 0}`);
    if (metrics.timeline.slowestSpans?.length > 0) {
      const span = metrics.timeline.slowestSpans[0];
      lines.push(`- slowest OpenClaw span: ${span.name} ${span.durationMs}ms`);
    }
    if (metrics.timeline.repeatedSpans?.length > 0) {
      const span = metrics.timeline.repeatedSpans[0];
      lines.push(`- most expensive repeated span: ${span.name} ${span.count}x ${span.totalDurationMs}ms`);
    }
    lines.push(`- OpenClaw event-loop max: ${metrics.timeline.eventLoop?.maxMs ?? "unknown"}ms`);
    lines.push(`- OpenClaw provider request max: ${metrics.timeline.providers?.maxDurationMs ?? "unknown"}ms`);
    if (metrics.timeline.runtimeDeps?.slowest) {
      const runtimeDeps = metrics.timeline.runtimeDeps.slowest;
      const plugin = runtimeDeps.pluginId ? ` (${runtimeDeps.pluginId})` : "";
      lines.push(`- slowest runtime deps stage: ${runtimeDeps.durationMs}ms${plugin}`);
    }
    if (metrics.timeline.runtimeDeps?.byPlugin?.length > 0) {
      const top = metrics.timeline.runtimeDeps.byPlugin
        .slice(0, 3)
        .map((entry) => `${entry.pluginId}:${entry.totalDurationMs}ms/${entry.count}x`)
        .join(", ");
      lines.push(`- runtime deps by plugin: ${top}`);
    }
    lines.push(`- OpenClaw child process failures: ${metrics.timeline.childProcesses?.failedCount ?? 0}`);
  }

  if (metrics.collectors?.length > 0) {
    lines.push("- collectors:");
    for (const collector of metrics.collectors) {
      const suffix = collector.error ? ` (${collector.error})` : "";
      lines.push(`  - ${collector.id}: ${collector.status}, ${collector.durationMs}ms, artifacts ${collector.artifactCount}${suffix}`);
    }
  }

  return lines.length > 0 ? lines : ["- unavailable"];
}

function indentFence(value) {
  return ["  ```text", ...value.trim().split("\n").slice(0, 80).map((line) => `  ${line}`), "  ```"].join("\n");
}

export function renderReportSummary(report, options = {}) {
  const records = report.records ?? [];
  const summary = {
    runId: report.runId,
    mode: report.mode,
    target: report.target,
    from: report.from ?? null,
    platform: report.platform,
    gate: report.gate ?? null,
    statuses: report.summary?.statuses ?? summarizeRecords(records).statuses,
    scenarios: records.map((record) => {
      const failed = firstFailedCommand(record);
      return {
        id: record.scenario,
        title: record.title,
        status: record.status,
        cleanup: record.cleanup ?? "not-run",
        state: record.state ?? null,
        failedCommand: failed?.command ?? null,
        failureReason: failed ? summarizeFailureReason(failed) : null,
        measurements: summarizeMeasurements(record.measurements),
        violations: record.violations ?? []
      };
    })
  };

  if (options.structured) {
    return summary;
  }

  const lines = [
    `Run: ${summary.runId}`,
    `Mode: ${summary.mode}`,
    `Target: ${summary.target}`,
    `Platform: ${summary.platform?.os ?? "unknown"} ${summary.platform?.release ?? ""} (${summary.platform?.arch ?? "unknown"})`,
    ...(summary.gate ? [
      `Gate: ${summary.gate.verdict} (${summary.gate.blockingCount} blocking, ${summary.gate.warningCount} warning)`
    ] : []),
    "Statuses:",
    ...Object.entries(summary.statuses).map(([status, count]) => `- ${status}: ${count}`),
    "",
    "Scenarios:"
  ];

  for (const scenario of summary.scenarios) {
    lines.push(`- ${scenario.status} ${scenario.id} (${scenario.cleanup})`);
    if (scenario.failedCommand) {
      lines.push(`  failed command: ${scenario.failedCommand}`);
    }
    if (scenario.failureReason) {
      lines.push(`  reason: ${scenario.failureReason}`);
    }
    for (const violation of scenario.violations) {
      lines.push(`  violation: ${violation.message}`);
    }
  }

  return lines.join("\n");
}

function summarizeMeasurements(measurements) {
  if (!measurements) {
    return null;
  }

  return {
    peakRssMb: measurements.peakRssMb ?? null,
    cpuPercentMax: measurements.cpuPercentMax ?? null,
    timeToListeningMs: measurements.timeToListeningMs ?? null,
    timeToHealthReadyMs: measurements.timeToHealthReadyMs ?? null,
    readinessClassification: measurements.readinessClassification ?? null,
    readinessClassificationReason: measurements.readinessClassificationReason ?? null,
    healthFailures: measurements.healthFailures ?? null,
    missingDependencyErrors: measurements.missingDependencyErrors ?? null,
    pluginLoadFailures: measurements.pluginLoadFailures ?? null,
    resourceSampleCount: measurements.resourceSampleCount ?? null,
    openclawTimelineAvailable: measurements.openclawTimelineAvailable ?? null,
    openclawSlowestSpanName: measurements.openclawSlowestSpanName ?? null,
    openclawSlowestSpanMs: measurements.openclawSlowestSpanMs ?? null,
    nodeCpuProfileCount: measurements.nodeCpuProfileCount ?? null,
    nodeHeapProfileCount: measurements.nodeHeapProfileCount ?? null,
    nodeTraceEventCount: measurements.nodeTraceEventCount ?? null,
    nodeProfileTopFunction: measurements.nodeProfileTopFunction ?? null,
    nodeProfileTopFunctionMs: measurements.nodeProfileTopFunctionMs ?? null
  };
}

export function renderPasteSummary(report) {
  const records = report.records ?? [];
  const lines = [
    "Kova OpenClaw Runtime Findings",
    "",
    `Run: ${report.runId}`,
    `Target: ${report.target}`,
    `Mode: ${report.mode}`,
    `Platform: ${report.platform?.os ?? "unknown"} ${report.platform?.release ?? ""} (${report.platform?.arch ?? "unknown"})`,
    ""
  ];

  if (report.gate) {
    lines.push(`Gate: ${report.gate.verdict}`);
    lines.push(`Blocking: ${report.gate.blockingCount}`);
    lines.push(`Warnings: ${report.gate.warningCount}`);
    for (const card of report.gate.cards ?? []) {
      lines.push("");
      lines.push(`${card.severity.toUpperCase()}: ${card.scenario ?? "gate"}${card.state ? `/${card.state}` : ""}`);
      lines.push(`Summary: ${card.summary}`);
      lines.push(`Expected: ${card.expected}`);
      lines.push(`Actual: ${card.actual}`);
      lines.push(`Impact: ${card.impact}`);
      lines.push(`Likely owner: ${card.likelyOwner}`);
      if (card.failedCommand) {
        lines.push(`Command: ${card.failedCommand}`);
      }
    }
    lines.push("");
  }

  for (const record of records) {
    const failed = firstFailedCommand(record);
    lines.push(`Scenario: ${record.scenario}`);
    lines.push(`Result: ${record.status}`);
    lines.push(`Cleanup: ${record.cleanup ?? "not-run"}`);
    if (record.status === "PASS" || record.status === "DRY-RUN") {
      lines.push(`Evidence: ${record.phases?.length ?? 0} phases recorded.`);
      if (record.measurements) {
        const runtimeDepsPlugin = record.measurements.runtimeDepsStagingPluginId ? ` (${record.measurements.runtimeDepsStagingPluginId})` : "";
        lines.push(`Measurements: cold ready ${record.measurements.coldReadyMs ?? "unknown"}ms; warm ready ${record.measurements.warmReadyMs ?? "unknown"}ms; listening ${record.measurements.timeToListeningMs ?? "unknown"}ms; health ready ${record.measurements.timeToHealthReadyMs ?? "unknown"}ms; readiness ${record.measurements.readinessClassification ?? "unknown"}; peak RSS ${record.measurements.peakRssMb ?? "unknown"} MB; max CPU ${record.measurements.cpuPercentMax ?? "unknown"}%; samples ${record.measurements.resourceSampleCount ?? "unknown"}; final gateway ${record.measurements.finalGatewayState ?? "unknown"}; health failures ${record.measurements.healthFailures ?? "unknown"}; health p95 ${record.measurements.healthP95Ms ?? "unknown"}ms; missing deps ${record.measurements.missingDependencyErrors ?? "unknown"}; plugin load failures ${record.measurements.pluginLoadFailures ?? "unknown"}; restarts ${record.measurements.gatewayRestartCount ?? "unknown"}; agent turn ${record.measurements.agentTurnMs ?? "not-run"}ms; provider/model timeouts ${record.measurements.providerTimeoutMentions ?? "unknown"}; event-loop signals ${record.measurements.eventLoopDelayMentions ?? "unknown"}; timeline ${record.measurements.openclawTimelineAvailable ? "available" : "unavailable"}; slowest span ${record.measurements.openclawSlowestSpanName ?? "unknown"} ${record.measurements.openclawSlowestSpanMs ?? "unknown"}ms; node profiles ${record.measurements.nodeCpuProfileCount ?? "unknown"}/${record.measurements.nodeHeapProfileCount ?? "unknown"}/${record.measurements.nodeTraceEventCount ?? "unknown"}; top CPU ${record.measurements.nodeProfileTopFunction ?? "unknown"} ${record.measurements.nodeProfileTopFunctionMs ?? "unknown"}ms; runtime deps staging ${record.measurements.runtimeDepsStagingMs ?? "unknown"}ms${runtimeDepsPlugin}.`);
      }
    } else if (record.violations?.length > 0) {
      lines.push("Violations:");
      for (const violation of record.violations) {
        lines.push(`- ${violation.message}`);
      }
    } else if (failed) {
      lines.push("Failure:");
      lines.push(`- Command: ${failed.command}`);
      lines.push(`- Status: ${failed.status}${failed.timedOut ? " (timeout)" : ""}`);
      lines.push(`- Duration: ${failed.durationMs}ms`);
      lines.push(`- Likely OpenClaw area: ${record.likelyOwner ?? "OpenClaw"}`);
      const stderr = failed.stderr?.trim();
      const stdout = failed.stdout?.trim();
      if (stderr) {
        lines.push("- stderr:");
        lines.push(fencedSnippet(stderr));
      } else if (stdout) {
        lines.push("- stdout:");
        lines.push(fencedSnippet(stdout));
      }
    } else {
      lines.push("Failure: scenario did not record a failed command; inspect JSON report.");
    }
    lines.push("");
  }

  return lines.join("\n");
}

function formatGateSection(gate) {
  const lines = [
    "## Release Gate",
    "",
    `- Verdict: ${gate.verdict}`,
    `- Blocking: ${gate.blockingCount}`,
    `- Warnings: ${gate.warningCount}`,
    ""
  ];
  if ((gate.cards ?? []).length > 0) {
    lines.push("### Failure Cards");
    lines.push("");
    for (const card of gate.cards) {
      lines.push(`- ${card.severity.toUpperCase()} ${card.scenario ?? "gate"}${card.state ? `/${card.state}` : ""}: ${card.summary}`);
      lines.push(`  - expected: ${card.expected}`);
      lines.push(`  - actual: ${card.actual}`);
      lines.push(`  - impact: ${card.impact}`);
      lines.push(`  - likely owner: ${card.likelyOwner}`);
      if (card.failedCommand) {
        lines.push(`  - command: \`${card.failedCommand}\``);
      }
    }
    lines.push("");
  }
  return lines;
}

function firstFailedCommand(record) {
  for (const phase of record.phases ?? []) {
    for (const result of phase.results ?? []) {
      if (result.status !== 0 || result.timedOut) {
        return result;
      }
    }
  }
  if (record.cleanup === "destroy-failed" && record.cleanupResult && record.cleanupResult.status !== 0) {
    return record.cleanupResult;
  }
  return null;
}

function summarizeFailureReason(result) {
  const output = (result.stderr?.trim() || result.stdout?.trim() || "").trim();
  if (!output) {
    return result.timedOut ? "command timed out" : `command exited with status ${result.status}`;
  }

  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^Run "ocm help"/.test(line));
  const priorityPatterns = [
    /Cannot find module/i,
    /Error \[/i,
    /ECONNREFUSED/i,
    /timed out|timeout/i,
    /missing/i,
    /failed/i
  ];
  const important = priorityPatterns.map((pattern) => lines.find((line) => pattern.test(line))).find(Boolean);
  const line = important ?? lines[0] ?? output;
  return line.length <= 260 ? line : `${line.slice(0, 257)}...`;
}

function fencedSnippet(value) {
  return ["```text", ...value.split("\n").slice(0, 30), "```"].join("\n");
}

function shortCommand(command) {
  const value = String(command ?? "").replace(/\s+/g, " ").trim();
  return value.length <= 90 ? value : `${value.slice(0, 87)}...`;
}

function shortLocation(url, lineNumber) {
  const value = String(url ?? "");
  const label = value.length <= 72 ? value : `...${value.slice(-69)}`;
  return lineNumber === null || lineNumber === undefined ? label : `${label}:${lineNumber}`;
}
