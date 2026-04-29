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
    lines.push(`- Harness env: \`${record.envName}\``);
    lines.push(`- Likely owner on failure: ${record.likelyOwner}`);
    lines.push(`- Objective: ${record.objective}`);
    lines.push("");
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

function indentFence(value) {
  return ["  ```text", ...value.trim().split("\n").slice(0, 80).map((line) => `  ${line}`), "  ```"].join("\n");
}

