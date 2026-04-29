import { quoteShell } from "./commands.mjs";

export function resolveTarget(selector, role) {
  const [kind, ...rest] = selector.split(":");
  const value = rest.join(":");

  if (!value) {
    throw new Error(`${role} selector must use kind:value, got ${selector}`);
  }

  if (kind === "npm") {
    return {
      kind,
      value,
      startSelector: `--version ${quoteShell(value)}`,
      upgradeSelector: `--version ${quoteShell(value)}`
    };
  }

  if (kind === "channel") {
    return {
      kind,
      value,
      startSelector: `--channel ${quoteShell(value)}`,
      upgradeSelector: `--channel ${quoteShell(value)}`
    };
  }

  if (kind === "runtime") {
    return {
      kind,
      value,
      startSelector: `--runtime ${quoteShell(value)}`,
      upgradeSelector: `--runtime ${quoteShell(value)}`
    };
  }

  if (kind === "local-build") {
    const runtimeName = `kova-local-${Date.now()}`;
    return {
      kind,
      value,
      repoPath: value,
      runtimeName,
      startSelector: `--runtime ${quoteShell(runtimeName)}`,
      upgradeSelector: `--runtime ${quoteShell(runtimeName)}`
    };
  }

  throw new Error(`unsupported ${role} selector kind: ${kind}`);
}

