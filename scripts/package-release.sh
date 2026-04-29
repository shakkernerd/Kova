#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Package Kova into a GitHub release archive.

Usage:
  scripts/package-release.sh [--output-dir <dir>]
EOF
}

output_dir="dist"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output-dir)
      shift
      [[ $# -gt 0 ]] || { echo "error: --output-dir requires a value" >&2; exit 1; }
      output_dir="$1"
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/.." && pwd)"
cd "$repo_root"

node scripts/build-release.mjs --output-dir "$output_dir"
