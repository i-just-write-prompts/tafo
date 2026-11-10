#!/usr/bin/env bash
# Scan the net diff of a pull request or push with gitleaks.
# Prints the rule, file, and line. --redact removes the value.
# A value added and then removed is not in the head tree, so this job
# goes green after the removal. Full git history is not scanned.
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
elif [ "$event" = "push" ]; then
  head="${PUSH_SHA:?}"
  if [ "$head" = "0000000000000000000000000000000000000000" ]; then
    echo "secret-scan: branch deletion; nothing to scan"
    exit 0
  fi
  base="${PUSH_BEFORE:?}"
  if [ "$base" = "0000000000000000000000000000000000000000" ]; then
    GIT_TERMINAL_PROMPT=0 git fetch --no-tags "$public_url" \
      "refs/heads/${default_branch}"
    base="$(git rev-parse FETCH_HEAD)"
  fi
else
  echo "secret-scan: unsupported event ${event}" >&2
  exit 1
fi

ensure_commit "$base"
ensure_commit "$head"
merge_base="$(git merge-base "$base" "$head")"
ensure_commit "$merge_base"

dest="$(mktemp -d)"
outfile="$(mktemp)"
list="$(mktemp)"
cleanup() {
  rm -rf "$dest"
  rm -f "$outfile" "$list"
}
trap cleanup EXIT

if ! git diff -z --name-only --diff-filter=ACMRT "$merge_base" "$head" >"$list"; then
  echo "secret-scan: git diff failed" >&2
  exit 1
fi

count=0
while IFS= read -r -d '' file; do
  [ -n "$file" ] || continue
  rel="${file#./}"
  mkdir -p "$dest/$(dirname -- "$rel")"
  # Committed blob only. Redirected so the value never reaches the log.
  git show "$head:$rel" >"$dest/$rel"
  count=$((count + 1))
  printf 'secret-scan: file %s\n' "$rel"
done <"$list"
rm -f "$list"

if [ "$count" -eq 0 ]; then
  echo "secret-scan: no changed files in ${merge_base}..${head}"
  exit 0
fi

echo "secret-scan: scanning ${count} files in ${merge_base}..${head}"

args=(
  detect
  --redact
  --no-git
  --verbose
  --no-color
  --no-banner
  --log-level=info
  --source "$dest"
)
if [ -f .gitleaks.toml ]; then
  args+=(--config "$PWD/.gitleaks.toml")
fi

set +e
gitleaks "${args[@]}" >"$outfile" 2>&1
status=$?
set -e
sed "s#${dest}/##g" "$outfile"
exit "$status"
