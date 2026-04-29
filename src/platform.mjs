import { arch, platform, release } from "node:os";

export function platformInfo() {
  return {
    os: platform(),
    arch: arch(),
    release: release(),
    node: process.version
  };
}

