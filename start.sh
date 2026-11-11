#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [[ ! -d .venv ]]; then
  python3 -m venv .venv
fi
if ! .venv/bin/python -c 'import fastapi
parts=[]
for piece in fastapi.__version__.split("."):
    num=""
    for ch in piece:
        if ch.isdigit():
            num+=ch
        else:
            break
    if num: parts.append(int(num))
raise SystemExit(0 if tuple(parts[:3])>=(0,132,0) else 1)'; then
  .venv/bin/python -m pip install -U "fastapi>=0.132"
fi
.venv/bin/python -m pip install -e "./backend[dev]"
if [[ ! -d frontend/node_modules ]]; then
  (cd frontend && npm install)
fi
mkdir -p data
if [[ ! -f .env ]]; then
  cp .env.example .env
fi
.venv/bin/python -m tafo &
back=$!
(cd frontend && npm run dev) &
front=$!
trap 'kill "$back" "$front"' EXIT
wait
