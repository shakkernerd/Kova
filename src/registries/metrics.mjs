import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { metricsDir } from "../paths.mjs";
import { assertNoShapeErrors } from "./validate.mjs";

export async function loadMetrics() {
  const data = JSON.parse(await readFile(join(metricsDir, "known.json"), "utf8"));
  validateMetricsShape(data, "metrics/known.json");
  return data.metrics.map((id) => ({ id }));
}

export function validateMetricsShape(data, sourceName = "metrics") {
  const errors = [];
  if (data?.schemaVersion !== "kova.metrics.v1") {
    errors.push("schemaVersion must be kova.metrics.v1");
  }
  if (!Array.isArray(data?.metrics)) {
    errors.push("metrics must be an array");
  } else {
    const seen = new Set();
    for (const [index, metric] of data.metrics.entries()) {
      if (typeof metric !== "string" || !/^[A-Za-z][A-Za-z0-9]*$/.test(metric)) {
        errors.push(`metrics[${index}] must be a camelCase metric id`);
        continue;
      }
      if (seen.has(metric)) {
        errors.push(`duplicate metric id '${metric}'`);
      }
      seen.add(metric);
    }
  }
  assertNoShapeErrors(errors, sourceName);
}
