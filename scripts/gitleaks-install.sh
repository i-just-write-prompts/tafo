#!/usr/bin/env bash
# Install pinned gitleaks 8.30.1 and check the published archive digest.
# https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1
set -euo pipefail

dest="${1:?install directory required}"
version="8.30.1"

case "$(uname -m)" in
  x86_64 | amd64)
    asset="gitleaks_${version}_linux_x64.tar.gz"
    digest="551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"
    ;;
  aarch64 | arm64)
    asset="gitleaks_${version}_linux_arm64.tar.gz"
    digest="e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080"
    ;;
  *)
    echo "gitleaks-install: unsupported architecture $(uname -m)" >&2
    exit 1
    ;;
esac

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

url="https://github.com/gitleaks/gitleaks/releases/download/v${version}/${asset}"
curl --fail --silent --show-error --location --retry 3 --retry-delay 2 \
  "$url" -o "$tmp/$asset"
echo "${digest}  $tmp/$asset" | sha256sum -c -
tar -xzf "$tmp/$asset" -C "$tmp" gitleaks

mkdir -p "$dest"
install -m 0755 "$tmp/gitleaks" "$dest/gitleaks"
"$dest/gitleaks" version
