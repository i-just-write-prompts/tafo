#!/usr/bin/env bash
# Scan every commit in a pull request or push with gitleaks.
# A secret added in one commit and deleted in a later one still fails.
# --redact prints the rule, file, and line, never the value.
set -euo pipefail

cd "$(dirname "$0")/.."

event="${EVENT_NAME:?}"
default_branch="${DEFAULT_BRANCH:-main}"
repo="${GITHUB_REPOSITORY:?}"
public_url="https://github.com/${repo}.git"

is_sha() {
  [[ "$1" =~ ^[0-9a-fA-F]{40}$ ]]
}

ensure_commit() {
  local sha="$1"
  if ! is_sha "$sha"; then
    echo "secret-scan: not a commit sha" >&2
    exit 1
  fi
  if git cat-file -e "${sha}^{commit}" 2>/dev/null; then
    return 0
  fi
  GIT_TERMINAL_PROMPT=0 git fetch --no-tags "$public_url" "$sha"
  git cat-file -e "${sha}^{commit}" >/dev/null
}

if [ "$event" = "pull_request" ]; then
  base="${PR_BASE:?}"
  head="${PR_HEAD:?}"
  ensure_commit "$base"
  ensure_commit "$head"
  # Commits on the pull request since it diverged from the base.
  left="$(git merge-base "$base" "$head")"
  ensure_commit "$left"
elif [ "$event" = "push" ]; then
  head="${PUSH_SHA:?}"
  if [ "$head" = "0000000000000000000000000000000000000000" ]; then
    echo "secret-scan: branch deletion; nothing to scan"
    exit 0
  fi
  before="${PUSH_BEFORE:?}"
  if [ "$before" = "0000000000000000000000000000000000000000" ]; then
    # New branch. Scan commits that are not already on the default branch.
    GIT_TERMINAL_PROMPT=0 git fetch --no-tags "$public_url" \
      "refs/heads/${default_branch}"
    ensure_commit "$head"
    left="$(git merge-base FETCH_HEAD "$head")"
    ensure_commit "$left"
  else
    # before..after, including a secret added and deleted in the same push.
    left="$before"
    ensure_commit "$left"
    ensure_commit "$head"
  fi
else
  echo "secret-scan: unsupported event ${event}" >&2
  exit 1
fi

range="${left}..${head}"
count="$(git rev-list --count "$range")"
if [ "$count" -eq 0 ]; then
  echo "secret-scan: no commits in ${range}"
  exit 0
fi

echo "secret-scan: scanning ${count} commits in ${range}"

args=(
  --redact
  --verbose
  --no-color
  --no-banner
  --log-level=info
)
if [ -f .gitleaks.toml ]; then
  args+=(--config "$PWD/.gitleaks.toml")
fi
args+=(git --log-opts="${range}" .)

outfile="$(mktemp)"
cleanup() {
  rm -f "$outfile"
}
trap cleanup EXIT

set +e
GIT_TERMINAL_PROMPT=0 gitleaks "${args[@]}" >"$outfile" 2>&1
status=$?
set -e
cat "$outfile"
exit "$status"
