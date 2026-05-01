import { ocmTargetSelector } from "./ocm/commands.mjs";

export function resolveTarget(selector, role) {
  const [kind, ...rest] = selector.split(":");
  const value = rest.join(":");

  if (!value) {
    throw new Error(`${role} selector must use kind:value, got ${selector}`);
  }

  if (kind === "npm") {
    const target = {
      kind,
      value
    };
    return withOcmSelectors(target);
  }

  if (kind === "channel") {
    const target = {
      kind,
      value
    };
    return withOcmSelectors(target);
  }

  if (kind === "runtime") {
    const target = {
      kind,
      value
    };
    return withOcmSelectors(target);
  }

  if (kind === "local-build") {
    const runtimeName = `kova-local-${Date.now()}`;
    const target = {
      kind,
      value,
      repoPath: value,
      runtimeName
    };
    return withOcmSelectors(target);
  }

  throw new Error(`unsupported ${role} selector kind: ${kind}`);
}

function withOcmSelectors(target) {
  return {
    ...target,
    startSelector: ocmTargetSelector(target, "start"),
    upgradeSelector: ocmTargetSelector(target, "upgrade")
  };
}
