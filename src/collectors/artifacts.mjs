import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export const COLLECTOR_ARTIFACT_DIRS_SCHEMA = "kova.collectorArtifactDirs.v1";

export function collectorArtifactDirs(runArtifactDir) {
  return {
    schemaVersion: COLLECTOR_ARTIFACT_DIRS_SCHEMA,
    root: runArtifactDir,
    collectors: join(runArtifactDir, "collectors"),
    openclaw: join(runArtifactDir, "openclaw"),
    resourceSamples: join(runArtifactDir, "resource-samples"),
    nodeProfiles: join(runArtifactDir, "node-profiles"),
    diagnostics: join(runArtifactDir, "diagnostics"),
    heap: join(runArtifactDir, "heap"),
    diagnosticReports: join(runArtifactDir, "diagnostic-reports")
  };
}

export async function prepareCollectorArtifactDirs(runArtifactDir, options = {}) {
  const dirs = collectorArtifactDirs(runArtifactDir);
  const required = [
    dirs.root,
    dirs.collectors,
    dirs.openclaw,
    dirs.resourceSamples
  ];
  if (options.nodeProfile === true) {
    required.push(dirs.nodeProfiles);
  }
  if (options.deepProfile === true || options.profileOnFailure === true || options.heapSnapshot === true) {
    required.push(dirs.diagnostics, dirs.heap, dirs.diagnosticReports);
  }
  for (const dir of required) {
    await mkdir(dir, { recursive: true });
  }
  return dirs;
}
