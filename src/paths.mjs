import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
export const scenariosDir = join(repoRoot, "scenarios");
export const statesDir = join(repoRoot, "states");
export const profilesDir = join(repoRoot, "profiles");
export const surfacesDir = join(repoRoot, "surfaces");
export const processRolesDir = join(repoRoot, "process-roles");
export const metricsDir = join(repoRoot, "metrics");
export const kovaHome = resolveKovaHome();
export const credentialsDir = join(kovaHome, "credentials");
export const providersPath = join(credentialsDir, "providers.json");
export const liveEnvPath = join(credentialsDir, "live.env");
export const reportsDir = join(kovaHome, "reports");
export const artifactsDir = join(kovaHome, "artifacts");
export const baselinesDir = join(kovaHome, "baselines");

function resolveKovaHome() {
  if (process.env.KOVA_HOME) {
    return process.env.KOVA_HOME;
  }

  return join(homedir(), ".kova");
}
