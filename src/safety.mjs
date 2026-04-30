export function assertSafeScenarioCommand(command, context, envName) {
  const trimmed = String(command ?? "").trim();
  for (const rule of mutationRules()) {
    const value = extractCommandTarget(trimmed, rule);
    if (value === null) {
      continue;
    }
    if (rule.allowSourceClone && value === context.sourceEnv) {
      continue;
    }
    assertKovaEnvName(value, `${rule.label} target`);
  }

  const atEnv = extractAtEnvTarget(trimmed);
  if (atEnv !== null) {
    assertKovaEnvName(atEnv, "ocm @ target");
  }

  if (trimmed.includes(envName) && !isKovaEnvName(envName)) {
    throw new Error(`unsafe Kova env name ${JSON.stringify(envName)}; generated envs must start with kova-`);
  }
}

export function assertKovaEnvName(value, label = "env") {
  if (!isKovaEnvName(value)) {
    throw new Error(`refusing to mutate non-Kova ${label}: ${JSON.stringify(value)}`);
  }
}

export function isKovaEnvName(value) {
  return /^kova-[a-z0-9][a-z0-9-]*$/i.test(String(value ?? ""));
}

function mutationRules() {
  const token = "((?:'[^']*(?:'\\\\''[^']*)*')|(?:\"[^\"]*\")|\\S+)";
  return [
    { pattern: new RegExp(`^ocm\\s+start\\s+${token}(?:\\s|$)`), label: "ocm start" },
    { pattern: new RegExp(`^ocm\\s+upgrade\\s+${token}(?:\\s|$)`), label: "ocm upgrade" },
    { pattern: new RegExp(`^ocm\\s+logs\\s+${token}(?:\\s|$)`), label: "ocm logs" },
    { pattern: new RegExp(`^ocm\\s+service\\s+(?:status|start|stop|restart)\\s+${token}(?:\\s|$)`), label: "ocm service" },
    { pattern: new RegExp(`^ocm\\s+env\\s+(?:destroy|exec|run|use)\\s+${token}(?:\\s|$)`), label: "ocm env" },
    { pattern: new RegExp(`^ocm\\s+env\\s+clone\\s+${token}(?:\\s|$)`), label: "ocm env clone source", allowSourceClone: true },
    { pattern: new RegExp(`^ocm\\s+env\\s+clone\\s+${token}\\s+${token}(?:\\s|$)`), label: "ocm env clone destination", group: 2 }
  ];
}

function extractAtEnvTarget(command) {
  const match = command.match(/^ocm\s+@((?:'[^']*(?:'\\''[^']*)*')|(?:"[^"]*")|\S+)(?:\s|$)/);
  return match ? unquoteShellToken(match[1]) : null;
}

function extractCommandTarget(command, rule) {
  const match = command.match(rule.pattern);
  return match ? unquoteShellToken(match[rule.group ?? 1]) : null;
}

function unquoteShellToken(value) {
  const text = String(value ?? "").trim();
  if ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"'))) {
    return text.slice(1, -1).replaceAll("'\\''", "'");
  }
  return text;
}
