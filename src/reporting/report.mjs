import { summarizeAgentTurnBreakdownForMarkdown } from "../collectors/agent-turns.mjs";

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
    ""
  ];
  if (report.gate) {
    lines.push(...formatReleaseDecisionSection(report.gate, report.outputPaths, report.retainedGateArtifacts));
  }

  lines.push(
    "## Summary",
    "",
    `- Total scenarios: ${report.summary.total}`,
    ...Object.entries(report.summary.statuses).map(([status, count]) => `- ${status}: ${count}`),
    ""
  );
  if (!report.gate) {
    lines.push(...formatRecordFailureCards(report.records));
  }
  if (report.gate) {
    lines.push(...formatGateSection(report.gate));
  }

  if (report.performance) {
    lines.push(...formatPerformanceSection(report.performance, report.baseline));
  }
  lines.push(...formatResourceRoleSection(report.records));

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
      if (report.targetCleanup.result.attempts?.length > 1) {
        lines.push(`- Attempts: ${report.targetCleanup.result.attempts.length}`);
      }
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
    if (record.auth) {
      lines.push(`- Auth: ${record.auth.mode} (${record.auth.source}; provider ${record.auth.providerId ?? "none"})`);
      if (record.auth.fallbackFrom) {
        lines.push(`- Auth fallback: ${record.auth.fallbackFrom} -> ${record.auth.source}`);
      }
      if (record.auth.environmentDependent) {
        lines.push("- Live provider lane: environment-dependent; compare separately from deterministic mock baselines.");
      }
      if (record.auth.mockProvider) {
        lines.push(`- Mock provider mode: ${record.auth.mockProvider.mode}`);
      }
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
      if (record.measurements.resourceTopRolesByRss?.length > 0 || record.measurements.resourceTopRolesByCpu?.length > 0) {
        lines.push("- Resource by role:");
        for (const role of compactRolePeaks(record.measurements).slice(0, 6)) {
          lines.push(`  - ${role.role}: RSS ${role.peakRssMb ?? "unknown"} MB; CPU ${role.maxCpuPercent ?? "unknown"}%`);
        }
      }
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
      if (record.measurements.soakEvidence?.available) {
        lines.push(`- Soak trend: duration ${record.measurements.soakDurationMs ?? "unknown"} ms; iterations ${record.measurements.soakIterations ?? "unknown"}; command p95 ${record.measurements.soakCommandP95Ms ?? "unknown"} ms; health p95 ${record.measurements.soakHealthP95Ms ?? "unknown"} ms; RSS growth ${record.measurements.rssGrowthMb ?? "unknown"} MB; gateway RSS growth ${record.measurements.gatewayRssGrowthMb ?? "unknown"} MB`);
      }
      lines.push(`- Readiness failures: ${record.measurements.readinessFailures ?? "unknown"}`);
      lines.push(`- Gateway restarts: ${record.measurements.gatewayRestartCount ?? "unknown"}`);
      lines.push(`- Plugin load failures: ${record.measurements.pluginLoadFailures ?? "unknown"}`);
      lines.push(`- Metadata scan mentions: ${record.measurements.metadataScanMentions ?? "unknown"}`);
      lines.push(`- Config normalization mentions: ${record.measurements.configNormalizationMentions ?? "unknown"}`);
      lines.push(`- Provider/model timeout mentions: ${record.measurements.providerTimeoutMentions ?? "unknown"}`);
      lines.push(`- Event-loop delay mentions: ${record.measurements.eventLoopDelayMentions ?? "unknown"}`);
      lines.push(`- OpenClaw timeline: ${record.measurements.openclawTimelineAvailable ? "available" : "unavailable"} (${record.measurements.openclawTimelineEventCount ?? 0} events, ${record.measurements.openclawTimelineParseErrors ?? 0} parse errors)`);
      lines.push(`- Slowest OpenClaw span: ${record.measurements.openclawSlowestSpanName ?? "unknown"} ${record.measurements.openclawSlowestSpanMs ?? "unknown"} ms`);
      lines.push(`- Open OpenClaw spans: ${record.measurements.openclawOpenSpanCount ?? "unknown"} (${record.measurements.openclawOpenRequiredSpanCount ?? "unknown"} required)`);
      if (record.measurements.openclawOpenSpans?.length > 0) {
        const span = record.measurements.openclawOpenSpans[0];
        lines.push(`- Slowest open span: ${span.name}${span.ageMs !== null ? ` ${span.ageMs} ms` : ""}`);
      }
      if (record.measurements.openclawKeySpans) {
        const keySpanText = compactKeySpans(record.measurements.openclawKeySpans).slice(0, 5)
          .map((span) => `${span.name} max ${span.maxDurationMs ?? "?"}ms open ${span.openCount ?? 0}`)
          .join("; ");
        if (keySpanText) {
          lines.push(`- Key OpenClaw spans: ${keySpanText}`);
        }
      }
      lines.push(`- OpenClaw event-loop max: ${record.measurements.openclawEventLoopMaxMs ?? "unknown"} ms`);
      lines.push(`- OpenClaw provider request max: ${record.measurements.openclawProviderRequestMaxMs ?? "unknown"} ms`);
      lines.push(`- Structured event-loop delay: ${record.measurements.eventLoopDelayMs ?? "unknown"} ms`);
      lines.push(`- Runtime deps staging: ${record.measurements.runtimeDepsStagingMs ?? "unknown"} ms`);
      lines.push(`- Runtime deps warm reuse: ${record.measurements.runtimeDepsWarmReuseOk ?? "unknown"} (cold installs ${record.measurements.coldRuntimeDepsInstallCount ?? "unknown"}; warm restages ${record.measurements.warmRuntimeDepsRestageCount ?? "unknown"}; warm max ${record.measurements.warmRuntimeDepsStagingMs ?? "unknown"} ms)`);
      if (record.measurements.mcpBridgeEvidence?.available) {
        lines.push(`- MCP bridge: initialize ${record.measurements.mcpInitializeMs ?? "unknown"} ms; tools/list ${record.measurements.mcpToolsListMs ?? "unknown"} ms; tools ${record.measurements.mcpToolCount ?? "unknown"}; shutdown ${record.measurements.mcpShutdownMs ?? "unknown"} ms; exited ${record.measurements.mcpProcessExited ?? "unknown"}`);
      }
      if (record.measurements.browserAutomationEvidence?.available) {
        lines.push(`- Browser automation: doctor ${record.measurements.browserDoctorMs ?? "unknown"} ms; start ${record.measurements.browserStartMs ?? "unknown"} ms; open ${record.measurements.browserOpenMs ?? "unknown"} ms; tabs ${record.measurements.browserTabsMs ?? "unknown"} ms; snapshot ${record.measurements.browserSnapshotMs ?? "unknown"} ms; stop ${record.measurements.browserStopMs ?? "unknown"} ms; tabs ${record.measurements.browserTabCount ?? "unknown"}; stopped ${record.measurements.browserStopped ?? "unknown"}`);
      }
      if (record.measurements.mediaUnderstandingEvidence?.available) {
        lines.push(`- Media understanding: describe ${record.measurements.mediaDescribeMs ?? "unknown"} ms; timeout observed ${record.measurements.mediaTimeoutObserved ?? "unknown"}; command outer timeout ${record.measurements.mediaCommandTimedOut ?? "unknown"}; status after timeout ${record.measurements.mediaStatusAfterTimeoutMs ?? "unknown"} ms; gateway status ${record.measurements.mediaGatewayStatusWorks ?? "unknown"}`);
      }
      if (record.measurements.networkOfflineEvidence?.available) {
        lines.push(`- Network offline: turn ${record.measurements.networkTurnMs ?? "unknown"} ms; failure observed ${record.measurements.networkFailureObserved ?? "unknown"}; command outer timeout ${record.measurements.networkCommandTimedOut ?? "unknown"}; status after failure ${record.measurements.networkStatusAfterFailureMs ?? "unknown"} ms; gateway status ${record.measurements.networkGatewayStatusWorks ?? "unknown"}`);
      }
      lines.push(`- Provider/model timing: ${record.measurements.providerModelTimingMs ?? "unknown"} ms`);
      lines.push(`- Agent turn: ${record.measurements.agentTurnMs ?? "unknown"} ms (${record.measurements.agentResponseOk ?? "not-run"})`);
      if (record.measurements.agentTurnCount > 0) {
        lines.push(`- Agent cold/warm: cold ${record.measurements.coldAgentTurnMs ?? "unknown"} ms; warm ${record.measurements.warmAgentTurnMs ?? "unknown"} ms; delta ${record.measurements.agentColdWarmDeltaMs ?? "unknown"} ms`);
        lines.push(`- Agent pre-provider: cold ${record.measurements.coldPreProviderMs ?? "unknown"} ms; warm ${record.measurements.warmPreProviderMs ?? "unknown"} ms; delta ${record.measurements.agentColdWarmPreProviderDeltaMs ?? "unknown"} ms`);
        lines.push(`- Agent provider final: cold ${record.measurements.coldProviderFinalMs ?? "unknown"} ms; warm ${record.measurements.warmProviderFinalMs ?? "unknown"} ms`);
        lines.push(`- Agent turn stats: count ${record.measurements.agentTurnCount}; p95 ${record.measurements.agentTurnP95Ms ?? "unknown"} ms; max ${record.measurements.agentTurnMaxMs ?? "unknown"} ms; pre-provider p95 ${record.measurements.agentPreProviderP95Ms ?? "unknown"} ms`);
      }
      if (record.measurements.agentProviderAttribution) {
        lines.push(`- Provider evidence: ${record.measurements.agentProviderRequestCount ?? 0} request(s); provider work ${record.measurements.agentProviderFinalMs ?? "unknown"} ms; pre-provider ${record.measurements.agentPreProviderMs ?? "unknown"} ms; post-provider ${record.measurements.agentPostProviderMs ?? "unknown"} ms`);
      } else if (record.providerEvidence?.available) {
        const usage = record.providerEvidence.usage?.available
          ? `; tokens ${record.providerEvidence.usage.totalTokens ?? "unknown"}`
          : "";
        lines.push(`- Provider evidence: ${record.providerEvidence.requestCount ?? 0} request(s); provider duration ${record.providerEvidence.providerDurationMs ?? "unknown"} ms${usage}`);
      } else if (record.auth?.mode === "live") {
        lines.push(`- Provider evidence: unavailable for live lane (${record.providerEvidence?.error ?? "no provider events captured"})`);
      }
      if (record.measurements.agentLatencyDiagnosis) {
        lines.push(`- Agent latency diagnosis: ${record.measurements.agentLatencyDiagnosis.summary}`);
      }
      if (record.measurements.agentCleanupDiagnosis) {
        lines.push(`- Agent cleanup diagnosis: ${record.measurements.agentCleanupDiagnosis.summary}`);
      }
      if (record.measurements.agentProviderSimulation?.expected) {
        const sim = record.measurements.agentProviderSimulation;
        const concurrent = sim.concurrentObserved === null || sim.concurrentObserved === undefined
          ? ""
          : `; concurrent requests ${sim.providerRequestCount}/${sim.providerRequestCountMin}, max in-flight ${sim.providerMaxConcurrency}/${sim.providerConcurrencyMin}, ok ${sim.concurrentObserved}`;
        lines.push(`- Provider simulation: ${sim.mode}; observed ${sim.observedIssue}; containment ${sim.containmentOk}; recovery ${sim.recoveryOk ?? "n/a"}${concurrent}`);
      }
      if (record.measurements.agentFailureContainment) {
        const containment = record.measurements.agentFailureContainment;
        lines.push(`- Agent containment: process leaks ${containment.processLeakCount}; gateway healthy ${containment.gatewayHealthy ?? "n/a"}; status works ${containment.statusWorks ?? "n/a"}`);
      }
      if (record.measurements.agentFailureFixerSummary?.items?.length > 0) {
        lines.push("- Agent fixer evidence:");
        for (const item of record.measurements.agentFailureFixerSummary.items.slice(0, 4)) {
          lines.push(`  - ${item.kind}: ${item.summary}`);
        }
      }
      if (record.measurements.agentTurns?.length > 0) {
        lines.push("- Agent turns:");
        for (const turn of record.measurements.agentTurns.slice(0, 4)) {
          const route = turn.providerRoutes?.[0]?.value ?? "unknown";
          const status = turn.providerStatuses?.[0]?.value ?? "unknown";
          const issue = turn.providerErrorClasses?.[0]?.value ?? turn.providerOutcomes?.[0]?.value ?? "none";
          const expectedFailure = turn.expectedFailure ? "; expected failure observed " + turn.expectedFailureObserved : "";
          lines.push(`  - ${turn.label}: total ${turn.totalTurnMs ?? "unknown"} ms; pre-provider ${turn.preProviderMs ?? "unknown"} ms; provider ${turn.providerFinalMs ?? "unknown"} ms; post-provider ${turn.postProviderMs ?? "unknown"} ms; route ${route}; status ${status}; issue ${issue}; response ${turn.responseOk}; leaks ${turn.processLeakCount ?? "unknown"}${expectedFailure}`);
          const breakdown = summarizeAgentTurnBreakdownForMarkdown(turn.phaseBreakdown);
          if (breakdown) {
            lines.push(`    - breakdown: ${breakdown}`);
          }
        }
      }
      lines.push(`- Profiling: ${record.profiling?.enabled ? "enabled" : "off"} (${record.profiling?.interpretation ?? "unknown"})`);
      lines.push(`- V8 reports / heap snapshots: ${record.measurements.v8ReportCount ?? "unknown"} / ${record.measurements.heapSnapshotCount ?? "unknown"}`);
      lines.push(`- Node CPU/heap/trace profiles: ${record.measurements.nodeCpuProfileCount ?? "unknown"} / ${record.measurements.nodeHeapProfileCount ?? "unknown"} / ${record.measurements.nodeTraceEventCount ?? "unknown"}`);
      lines.push(`- Node profile top function: ${record.measurements.nodeProfileTopFunction ?? "unknown"} ${record.measurements.nodeProfileTopFunctionMs ?? "unknown"} ms`);
      lines.push(`- Node heap top function: ${record.measurements.nodeHeapTopFunction ?? "unknown"} ${record.measurements.nodeHeapTopFunctionMb ?? "unknown"} MB`);
      lines.push(`- Diagnostic / heap bytes: ${record.measurements.diagnosticArtifactBytes ?? "unknown"} / ${record.measurements.heapSnapshotBytes ?? "unknown"}`);
      lines.push(`- Diagnostic reports: ${record.measurements.diagnosticReportCount ?? "unknown"} (${record.measurements.diagnosticReportBytes ?? "unknown"} bytes)`);
      lines.push(`- Node profile bytes: ${record.measurements.nodeProfileArtifactBytes ?? "unknown"}`);
      lines.push(`- Resource peaks: CPU at ${record.measurements.resourcePeakCpuAtMs ?? "unknown"}ms; RSS at ${record.measurements.resourcePeakRssAtMs ?? "unknown"}ms`);
      if (record.measurements.diagnosticCorrelation?.findings?.length > 0) {
        lines.push("- Diagnostic correlation:");
        for (const finding of record.measurements.diagnosticCorrelation.findings.slice(0, 6)) {
          lines.push(`  - ${finding.summary}`);
        }
      }
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
            if (result.resourceSamples.topRolesByRss?.length > 0 || result.resourceSamples.topRolesByCpu?.length > 0) {
              const roles = compactRolePeaks(result.resourceSamples).slice(0, 4)
                .map((role) => `${role.role} RSS ${role.peakRssMb ?? "unknown"} MB CPU ${role.maxCpuPercent ?? "unknown"}%`)
                .join("; ");
              lines.push(`  - role peaks: ${roles}`);
            }
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
      if (record.cleanupResult.attempts?.length > 1) {
        lines.push(`- cleanup attempts: ${record.cleanupResult.attempts.length}`);
      }
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

function formatRecordFailureCards(records = []) {
  const cards = records
    .filter((record) => !["PASS", "DRY-RUN"].includes(record.status))
    .map(recordFailureCard);
  if (cards.length === 0) {
    return [];
  }

  const lines = ["## Failure Cards", ""];
  for (const card of cards.slice(0, 8)) {
    lines.push(`- ${card.status} ${card.scenario}${card.state ? `/${card.state}` : ""}: ${card.summary}`);
    lines.push(`  - likely owner: ${card.likelyOwner}`);
    if (card.command) {
      lines.push(`  - command: \`${card.command}\``);
    }
    for (const item of card.evidence.slice(0, 4)) {
      lines.push(`  - evidence: ${item}`);
    }
  }
  if (cards.length > 8) {
    lines.push(`- ${cards.length - 8} additional failure card(s) omitted from Markdown. See JSON report for full records.`);
  }
  lines.push("");
  return lines;
}

function formatResourceRoleSection(records = []) {
  const roles = summarizeResourceRoles(records).slice(0, 8);
  if (roles.length === 0) {
    return [];
  }

  const lines = ["## Resource Roles", ""];
  for (const role of roles) {
    lines.push(`- ${role.role}: RSS ${role.peakRssMb ?? "unknown"} MB; CPU ${role.maxCpuPercent ?? "unknown"}%; scenario ${role.scenario}${role.state ? `/${role.state}` : ""}`);
  }
  lines.push("");
  return lines;
}

function summarizeResourceRoles(records = []) {
  const byRole = new Map();
  for (const record of records) {
    for (const role of compactRolePeaks(record.measurements).slice(0, 8)) {
      const existing = byRole.get(role.role) ?? {
        role: role.role,
        peakRssMb: null,
        maxCpuPercent: null,
        scenario: record.scenario,
        state: record.state?.id ?? null
      };
      const rss = role.peakRssMb ?? null;
      const cpu = role.maxCpuPercent ?? null;
      if (rss !== null && (existing.peakRssMb === null || rss > existing.peakRssMb)) {
        existing.peakRssMb = rss;
        existing.scenario = record.scenario;
        existing.state = record.state?.id ?? null;
      }
      if (cpu !== null && (existing.maxCpuPercent === null || cpu > existing.maxCpuPercent)) {
        existing.maxCpuPercent = cpu;
      }
      byRole.set(role.role, existing);
    }
  }
  return [...byRole.values()].toSorted((left, right) => {
    const leftScore = Math.max(left.peakRssMb ?? 0, left.maxCpuPercent ?? 0);
    const rightScore = Math.max(right.peakRssMb ?? 0, right.maxCpuPercent ?? 0);
    return rightScore - leftScore;
  });
}

function recordFailureCard(record) {
  const failed = firstFailedCommand(record);
  const violationMessages = (record.violations ?? []).map((violation) => violation.message);
  const summary = violationMessages[0] ?? summarizeFailureReason(failed) ?? `${record.status} ${record.scenario}`;
  return {
    status: record.status,
    scenario: record.scenario,
    state: record.state?.id ?? null,
    summary,
    likelyOwner: record.likelyOwner ?? "OpenClaw",
    command: failed?.command ? shortCommand(failed.command) : null,
    evidence: briefEvidence(record.measurements ?? {}, violationMessages)
  };
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
    performance: summarizePerformance(report.performance, report.baseline),
    failureBrief: buildFailureBrief(report),
    recommendedNextScenario: buildRecommendedNextScenario(report),
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
  if (summary.recommendedNextScenario) {
    lines.push("");
    lines.push("Recommended next scenario:");
    lines.push(`- ${summary.recommendedNextScenario.reason}`);
    lines.push(`- ${summary.recommendedNextScenario.command}`);
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
    resourceByRole: measurements.resourceByRole ?? null,
    resourceTopRolesByRss: measurements.resourceTopRolesByRss ?? null,
    resourceTopRolesByCpu: measurements.resourceTopRolesByCpu ?? null,
    openclawTimelineAvailable: measurements.openclawTimelineAvailable ?? null,
    openclawSlowestSpanName: measurements.openclawSlowestSpanName ?? null,
    openclawSlowestSpanMs: measurements.openclawSlowestSpanMs ?? null,
    openclawOpenSpanCount: measurements.openclawOpenSpanCount ?? null,
    openclawOpenRequiredSpanCount: measurements.openclawOpenRequiredSpanCount ?? null,
    openclawOpenSpans: measurements.openclawOpenSpans ?? null,
    openclawKeySpans: measurements.openclawKeySpans ?? null,
    providerRequestCount: measurements.providerRequestCount ?? null,
    providerDurationMs: measurements.providerDurationMs ?? null,
    providerFirstByteLatencyMs: measurements.providerFirstByteLatencyMs ?? null,
    agentTurnCount: measurements.agentTurnCount ?? null,
    agentTurns: measurements.agentTurns ?? null,
    agentTurnStats: measurements.agentTurnStats ?? null,
    agentTurnP95Ms: measurements.agentTurnP95Ms ?? null,
    agentTurnMaxMs: measurements.agentTurnMaxMs ?? null,
    agentPreProviderP95Ms: measurements.agentPreProviderP95Ms ?? null,
    agentPreProviderMaxMs: measurements.agentPreProviderMaxMs ?? null,
    agentProviderFinalP95Ms: measurements.agentProviderFinalP95Ms ?? null,
    agentProviderFinalMaxMs: measurements.agentProviderFinalMaxMs ?? null,
    coldAgentTurnMs: measurements.coldAgentTurnMs ?? null,
    warmAgentTurnMs: measurements.warmAgentTurnMs ?? null,
    agentColdWarmDeltaMs: measurements.agentColdWarmDeltaMs ?? null,
    coldPreProviderMs: measurements.coldPreProviderMs ?? null,
    warmPreProviderMs: measurements.warmPreProviderMs ?? null,
    agentColdWarmPreProviderDeltaMs: measurements.agentColdWarmPreProviderDeltaMs ?? null,
    coldProviderFinalMs: measurements.coldProviderFinalMs ?? null,
    warmProviderFinalMs: measurements.warmProviderFinalMs ?? null,
    agentLatencyDiagnosis: measurements.agentLatencyDiagnosis ?? null,
    agentCleanupDiagnosis: measurements.agentCleanupDiagnosis ?? null,
    agentPreProviderMs: measurements.agentPreProviderMs ?? null,
    agentProviderFinalMs: measurements.agentProviderFinalMs ?? null,
    agentPostProviderMs: measurements.agentPostProviderMs ?? null,
    agentPreProviderDominance: measurements.agentPreProviderDominance ?? null,
    agentProviderRequestMissing: measurements.agentProviderRequestMissing ?? null,
    runtimeDepsStagingMs: measurements.runtimeDepsStagingMs ?? null,
    runtimeDepsInstallCount: measurements.runtimeDepsInstallCount ?? null,
    runtimeDepsInstallMaxMs: measurements.runtimeDepsInstallMaxMs ?? null,
    coldRuntimeDepsInstallCount: measurements.coldRuntimeDepsInstallCount ?? null,
    coldRuntimeDepsStagingMs: measurements.coldRuntimeDepsStagingMs ?? null,
    warmRuntimeDepsRestageCount: measurements.warmRuntimeDepsRestageCount ?? null,
    warmRuntimeDepsStagingMs: measurements.warmRuntimeDepsStagingMs ?? null,
    runtimeDepsWarmReuseOk: measurements.runtimeDepsWarmReuseOk ?? null,
    soakDurationMs: measurements.soakDurationMs ?? null,
    soakIterations: measurements.soakIterations ?? null,
    soakCommandP95Ms: measurements.soakCommandP95Ms ?? null,
    soakCommandFailures: measurements.soakCommandFailures ?? null,
    soakHealthP95Ms: measurements.soakHealthP95Ms ?? null,
    soakHealthFailures: measurements.soakHealthFailures ?? null,
    rssGrowthMb: measurements.rssGrowthMb ?? null,
    gatewayRssGrowthMb: measurements.gatewayRssGrowthMb ?? null,
    mediaUnderstandingEvidence: measurements.mediaUnderstandingEvidence ?? null,
    mediaDescribeMs: measurements.mediaDescribeMs ?? null,
    mediaTimeoutObserved: measurements.mediaTimeoutObserved ?? null,
    mediaCommandTimedOut: measurements.mediaCommandTimedOut ?? null,
    mediaStatusAfterTimeoutMs: measurements.mediaStatusAfterTimeoutMs ?? null,
    mediaGatewayStatusWorks: measurements.mediaGatewayStatusWorks ?? null,
    networkOfflineEvidence: measurements.networkOfflineEvidence ?? null,
    networkTurnMs: measurements.networkTurnMs ?? null,
    networkFailureObserved: measurements.networkFailureObserved ?? null,
    networkCommandTimedOut: measurements.networkCommandTimedOut ?? null,
    networkStatusAfterFailureMs: measurements.networkStatusAfterFailureMs ?? null,
    networkGatewayStatusWorks: measurements.networkGatewayStatusWorks ?? null,
    resourceTrend: measurements.resourceTrend ?? null,
    profilingEnabled: measurements.profilingEnabled ?? null,
    profilingResourceInterpretation: measurements.profilingResourceInterpretation ?? null,
    profilingBaselineEligible: measurements.profilingBaselineEligible ?? null,
    nodeCpuProfileCount: measurements.nodeCpuProfileCount ?? null,
    nodeHeapProfileCount: measurements.nodeHeapProfileCount ?? null,
    nodeTraceEventCount: measurements.nodeTraceEventCount ?? null,
    nodeProfileTopFunction: measurements.nodeProfileTopFunction ?? null,
    nodeProfileTopFunctionMs: measurements.nodeProfileTopFunctionMs ?? null,
    nodeHeapTopFunction: measurements.nodeHeapTopFunction ?? null,
    nodeHeapTopFunctionMb: measurements.nodeHeapTopFunctionMb ?? null,
    diagnosticCorrelation: measurements.diagnosticCorrelation ?? null
  };
}

function formatPerformanceSection(performance, baseline) {
  const lines = [
    "## Performance",
    "",
    `- Repeat: ${performance.repeat ?? "unknown"}`,
    `- Groups: ${performance.groupCount ?? 0}`,
    `- Unstable groups: ${performance.unstableGroupCount ?? 0}`,
    `- Profiled runs: ${performance.profiledRunCount ?? 0}`
  ];

  if (baseline?.comparison) {
    lines.push(`- Baseline regressions: ${baseline.comparison.regressionCount}`);
    lines.push(`- Missing baselines: ${baseline.comparison.missingBaselineCount}`);
    for (const regression of baseline.comparison.regressions.slice(0, 6)) {
      lines.push(`- Regression: ${regression.scenario}/${regression.state ?? "none"} ${regression.message}`);
    }
  }
  if (baseline?.review) {
    lines.push(`- Baseline update review: ${baseline.review.ok ? "accepted" : "rejected"} (${baseline.review.blockerCount ?? 0} blocker(s))`);
    for (const blocker of (baseline.review.blockers ?? []).slice(0, 4)) {
      lines.push(`- Baseline blocker: ${blocker.message}`);
    }
  }
  if (baseline?.saved) {
    lines.push(`- Baseline saved: ${baseline.saved.path}`);
  }

  for (const group of (performance.groups ?? []).slice(0, 8)) {
    const metricText = compactPerformanceMetrics(group.metrics).slice(0, 5)
      .map((metric) => `${metric.id} median ${metric.median}${metric.unit} p95 ${metric.p95}${metric.unit} max ${metric.max}${metric.unit}${metric.classification === "unstable" ? " unstable" : ""}`)
      .join("; ");
    const interpretation = group.resourceInterpretation === "instrumented" ? "; instrumented resources" : "";
    lines.push(`- ${group.scenario}/${group.state ?? "none"}: ${group.sampleCount} sample(s)${interpretation}${metricText ? `; ${metricText}` : ""}`);
  }

  lines.push("");
  return lines;
}

function summarizePerformance(performance, baseline) {
  if (!performance) {
    return null;
  }
  return {
    schemaVersion: performance.schemaVersion,
    repeat: performance.repeat ?? null,
    groupCount: performance.groupCount ?? 0,
    unstableGroupCount: performance.unstableGroupCount ?? 0,
    profiledRunCount: performance.profiledRunCount ?? 0,
    baselineRegressionCount: baseline?.comparison?.regressionCount ?? null,
    missingBaselineCount: baseline?.comparison?.missingBaselineCount ?? null,
    baselineReviewOk: baseline?.review?.ok ?? null,
    baselineReviewBlockerCount: baseline?.review?.blockerCount ?? null,
    savedBaselinePath: baseline?.saved?.path ?? null,
    regressions: baseline?.comparison?.regressions?.slice(0, 10) ?? []
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
    const visibleCards = (report.gate.cards ?? []).filter((card) => card.severity !== "info");
    for (const card of visibleCards) {
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
    if ((report.gate.infoCount ?? 0) > 0) {
      lines.push("");
      lines.push(`Info cards omitted: ${report.gate.infoCount}. See JSON report for full gate coverage details.`);
    }
    lines.push("");
  }

  const brief = buildFailureBrief(report);
  if (brief) {
    lines.push("Failure Brief");
    lines.push("");
    lines.push(`Decision: ${brief.decision}`);
    lines.push(`Primary blocker: ${brief.primaryBlocker}`);
    lines.push(`Why: ${brief.why}`);
    if (brief.evidence.length > 0) {
      lines.push("Evidence:");
      for (const item of brief.evidence) {
        lines.push(`- ${item}`);
      }
    }
    lines.push(`Likely owner: ${brief.likelyOwner}`);
    lines.push("Paste to fixer:");
    lines.push(brief.fixerPrompt);
    lines.push("");
  }
  const recommended = buildRecommendedNextScenario(report);
  if (recommended) {
    lines.push("Recommended next scenario");
    lines.push("");
    lines.push(`Reason: ${recommended.reason}`);
    lines.push(`Command: ${recommended.command}`);
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
        pushMeasurementBrief(lines, record.measurements, { compact: false });
      }
    } else if (record.violations?.length > 0) {
      if (record.measurements) {
        pushMeasurementBrief(lines, record.measurements, { compact: true });
        if (record.measurements.mediaUnderstandingEvidence?.available) {
          lines.push(`Media: describe ${record.measurements.mediaDescribeMs ?? "unknown"}ms; timeout ${record.measurements.mediaTimeoutObserved ?? "unknown"}; status ${record.measurements.mediaStatusAfterTimeoutMs ?? "unknown"}ms.`);
        }
        if (record.measurements.networkOfflineEvidence?.available) {
          lines.push(`Network offline: turn ${record.measurements.networkTurnMs ?? "unknown"}ms; failure ${record.measurements.networkFailureObserved ?? "unknown"}; status ${record.measurements.networkStatusAfterFailureMs ?? "unknown"}ms.`);
        }
      }
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

function buildFailureBrief(report) {
  const records = report.records ?? [];
  const blockingCards = (report.gate?.cards ?? []).filter((card) => card.severity === "blocking");
  const primaryCard = blockingCards.find((card) => card.kind === "openclaw-failure") ?? blockingCards[0] ?? null;
  const failedRecord = primaryCard
    ? records.find((record) => record.scenario === primaryCard.scenario && (record.state?.id ?? null) === (primaryCard.state ?? null))
    : records.find((record) => record.status === "FAIL" || record.status === "BLOCKED");

  if (!primaryCard && !failedRecord) {
    return null;
  }

  const measurements = failedRecord?.measurements ?? primaryCard?.measurements ?? {};
  const violations = failedRecord?.violations?.map((violation) => violation.message) ?? primaryCard?.violations ?? [];
  const primaryBlocker = [
    primaryCard?.scenario ?? failedRecord?.scenario ?? "unknown",
    primaryCard?.state ?? failedRecord?.state?.id ?? null
  ].filter(Boolean).join("/");
  const why = primaryCard?.summary ?? violations[0] ?? summarizeFailureReason(firstFailedCommand(failedRecord ?? {})) ?? "scenario failed";
  const evidence = briefEvidence(measurements, violations);
  const likelyOwner = primaryCard?.likelyOwner ?? failedRecord?.likelyOwner ?? "OpenClaw";

  return {
    decision: report.gate?.verdict ?? failedRecord?.status ?? "FAIL",
    primaryBlocker,
    why,
    evidence,
    likelyOwner,
    fixerPrompt: buildFixerPrompt({ report, primaryBlocker, why, measurements, evidence, likelyOwner })
  };
}

function buildRecommendedNextScenario(report) {
  const records = report.records ?? [];
  const card = (report.gate?.cards ?? [])
    .find((item) => item.severity === "blocking" && item.scenario) ??
    (report.gate?.cards ?? []).find((item) => item.severity === "warning" && item.scenario) ??
    null;
  const record = card
    ? records.find((item) => item.scenario === card.scenario && (item.state?.id ?? null) === (card.state ?? null))
    : records.find((item) => item.status === "FAIL" || item.status === "BLOCKED");
  const scenario = card?.scenario ?? record?.scenario;
  if (!scenario) {
    return null;
  }
  const state = card?.state ?? record?.state?.id ?? null;
  const target = report.target ?? record?.target;
  const command = [
    "node bin/kova.mjs run",
    target ? `--target ${quoteCliValue(target)}` : "--target <selector>",
    `--scenario ${quoteCliValue(scenario)}`,
    state ? `--state ${quoteCliValue(state)}` : null,
    "--execute",
    "--profile-on-failure",
    "--retain-on-failure",
    "--json"
  ].filter(Boolean).join(" ");
  const reason = card?.summary ??
    record?.violations?.[0]?.message ??
    summarizeFailureReason(firstFailedCommand(record ?? {})) ??
    "rerun the primary failing scenario with retained artifacts";
  return {
    scenario,
    state,
    target: target ?? null,
    reason,
    command
  };
}

function quoteCliValue(value) {
  const string = String(value);
  if (/^[A-Za-z0-9._/:=-]+$/.test(string)) {
    return string;
  }
  return `'${string.replaceAll("'", "'\\''")}'`;
}

function briefEvidence(measurements, violations) {
  const items = [];
  if (measurements.timeToHealthReadyMs !== null && measurements.timeToHealthReadyMs !== undefined) {
    items.push(`timeToHealthReadyMs: ${measurements.timeToHealthReadyMs}`);
  }
  if (measurements.timeToListeningMs !== null && measurements.timeToListeningMs !== undefined) {
    items.push(`timeToListeningMs: ${measurements.timeToListeningMs}`);
  }
  if (measurements.peakRssMb !== null && measurements.peakRssMb !== undefined) {
    items.push(`peakRssMb: ${measurements.peakRssMb}`);
  }
  if (measurements.cpuPercentMax !== null && measurements.cpuPercentMax !== undefined) {
    items.push(`cpuPercentMax: ${measurements.cpuPercentMax}`);
  }
  if (measurements.coldAgentTurnMs !== null && measurements.coldAgentTurnMs !== undefined) {
    items.push(`coldAgentTurnMs: ${measurements.coldAgentTurnMs}`);
  }
  if (measurements.warmAgentTurnMs !== null && measurements.warmAgentTurnMs !== undefined) {
    items.push(`warmAgentTurnMs: ${measurements.warmAgentTurnMs}`);
  }
  if (measurements.agentColdWarmDeltaMs !== null && measurements.agentColdWarmDeltaMs !== undefined) {
    items.push(`agentColdWarmDeltaMs: ${measurements.agentColdWarmDeltaMs}`);
  }
  if (measurements.agentLatencyDiagnosis?.summary) {
    items.push(measurements.agentLatencyDiagnosis.summary);
  }
  for (const role of compactRolePeaks(measurements).slice(0, 3)) {
    items.push(`${role.role}: ${role.peakRssMb ?? "unknown"}MB RSS, ${role.maxCpuPercent ?? "unknown"}% CPU`);
  }
  if (measurements.resourcePeakCpuAtMs !== null && measurements.resourcePeakCpuAtMs !== undefined) {
    items.push(`resourcePeakCpuAtMs: ${measurements.resourcePeakCpuAtMs}`);
  }
  if (measurements.nodeProfileTopFunction) {
    items.push(`topCpuFunction: ${measurements.nodeProfileTopFunction} ${measurements.nodeProfileTopFunctionMs ?? "unknown"}ms`);
  }
  if (measurements.nodeHeapTopFunction) {
    items.push(`topHeapFunction: ${measurements.nodeHeapTopFunction} ${measurements.nodeHeapTopFunctionMb ?? "unknown"}MB`);
  }
  if (measurements.missingDependencyErrors !== null && measurements.missingDependencyErrors !== undefined) {
    items.push(`missingDependencyErrors: ${measurements.missingDependencyErrors}`);
  }
  if (measurements.pluginLoadFailures !== null && measurements.pluginLoadFailures !== undefined) {
    items.push(`pluginLoadFailures: ${measurements.pluginLoadFailures}`);
  }
  if (measurements.warmRuntimeDepsRestageCount !== null && measurements.warmRuntimeDepsRestageCount !== undefined) {
    items.push(`warmRuntimeDepsRestageCount: ${measurements.warmRuntimeDepsRestageCount}`);
  }
  if (measurements.warmRuntimeDepsStagingMs !== null && measurements.warmRuntimeDepsStagingMs !== undefined) {
    items.push(`warmRuntimeDepsStagingMs: ${measurements.warmRuntimeDepsStagingMs}`);
  }
  if (measurements.rssGrowthMb !== null && measurements.rssGrowthMb !== undefined) {
    items.push(`rssGrowthMb: ${measurements.rssGrowthMb}`);
  }
  if (measurements.gatewayRssGrowthMb !== null && measurements.gatewayRssGrowthMb !== undefined) {
    items.push(`gatewayRssGrowthMb: ${measurements.gatewayRssGrowthMb}`);
  }
  if (measurements.soakCommandP95Ms !== null && measurements.soakCommandP95Ms !== undefined) {
    items.push(`soakCommandP95Ms: ${measurements.soakCommandP95Ms}`);
  }
  if (measurements.openclawOpenRequiredSpanCount > 0) {
    const span = measurements.openclawOpenSpans?.[0];
    items.push(`openRequiredSpans: ${measurements.openclawOpenRequiredSpanCount}${span ? `, slowest ${span.name}` : ""}`);
  }
  for (const finding of measurements.diagnosticCorrelation?.findings?.slice(0, 3) ?? []) {
    items.push(finding.summary);
  }
  for (const violation of violations.slice(0, 3)) {
    if (!items.includes(violation)) {
      items.push(violation);
    }
  }
  return items.slice(0, 8);
}

function compactKeySpans(keySpans) {
  return Object.values(keySpans ?? {})
    .filter((span) => (span.count ?? 0) > 0 || (span.openCount ?? 0) > 0)
    .toSorted((left, right) => (right.maxDurationMs ?? 0) - (left.maxDurationMs ?? 0) || (right.openCount ?? 0) - (left.openCount ?? 0));
}

function compactPerformanceMetrics(metrics = {}) {
  const preferred = [
    "timeToHealthReadyMs",
    "peakRssMb",
    "cpuPercentMax",
    "openclawEventLoopMaxMs",
    "agentTurnMs",
    "coldAgentTurnMs",
    "warmAgentTurnMs",
    "agentColdWarmDeltaMs",
    "coldPreProviderMs",
    "runtimeDepsStagingMs"
  ];
  const byId = new Map(Object.entries(metrics).map(([id, metric]) => [id, { id, ...metric }]));
  return [
    ...preferred.map((id) => byId.get(id)).filter(Boolean),
    ...[...byId.values()].filter((metric) => !preferred.includes(metric.id))
  ];
}

function compactRolePeaks(measurements) {
  const byRole = new Map();
  for (const role of measurements?.resourceTopRolesByRss ?? []) {
    byRole.set(role.role, { ...byRole.get(role.role), ...role });
  }
  for (const role of measurements?.resourceTopRolesByCpu ?? []) {
    byRole.set(role.role, { ...byRole.get(role.role), ...role });
  }
  if (byRole.size === 0 && measurements?.resourceByRole) {
    for (const [role, summary] of Object.entries(measurements.resourceByRole)) {
      byRole.set(role, { role, ...summary });
    }
  }
  return [...byRole.values()].toSorted((left, right) => {
    const leftScore = Math.max(left.peakRssMb ?? 0, left.maxCpuPercent ?? 0);
    const rightScore = Math.max(right.peakRssMb ?? 0, right.maxCpuPercent ?? 0);
    return rightScore - leftScore;
  });
}

function pushMeasurementBrief(lines, measurements, { compact }) {
  lines.push("Measurements:");
  lines.push(`- startup: listening ${valueMs(measurements.timeToListeningMs)}; health ${valueMs(measurements.timeToHealthReadyMs)}; readiness ${measurements.readinessClassification ?? "unknown"}; gateway ${measurements.finalGatewayState ?? "unknown"}; restarts ${measurements.gatewayRestartCount ?? "unknown"}`);
  lines.push(`- resources: peak RSS ${valueMb(measurements.peakRssMb)}; max CPU ${valuePercent(measurements.cpuPercentMax)}; samples ${measurements.resourceSampleCount ?? "unknown"}; roles ${rolePeakText(measurements)}`);
  lines.push(`- agent: turn ${valueMs(measurements.agentTurnMs, "not-run")}; cold/warm ${valueMs(measurements.coldAgentTurnMs)}/${valueMs(measurements.warmAgentTurnMs)}; cold-warm delta ${valueMs(measurements.agentColdWarmDeltaMs)}; pre-provider ${valueMs(measurements.agentPreProviderMs)}; provider ${valueMs(measurements.agentProviderFinalMs)}; cleanup ${valueMs(measurements.agentCleanupMaxMs)}; diagnosis ${measurements.agentLatencyDiagnosis?.kind ?? "unknown"}; leaks ${measurements.agentProcessLeakCount ?? "unknown"}`);
  lines.push(`- plugins/runtime: missing deps ${measurements.missingDependencyErrors ?? "unknown"}; plugin failures ${measurements.pluginLoadFailures ?? "unknown"}; runtime deps ${valueMs(measurements.runtimeDepsStagingMs)}${runtimeDepsPluginText(measurements)}; warm restages ${measurements.warmRuntimeDepsRestageCount ?? "unknown"}; warm reuse ${measurements.runtimeDepsWarmReuseOk ?? "unknown"}`);

  if (!compact || hasDiagnosticSignal(measurements)) {
    lines.push(`- diagnostics: timeline ${measurements.openclawTimelineAvailable ? "available" : "unavailable"}; slowest span ${measurements.openclawSlowestSpanName ?? "unknown"} ${valueMs(measurements.openclawSlowestSpanMs)}; open spans ${measurements.openclawOpenSpanCount ?? "unknown"} (${measurements.openclawOpenRequiredSpanCount ?? "unknown"} required); node CPU/heap/trace ${measurements.nodeCpuProfileCount ?? "unknown"}/${measurements.nodeHeapProfileCount ?? "unknown"}/${measurements.nodeTraceEventCount ?? "unknown"}`);
  }
  if (!compact && hasMcpSignal(measurements)) {
    lines.push(`- mcp: init ${valueMs(measurements.mcpInitializeMs)}; tools/list ${valueMs(measurements.mcpToolsListMs)}; shutdown ${valueMs(measurements.mcpShutdownMs)}; tools ${measurements.mcpToolCount ?? "unknown"}`);
  }
  if (!compact && hasBrowserSignal(measurements)) {
    lines.push(`- browser: start ${valueMs(measurements.browserStartMs)}; open ${valueMs(measurements.browserOpenMs)}; snapshot ${valueMs(measurements.browserSnapshotMs)}; tabs ${measurements.browserTabCount ?? "unknown"}; stopped ${measurements.browserStopped ?? "unknown"}`);
  }
}

function rolePeakText(measurements) {
  const text = compactRolePeaks(measurements).slice(0, 4)
    .map((role) => `${role.role} ${role.peakRssMb ?? "?"}MB/${role.maxCpuPercent ?? "?"}%`)
    .join(", ");
  return text || "unknown";
}

function runtimeDepsPluginText(measurements) {
  return measurements.runtimeDepsStagingPluginId ? ` (${measurements.runtimeDepsStagingPluginId})` : "";
}

function hasDiagnosticSignal(measurements) {
  return measurements.openclawTimelineAvailable ||
    measurements.openclawSlowestSpanName ||
    measurements.openclawOpenSpanCount !== undefined ||
    measurements.nodeCpuProfileCount !== undefined ||
    measurements.nodeHeapProfileCount !== undefined ||
    measurements.nodeTraceEventCount !== undefined;
}

function hasMcpSignal(measurements) {
  return measurements.mcpBridgeEvidence?.available ||
    measurements.mcpInitializeMs !== undefined ||
    measurements.mcpToolsListMs !== undefined ||
    measurements.mcpShutdownMs !== undefined;
}

function hasBrowserSignal(measurements) {
  return measurements.browserAutomationEvidence?.available ||
    measurements.browserStartMs !== undefined ||
    measurements.browserOpenMs !== undefined ||
    measurements.browserSnapshotMs !== undefined;
}

function valueMs(value, fallback = "unknown") {
  return value === null || value === undefined ? fallback : `${value}ms`;
}

function valueMb(value) {
  return value === null || value === undefined ? "unknown" : `${value} MB`;
}

function valuePercent(value) {
  return value === null || value === undefined ? "unknown" : `${value}%`;
}

function buildFixerPrompt({ report, primaryBlocker, why, measurements, evidence, likelyOwner }) {
  const parts = [
    `Investigate OpenClaw release gate failure ${primaryBlocker}.`,
    `Kova decision was ${report.gate?.verdict ?? "FAIL"} on ${report.platform?.os ?? "unknown"}-${report.platform?.arch ?? "unknown"}.`,
    `Primary evidence: ${why}.`
  ];
  if (evidence.length > 0) {
    parts.push(`Measurements: ${evidence.join("; ")}.`);
  }
  if (measurements.missingDependencyErrors === 0 && measurements.pluginLoadFailures === 0) {
    parts.push("Dependency/plugin load errors were zero, so focus on startup, memory, CPU, gateway readiness, runtime deps staging, provider/model load, and UI asset initialization.");
  }
  parts.push(`Likely owner area: ${likelyOwner}.`);
  return parts.join(" ");
}

function formatGateSection(gate) {
  const lines = [
    "## Release Gate",
    "",
    `- Verdict: ${gate.verdict}`,
    `- Complete: ${gate.complete ? "yes" : "no"}`,
    `- Partial: ${gate.partial ? "yes" : "no"}`,
    `- Missing required coverage/items: ${gate.missingRequiredCount ?? 0}`,
    `- Blocking: ${gate.blockingCount}`,
    `- Warnings: ${gate.warningCount}`,
    `- Info: ${gate.infoCount ?? 0}`,
    ""
  ];
  if (gate.baseline) {
    lines.push("### Historical Baseline");
    lines.push("");
    lines.push(`- Regressions: ${gate.baseline.regressionCount}`);
    lines.push(`- Missing baselines: ${gate.baseline.missingBaselineCount}`);
    if (gate.baseline.regressedGroups?.length > 0) {
      for (const group of gate.baseline.regressedGroups.slice(0, 4)) {
        lines.push(`- ${group.scenario}/${group.state ?? "none"}: ${group.regressionCount} regression(s)`);
      }
    }
    lines.push("");
  }
  const visibleCards = (gate.cards ?? []).filter((card) => card.severity !== "info");
  if (gate.subsystems?.length > 0) {
    lines.push("### Subsystems");
    lines.push("");
    for (const subsystem of gate.subsystems.slice(0, 6)) {
      lines.push(`- ${subsystem.owner}: ${subsystem.blockingCount} blocking, ${subsystem.warningCount} warning`);
      if (subsystem.primary?.summary) {
        lines.push(`  - primary: ${subsystem.primary.summary}`);
      }
    }
    lines.push("");
  }
  if (gate.fixerSummaries?.length > 0) {
    lines.push("### Fixer Briefs");
    lines.push("");
    for (const fixer of gate.fixerSummaries.slice(0, 4)) {
      lines.push(`- ${fixer.owner}: ${fixer.summary}`);
    }
    lines.push("");
  }
  if (visibleCards.length > 0) {
    lines.push("### Failure Cards");
    lines.push("");
    for (const card of visibleCards) {
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
  if ((gate.infoCount ?? 0) > 0) {
    lines.push(`Info cards omitted from Markdown: ${gate.infoCount}. See JSON report for full gate coverage details.`);
    lines.push("");
  }
  return lines;
}

function formatReleaseDecisionSection(gate, outputPaths, retainedGateArtifacts) {
  const lines = [
    "## Release Decision",
    "",
    `- Verdict: ${gate.verdict}`,
    `- Coverage: ${gate.complete ? "complete" : gate.partial ? "partial" : "incomplete"}`,
    `- Blocking / warnings / info: ${gate.blockingCount} / ${gate.warningCount} / ${gate.infoCount ?? 0}`
  ];

  if (outputPaths?.markdown) {
    lines.push(`- Markdown report: ${outputPaths.markdown}`);
  }
  if (outputPaths?.json) {
    lines.push(`- JSON report: ${outputPaths.json}`);
  }
  if (retainedGateArtifacts?.outputDir) {
    lines.push(`- Retained gate artifacts: ${retainedGateArtifacts.outputDir}`);
  } else if (retainedGateArtifacts?.status === "pending") {
    lines.push("- Retained gate artifacts: pending");
  }

  const topCards = (gate.cards ?? [])
    .filter((card) => card.severity === "blocking" || card.severity === "warning")
    .slice(0, 3);
  if (topCards.length > 0) {
    lines.push("");
    lines.push("Top findings:");
    for (const card of topCards) {
      lines.push(`- ${card.severity.toUpperCase()} ${card.scenario ?? "gate"}${card.state ? `/${card.state}` : ""}: ${card.summary}`);
    }
  }

  if (!gate.complete && gate.partial) {
    lines.push("");
    lines.push("This is a filtered gate slice. It can reject a release from selected-scenario failures, but it cannot approve the full release gate.");
  } else if (gate.verdict === "PARTIAL") {
    lines.push("");
    lines.push("This gate has incomplete required coverage and cannot approve the release.");
  }

  lines.push("");
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
  if (!result) {
    return null;
  }
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
