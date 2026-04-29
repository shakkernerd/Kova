export function parseFlags(argv) {
  const flags = { _: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith("--")) {
      flags._.push(token);
      continue;
    }

    const [rawKey, inlineValue] = token.slice(2).split("=", 2);
    const key = rawKey.replaceAll("-", "_");

    if (inlineValue !== undefined) {
      flags[key] = inlineValue;
      continue;
    }

    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = true;
    }
  }

  return flags;
}

export function printHelp() {
  console.log(`Kova - OpenClaw runtime validation lab

Usage:
  kova doctor
  kova self-check [--json]
  kova plan [--scenario <id>] [--json]
  kova scenarios list [--json]
  kova scenarios show <id> [--json]
  kova states list [--json]
  kova states show <id> [--json]
  kova profiles list [--json]
  kova profiles show <id> [--json]
  kova matrix plan --profile <id> --target <selector> [--from <selector>] [--json]
  kova matrix run --profile <id> --target <selector> [--from <selector>] [--report-dir <path>] [--execute] [--keep-env] [--retain-on-failure] [--json]
  kova run --target <selector> [--from <selector>] [--scenario <id>] [--state <id>] [--report-dir <path>] [--execute] [--keep-env] [--retain-on-failure] [--json]
  kova cleanup envs [--execute] [--json]
  kova report summarize <report.json> [--json]
  kova report paste <report.json>

Selectors:
  npm:<version>              Published OpenClaw release
  channel:<name>             Published channel such as stable or beta
  runtime:<name>             Existing OCM runtime name
  local-build:<repo-path>    OpenClaw checkout to build as a release-shaped runtime

Notes:
  Kova uses OCM to create isolated OpenClaw envs and runtimes.
  Kova reports on OpenClaw behavior, not OCM behavior.
  run is dry-run/report-only unless --execute is passed.
`);
}

export function required(value, name) {
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export function resolveFromCwd(path) {
  if (path.startsWith("/")) {
    return path;
  }
  return `${process.cwd()}/${path}`;
}
