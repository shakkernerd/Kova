#!/usr/bin/env bash
set -euo pipefail

timestamp() {
  date '+%H:%M:%S'
}

log_step() {
  printf '[%s] %s\n' "$(timestamp)" "$*" >&2
}

run_step() {
  local description="$1"
  shift
  local started_at="$SECONDS"
  log_step "$description"
  "$@"
  log_step "done: ${description} ($((SECONDS - started_at))s)"
}

usage() {
  cat <<'EOF'
Update the Kova package version safely.

Usage:
  scripts/update-version.sh <version>

Examples:
  scripts/update-version.sh 0.2.0
  scripts/update-version.sh 1.0.0-beta.1
EOF
}

if [[ $# -ne 1 ]]; then
  usage >&2
  exit 1
fi

new_version="$1"
if [[ ! "$new_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
  echo "error: version must look like 1.2.3 or 1.0.0-beta.1" >&2
  exit 1
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/.." && pwd)"
cd "$repo_root"

current_version="$(node -p 'require("./package.json").version')"
if [[ -z "$current_version" ]]; then
  echo "error: could not read package version from package.json" >&2
  exit 1
fi

if [[ "$current_version" == "$new_version" ]]; then
  echo "Kova is already on ${new_version}"
  exit 0
fi

export KOVA_NEW_VERSION="$new_version"

log_step "Updating package.json from ${current_version} to ${new_version}"
node <<'EOF'
const fs = require("node:fs");
const path = "package.json";
const pkg = JSON.parse(fs.readFileSync(path, "utf8"));
pkg.version = process.env.KOVA_NEW_VERSION;
fs.writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
EOF

updated_version="$(node -p 'require("./package.json").version')"
if [[ "$updated_version" != "$new_version" ]]; then
  echo "error: package.json did not update cleanly" >&2
  exit 1
fi

run_step "Verifying version bump with npm run check" npm run check

echo "Updated Kova version: ${current_version} -> ${new_version}"
