#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [[ ! -d .venv ]]; then
  python3 -m venv .venv
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
