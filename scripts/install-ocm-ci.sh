#!/usr/bin/env bash
set -euo pipefail

version="v0.2.41"
case "$(uname -s):$(uname -m)" in
  Linux:x86_64)
    asset="ocm-x86_64-unknown-linux-gnu.tar.gz"
    expected_sha256="e57dc642d70310f8bf19096c0fc41aab0325c8fab24b9ed0c6367c60a02b6198"
    ;;
  Darwin:arm64)
    asset="ocm-aarch64-apple-darwin.tar.gz"
    expected_sha256="99640a65ecc4d8175c76c4336b3b9b3a4c8f9877f40a4b6d9c4ce4c66330b83c"
    ;;
  *)
    echo "unsupported OCM CI platform: $(uname -s) $(uname -m)" >&2
    exit 1
    ;;
esac

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
archive_path="$tmp_dir/$asset"
curl -fsSL "https://github.com/openclaw/ocm/releases/download/$version/$asset" -o "$archive_path"
actual_sha256="$(shasum -a 256 "$archive_path" | awk '{print $1}')"
if [[ "$actual_sha256" != "$expected_sha256" ]]; then
  echo "OCM checksum mismatch for $asset" >&2
  exit 1
fi

tar -xzf "$archive_path" -C "$tmp_dir"
install -d "$HOME/.local/bin"
install -m 0755 "$tmp_dir/ocm" "$HOME/.local/bin/ocm"
