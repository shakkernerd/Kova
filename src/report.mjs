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
      lines.push(`- Missing dependency errors: ${record.measurements.missingDependencyErrors ?? "unknown"}`);
      lines.push(`- Final gateway state: ${record.measurements.finalGatewayState ?? "unknown"}`);
      lines.push(`- Health failures: ${record.measurements.healthFailures ?? "unknown"}`);
      lines.push(`- Health p95: ${record.measurements.healthP95Ms ?? "unknown"} ms`);
      lines.push(`- Plugin load failures: ${record.measurements.pluginLoadFailures ?? "unknown"}`);
      lines.push(`- Metadata scan mentions: ${record.measurements.metadataScanMentions ?? "unknown"}`);
      lines.push(`- Config normalization mentions: ${record.measurements.configNormalizationMentions ?? "unknown"}`);
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
    statuses: report.summary?.statuses ?? summarizeRecords(records).statuses,
    scenarios: records.map((record) => ({
      id: record.scenario,
      title: record.title,
      status: record.status,
      cleanup: record.cleanup ?? "not-run",
      state: record.state ?? null,
      failedCommand: firstFailedCommand(record)?.command ?? null,
      violations: record.violations ?? []
    }))
  };

  if (options.structured) {
    return summary;
  }

  const lines = [
    `Run: ${summary.runId}`,
    `Mode: ${summary.mode}`,
    `Target: ${summary.target}`,
    `Platform: ${summary.platform?.os ?? "unknown"} ${summary.platform?.release ?? ""} (${summary.platform?.arch ?? "unknown"})`,
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
    for (const violation of scenario.violations) {
      lines.push(`  violation: ${violation.message}`);
    }
  }

  return lines.join("\n");
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

  for (const record of records) {
    const failed = firstFailedCommand(record);
    lines.push(`Scenario: ${record.scenario}`);
    lines.push(`Result: ${record.status}`);
    lines.push(`Cleanup: ${record.cleanup ?? "not-run"}`);
    if (record.status === "PASS" || record.status === "DRY-RUN") {
      lines.push(`Evidence: ${record.phases?.length ?? 0} phases recorded.`);
      if (record.measurements) {
        lines.push(`Measurements: peak RSS ${record.measurements.peakRssMb ?? "unknown"} MB; final gateway ${record.measurements.finalGatewayState ?? "unknown"}; health failures ${record.measurements.healthFailures ?? "unknown"}; health p95 ${record.measurements.healthP95Ms ?? "unknown"}ms; missing deps ${record.measurements.missingDependencyErrors ?? "unknown"}; plugin load failures ${record.measurements.pluginLoadFailures ?? "unknown"}.`);
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

function firstFailedCommand(record) {
  for (const phase of record.phases ?? []) {
    for (const result of phase.results ?? []) {
      if (result.status !== 0 || result.timedOut) {
        return result;
      }
    }
  }
  if (record.cleanupResult && record.cleanupResult.status !== 0) {
    return record.cleanupResult;
  }
  return null;
}

function fencedSnippet(value) {
  return ["```text", ...value.split("\n").slice(0, 30), "```"].join("\n");
}
