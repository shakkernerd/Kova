#!/usr/bin/env bash
set -euo pipefail

REPO="shakkernerd/kova"
DEFAULT_PREFIX="${HOME}/.kova"
DEFAULT_BIN_DIR="${HOME}/.local/bin"
DEFAULT_OCM_INSTALL_URL="https://raw.githubusercontent.com/shakkernerd/ocm/main/install.sh"

usage() {
  cat <<'EOF'
Install Kova from GitHub release artifacts.

Usage:
  install.sh [--version <tag>] [--prefix <dir>] [--bin-dir <dir>] [--archive <path>]
             [--install-ocm] [--require-ocm] [--skip-ocm]

Options:
  --version <tag>   Release tag to install. Defaults to latest.
  --prefix <dir>    Kova install root. Defaults to ~/.kova.
  --bin-dir <dir>   Directory for the kova symlink. Defaults to ~/.local/bin.
  --archive <path>  Install from a local release archive, useful for testing.
  --install-ocm     Install OCM if it is missing.
  --require-ocm     Fail if OCM is missing after optional installation.
  --skip-ocm        Do not check OCM.
  --help            Show this help.

Environment:
  KOVA_VERSION       Same as --version.
  KOVA_PREFIX        Same as --prefix.
  KOVA_BIN_DIR       Same as --bin-dir.
  KOVA_ARCHIVE       Same as --archive.
  KOVA_INSTALL_OCM   Set to 1 to install OCM when missing.
  KOVA_REQUIRE_OCM   Set to 1 to fail when OCM is missing.
  KOVA_SKIP_OCM      Set to 1 to skip OCM checks.
  OCM_INSTALL_URL    OCM installer URL.
EOF
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "error: required command not found: $1" >&2
    exit 1
  fi
}

download_url_for() {
  local version="$1"
  if [[ "$version" == "latest" ]]; then
    printf 'https://github.com/%s/releases/latest/download/kova.tar.gz\n' "$REPO"
  else
    printf 'https://github.com/%s/releases/download/%s/kova.tar.gz\n' "$REPO" "$version"
  fi
}

checksum_url_for() {
  printf '%s.sha256\n' "$(download_url_for "$1")"
}

truthy() {
  [[ "${1:-}" == "1" || "${1:-}" == "true" || "${1:-}" == "yes" ]]
}

verify_checksum() {
  local archive="$1"
  local checksum_file="$2"
  local expected actual

  expected="$(awk '{print $1}' "$checksum_file")"
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$archive" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$archive" | awk '{print $1}')"
  else
    echo "warning: sha256sum/shasum not found; skipping checksum verification" >&2
    return 0
  fi

  if [[ "$expected" != "$actual" ]]; then
    echo "error: checksum mismatch for ${archive}" >&2
    echo "expected: ${expected}" >&2
    echo "actual:   ${actual}" >&2
    exit 1
  fi
}

version="${KOVA_VERSION:-latest}"
prefix="${KOVA_PREFIX:-$DEFAULT_PREFIX}"
bin_dir="${KOVA_BIN_DIR:-$DEFAULT_BIN_DIR}"
archive="${KOVA_ARCHIVE:-}"
install_ocm="${KOVA_INSTALL_OCM:-0}"
require_ocm="${KOVA_REQUIRE_OCM:-0}"
skip_ocm="${KOVA_SKIP_OCM:-0}"
ocm_install_url="${OCM_INSTALL_URL:-$DEFAULT_OCM_INSTALL_URL}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      shift
      [[ $# -gt 0 ]] || { echo "error: --version requires a value" >&2; exit 1; }
      version="$1"
      ;;
    --prefix)
      shift
      [[ $# -gt 0 ]] || { echo "error: --prefix requires a value" >&2; exit 1; }
      prefix="$1"
      ;;
    --bin-dir)
      shift
      [[ $# -gt 0 ]] || { echo "error: --bin-dir requires a value" >&2; exit 1; }
      bin_dir="$1"
      ;;
    --archive)
      shift
      [[ $# -gt 0 ]] || { echo "error: --archive requires a value" >&2; exit 1; }
      archive="$1"
      ;;
    --install-ocm)
      install_ocm="1"
      ;;
    --require-ocm)
      require_ocm="1"
      ;;
    --skip-ocm)
      skip_ocm="1"
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

require_command tar
require_command mktemp
require_command node

tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

if [[ -z "$archive" ]]; then
  require_command curl
  url="$(download_url_for "$version")"
  archive="${tmp_dir}/kova.tar.gz"
  checksum_file="${tmp_dir}/kova.tar.gz.sha256"

  echo "Downloading ${url}"
  curl -fsSL "$url" -o "$archive"
  if curl -fsSL "$(checksum_url_for "$version")" -o "$checksum_file"; then
    verify_checksum "$archive" "$checksum_file"
  else
    echo "warning: checksum file unavailable; continuing without checksum verification" >&2
  fi
else
  if [[ ! -f "$archive" ]]; then
    echo "error: archive not found: ${archive}" >&2
    exit 1
  fi
  checksum_file="${archive}.sha256"
  if [[ -f "$checksum_file" ]]; then
    verify_checksum "$archive" "$checksum_file"
  fi
fi

extract_dir="${tmp_dir}/extract"
mkdir -p "$extract_dir"
tar -xzf "$archive" -C "$extract_dir"

app_source="$(find "$extract_dir" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
if [[ -z "$app_source" || ! -f "${app_source}/bin/kova.mjs" ]]; then
  echo "error: release archive did not contain bin/kova.mjs" >&2
  exit 1
fi

if ! truthy "$skip_ocm"; then
  if command -v ocm >/dev/null 2>&1; then
    :
  elif truthy "$install_ocm"; then
    require_command curl
    echo "OCM missing; installing via ${ocm_install_url}"
    curl -fsSL "$ocm_install_url" | bash
    export PATH="${HOME}/.local/bin:${PATH}"
  elif truthy "$require_ocm"; then
    echo "error: ocm is required but was not found on PATH" >&2
    echo "rerun with KOVA_INSTALL_OCM=1 or install ocm first" >&2
    exit 1
  else
    echo "warning: ocm was not found on PATH; install OCM before running real Kova scenarios" >&2
    echo "rerun with KOVA_INSTALL_OCM=1 to install OCM automatically" >&2
  fi
fi

if command -v ocm >/dev/null 2>&1 && ! truthy "$skip_ocm"; then
  KOVA_HOME="$prefix" node "${app_source}/bin/kova.mjs" setup --ci --json >/dev/null
else
  KOVA_HOME="$prefix" node "${app_source}/bin/kova.mjs" help >/dev/null
fi

mkdir -p "$prefix" "${prefix}/bin" "$bin_dir"
rm -rf "${prefix}/app"
mv "$app_source" "${prefix}/app"

launcher="${prefix}/bin/kova"
cat > "$launcher" <<EOF
#!/usr/bin/env bash
export KOVA_HOME="${prefix}"
exec node "${prefix}/app/bin/kova.mjs" "\$@"
EOF
chmod 0755 "$launcher"

ln -sfn "$launcher" "${bin_dir}/kova"

echo "Installed kova to ${prefix}/app"
echo "Linked kova at ${bin_dir}/kova"
case ":${PATH}:" in
  *":${bin_dir}:"*) ;;
  *)
    echo "Add ${bin_dir} to your PATH to run kova from any shell."
    ;;
esac
echo ""
echo "Next:"
echo "  kova version"
echo "  kova setup"
echo "  kova self-check"
echo "  kova matrix plan --profile smoke --target runtime:stable"
