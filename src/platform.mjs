import { arch, platform, release } from "node:os";

const KNOWN_OS_KEYS = new Set(["aix", "darwin", "freebsd", "linux", "openbsd", "sunos", "win32"]);
const KNOWN_ARCH_KEYS = new Set(["arm", "arm64", "ia32", "ppc64", "riscv64", "s390x", "x64"]);
const SPECIAL_PLATFORM_KEYS = new Set(["wsl2"]);

export function platformInfo() {
  return {
    os: platform(),
    arch: arch(),
    release: release(),
    node: process.version
  };
}

export function platformCoverageKeys(platform) {
  if (!platform) {
    return new Set();
  }
  const keys = [
    platform.os,
    platform.arch,
    `${platform.os}-${platform.arch}`
  ];
  if (platform.os === "linux" && /microsoft|wsl/i.test(String(platform.release ?? ""))) {
    keys.push("wsl2");
  }
  return new Set(keys.filter(Boolean));
}

export function isKnownPlatformCoverageKey(value) {
  if (typeof value !== "string" || value.length === 0) {
    return false;
  }
  if (SPECIAL_PLATFORM_KEYS.has(value) || KNOWN_OS_KEYS.has(value) || KNOWN_ARCH_KEYS.has(value)) {
    return true;
  }
  const [os, arch, extra] = value.split("-");
  return extra === undefined && KNOWN_OS_KEYS.has(os) && KNOWN_ARCH_KEYS.has(arch);
}
