#!/usr/bin/env node
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
const version = packageJson.version;
const distDir = join(repoRoot, "dist");
const stageRoot = join(distDir, "stage");
const appName = `kova-${version}`;
const appDir = join(stageRoot, appName);
const archivePath = join(distDir, `${appName}.tar.gz`);
const checksumPath = `${archivePath}.sha256`;

await rm(stageRoot, { recursive: true, force: true });
await mkdir(appDir, { recursive: true });

for (const path of ["bin", "src", "scenarios", "states", "profiles"]) {
  await copyRequired(path);
}

for (const path of ["README.md", "LICENSE", "package.json"]) {
  await copyRequired(path);
}

await mkdir(join(appDir, "docs"), { recursive: true });
for (const path of ["docs/AGENT_USAGE.md", "docs/OCM_OPERATOR_INTEGRATION.md", "docs/REPORT_SCHEMA.md"]) {
  await copyRequired(path);
}

await rm(archivePath, { force: true });
const tar = spawnSync("tar", ["-czf", archivePath, "-C", stageRoot, appName], {
  cwd: repoRoot,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"]
});

if (tar.status !== 0) {
  throw new Error(tar.stderr || tar.stdout || "tar failed");
}

const archive = await readFile(archivePath);
const sha256 = createHash("sha256").update(archive).digest("hex");
await writeFile(checksumPath, `${sha256}  ${appName}.tar.gz\n`, "utf8");
await rm(stageRoot, { recursive: true, force: true });

console.log(JSON.stringify({
  schemaVersion: "kova.releaseArtifact.v1",
  version,
  archivePath,
  checksumPath,
  sha256,
  bytes: archive.length
}, null, 2));

async function copyRequired(path) {
  const source = join(repoRoot, path);
  if (!existsSync(source)) {
    throw new Error(`release input missing: ${path}`);
  }
  await cp(source, join(appDir, path), { recursive: true });
}
