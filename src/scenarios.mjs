import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { scenariosDir } from "./paths.mjs";

export async function loadScenarios(selectedId) {
  const names = await readdir(scenariosDir);
  const paths = names.filter((name) => name.endsWith(".json")).sort();
  const scenarios = [];

  for (const name of paths) {
    const raw = await readFile(join(scenariosDir, name), "utf8");
    scenarios.push(JSON.parse(raw));
  }

  const filtered = selectedId ? scenarios.filter((scenario) => scenario.id === selectedId) : scenarios;
  if (filtered.length === 0) {
    throw new Error(`no scenario found for ${selectedId}`);
  }
  return filtered;
}

export function validateScenarioRun(scenario, flags) {
  if (scenario.id === "upgrade-existing-user" && flags.execute === true && !flags.source_env) {
    throw new Error("upgrade-existing-user execution requires --source-env <env>");
  }
}

export function materializeCommands(commands, values) {
  return commands.map((command) =>
    command
      .replaceAll("{env}", values.env)
      .replaceAll("{target}", values.target)
      .replaceAll("{from}", values.from)
      .replaceAll("{sourceEnv}", values.sourceEnv)
      .replaceAll("{startSelector}", values.startSelector)
      .replaceAll("{upgradeSelector}", values.upgradeSelector)
      .replaceAll("{fromUpgradeSelector}", values.fromUpgradeSelector)
  );
}

