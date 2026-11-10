#!/usr/bin/env bash
# Download one workflow run's job logs and scan them with gitleaks.
# The archive is never echoed, never uploaded, and deleted before exit.
set -euo pipefail

cd "$(dirname "$0")/.."

event="${EVENT_NAME:?}"
repo="${GITHUB_REPOSITORY:?}"

if [ "$event" = "workflow_dispatch" ]; then
  run_id="${INPUT_RUN_ID:-}"
else
  run_id="${WORKFLOW_RUN_ID:-}"
fi

if ! [[ "$run_id" =~ ^[0-9]+$ ]]; then
  echo "secret-scan-logs: run id must be digits" >&2
  exit 1
fi
if ! [[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  echo "secret-scan-logs: unexpected repository name" >&2
  exit 1
fi

tmp="$(mktemp -d)"
outfile="$(mktemp)"
cleanup() {
  rm -rf "$tmp"
  rm -f "$outfile"
}
trap cleanup EXIT

echo "secret-scan-logs: downloading logs for run ${run_id}"

ok=0
for attempt in 1 2 3; do
  if gh api \
    -H "Accept: application/vnd.github+json" \
    "/repos/${repo}/actions/runs/${run_id}/logs" >"$tmp/logs.zip"; then
    if python3 - "$tmp/logs.zip" <<'PY'
import sys
import zipfile
sys.exit(0 if zipfile.is_zipfile(sys.argv[1]) else 1)
PY
    then
      ok=1
      break
    fi
  fi
  rm -f "$tmp/logs.zip"
  echo "secret-scan-logs: log download not ready (attempt ${attempt}); body discarded"
  sleep $((attempt * 5))
done

if [ "$ok" -ne 1 ]; then
  echo "secret-scan-logs: could not download logs for run ${run_id}" >&2
  exit 1
fi

mkdir -p "$tmp/logs"
python3 - "$tmp/logs.zip" "$tmp/logs" <<'PY'
import sys
import zipfile
from pathlib import Path

zip_path = sys.argv[1]
dest = Path(sys.argv[2]).resolve()
dest.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(zip_path) as archive:
    for info in archive.infolist():
        parts = Path(info.filename).parts
        if info.filename.startswith("/") or ".." in parts:
            sys.exit("secret-scan-logs: zip entry escaped the log directory")
        target = (dest / info.filename).resolve()
        if target != dest and not str(target).startswith(str(dest) + "/"):
            sys.exit("secret-scan-logs: zip entry escaped the log directory")
    archive.extractall(dest)
PY
rm -f "$tmp/logs.zip"

file_count="$(find "$tmp/logs" -type f -print | wc -l | tr -d ' ')"
echo "secret-scan-logs: extracted ${file_count} log files"
if [ "$file_count" -eq 0 ]; then
  echo "secret-scan-logs: archive had no files" >&2
  exit 1
fi

args=(
  detect
  --redact
  --no-git
  --verbose
  --no-color
  --no-banner
  --log-level=info
  --source "$tmp/logs"
)
if [ -f .gitleaks.toml ]; then
  args+=(--config "$PWD/.gitleaks.toml")
fi

set +e
gitleaks "${args[@]}" >"$outfile" 2>&1
status=$?
set -e
sed "s#${tmp}/##g" "$outfile"
exit "$status"
