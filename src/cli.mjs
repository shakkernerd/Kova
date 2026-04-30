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
  kova version [--json]
  kova --version
  kova setup [--ci|--non-interactive] [--auth <mock|api-key|env-only|external-cli|oauth|skip>] [--provider <id>] [--env-var <name>] [--value <secret>] [--external-cli <name>] [--json]
  kova setup auth [--provider <id>] [--method <mock|api-key|env-only|external-cli|oauth|skip>] [--env-var <name>] [--value <secret>] [--external-cli <name>] [--json]
  kova self-check [--json]
  kova plan [--scenario <id>] [--json]
  kova run --target <selector> [--from <selector>] [--scenario <id>] [--state <id>] [--auth <mock|live|skip>] [--repeat <n>] [--baseline [path]] [--save-baseline [path]] [--regression-thresholds <json>] [--report-dir <path>] [--health-samples <n>] [--readiness-interval-ms <n>] [--resource-sample-interval-ms <n>] [--deep-profile] [--node-profile] [--heap-snapshot] [--profile-on-failure] [--execute] [--keep-env] [--retain-on-failure] [--json]
  kova matrix plan --profile <id> --target <selector> [--from <selector>] [--include <filter>] [--exclude <filter>] [--parallel <n>] [--json]
  kova matrix run --profile <id> --target <selector> [--from <selector>] [--include <filter>] [--exclude <filter>] [--auth <mock|live|skip>] [--parallel <n>] [--repeat <n>] [--baseline [path]] [--save-baseline [path]] [--regression-thresholds <json>] [--fail-fast] [--gate] [--report-dir <path>] [--health-samples <n>] [--readiness-interval-ms <n>] [--resource-sample-interval-ms <n>] [--deep-profile] [--node-profile] [--heap-snapshot] [--profile-on-failure] [--execute] [--keep-env] [--retain-on-failure] [--json]
  kova report summarize <report.json> [--json]
  kova report paste <report.json>
  kova report compare <baseline.json> <current.json> [--thresholds <json>] [--fixer] [--json]
  kova report bundle <report.json> [--output-dir <path>] [--json]
  kova cleanup envs [--execute] [--json]

Selectors:
  npm:<version>              Published OpenClaw release
  channel:<name>             Published channel such as stable or beta
  runtime:<name>             Existing OCM runtime name
  local-build:<repo-path>    OpenClaw checkout to build as a release-shaped runtime

Matrix filters:
  scenario:<id>, state:<id>, tag:<tag>, or a bare scenario/state/tag value

Notes:
  Kova uses OCM to create isolated OpenClaw envs and runtimes.
  Kova reports on OpenClaw behavior, not OCM behavior.
  run is dry-run/report-only unless --execute is passed.
  --repeat records independent samples and computes aggregate performance stats.
  --auth defaults to mock so every disposable env has deliberate model auth unless a scenario opts out.
  setup provider/auth choices accept either numbers from the prompt or names such as openai, anthropic, env-only, api-key.
  --baseline compares executed aggregates against a Kova baseline store; without a path it uses the default store.
  --save-baseline writes executed aggregates into the selected baseline store.
  --deep-profile enables Node CPU/heap/trace profiling, OpenClaw timeline envs,
  heap snapshots, diagnostic reports, and denser resource sampling.
  setup includes auth. Use --non-interactive or --ci for scripts and agents.
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
