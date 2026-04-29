import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
export const scenariosDir = join(repoRoot, "scenarios");
export const statesDir = join(repoRoot, "states");
export const profilesDir = join(repoRoot, "profiles");
export const reportsDir = join(repoRoot, "reports");
export const artifactsDir = join(repoRoot, "artifacts");
