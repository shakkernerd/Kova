import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { artifactsDir } from "./paths.mjs";
import { renderPasteSummary } from "./report.mjs";

export async function bundleReport(reportPath, options = {}) {
  const sourceJsonPath = resolve(reportPath);
  const report = JSON.parse(await readFile(sourceJsonPath, "utf8"));
  const runId = report.runId;
  if (!runId) {
    throw new Error("report is missing runId");
  }

  const outputRoot = options.outputDir ? resolve(options.outputDir) : join(artifactsDir, "bundles");
  await mkdir(outputRoot, { recursive: true });

  const bundleName = `${sanitize(runId)}-bundle`;
  const outputPath = join(outputRoot, `${bundleName}.tar.gz`);
  const checksumPath = `${outputPath}.sha256`;
  const tmp = await mkdtemp(join(tmpdir(), "kova-artifact-bundle-"));
  const stage = join(tmp, bundleName);

  try {
    await mkdir(stage, { recursive: true });
    await cp(sourceJsonPath, join(stage, "report.json"));

    const markdownPath = siblingMarkdownPath(sourceJsonPath);
    const included = {
      reportJson: true,
      reportMarkdown: false,
      pasteSummary: true,
      runArtifacts: false
    };

    if (existsSync(markdownPath)) {
      await cp(markdownPath, join(stage, "report.md"));
      included.reportMarkdown = true;
    }

    await writeFile(join(stage, "paste-summary.txt"), renderPasteSummary(report), "utf8");

    const runArtifactsPath = join(artifactsDir, runId);
    if (existsSync(runArtifactsPath) && (await stat(runArtifactsPath)).isDirectory()) {
      await cp(runArtifactsPath, join(stage, "artifacts"), { recursive: true });
      included.runArtifacts = true;
    }

    const manifest = {
      schemaVersion: "kova.artifact.manifest.v1",
      generatedAt: new Date().toISOString(),
      runId,
      mode: report.mode ?? null,
      target: report.target ?? null,
      profile: report.profile ?? null,
      platform: report.platform ?? null,
      source: {
        reportJsonPath: sourceJsonPath,
        reportMarkdownPath: existsSync(markdownPath) ? markdownPath : null,
        runArtifactsPath: existsSync(runArtifactsPath) ? runArtifactsPath : null
      },
      included
    };
    await writeFile(join(stage, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const tar = spawnSync("tar", ["-czf", outputPath, "-C", tmp, bundleName], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    if (tar.status !== 0) {
      throw new Error(tar.stderr || tar.stdout || "tar failed");
    }

    const archive = await readFile(outputPath);
    const sha256 = createHash("sha256").update(archive).digest("hex");
    await writeFile(checksumPath, `${sha256}  ${basename(outputPath)}\n`, "utf8");

    return {
      schemaVersion: "kova.artifact.bundle.v1",
      generatedAt: new Date().toISOString(),
      runId,
      outputPath,
      checksumPath,
      sha256,
      bytes: archive.length,
      included
    };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

function siblingMarkdownPath(path) {
  const extension = extname(path);
  const base = extension ? basename(path, extension) : basename(path);
  return join(dirname(path), `${base}.md`);
}

function sanitize(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
