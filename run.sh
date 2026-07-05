#!/usr/bin/env bash
# Durin launcher: sets up the venv, .env, and frontend build, then starts
# the server. Usage: ./run.sh [--build]   (--build forces a frontend rebuild)
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v python3 >/dev/null; then
  echo "python3 is required" >&2
  exit 1
fi
if ! command -v npm >/dev/null; then
  echo "npm (node) is required" >&2
  exit 1
fi

# --- python env ---------------------------------------------------------
if [ ! -d .venv ]; then
  echo "Creating Python venv…"
  python3 -m venv .venv
fi
.venv/bin/pip install -q -r backend/requirements.txt

# --- .env ---------------------------------------------------------------
if [ ! -f .env ]; then
  echo "Creating .env from .env.example…"
  cp .env.example .env
fi
if ! grep -q '^SECRET_KEY=..*' .env; then
  echo "Generating SECRET_KEY…"
  KEY="$(.venv/bin/python -c 'import secrets; print(secrets.token_urlsafe(48))')"
  # Replace the empty SECRET_KEY= line in place.
  .venv/bin/python - "$KEY" <<'EOF'
import re, sys
key = sys.argv[1]
path = ".env"
text = open(path).read()
text, n = re.subn(r"(?m)^SECRET_KEY=$", f"SECRET_KEY={key}", text, count=1)
if n == 0:
    text += f"\nSECRET_KEY={key}\n"
open(path, "w").write(text)
EOF
fi

# --- frontend -----------------------------------------------------------
if [ ! -d frontend/node_modules ]; then
  echo "Installing frontend dependencies…"
  (cd frontend && npm install --no-fund --no-audit)
fi
if [ ! -f frontend/dist/index.html ] || [ "${1:-}" = "--build" ]; then
  echo "Building frontend…"
  (cd frontend && npm run build)
fi

# --- run ----------------------------------------------------------------
mkdir -p data
export PYTHONPATH="$PWD/backend${PYTHONPATH:+:$PYTHONPATH}"
# Resolve the port exactly the way the app will (env var beats .env).
PORT_VALUE="$(.venv/bin/python -c 'from app.config import settings; print(settings.port)')"
echo
echo "Starting Durin on http://localhost:${PORT_VALUE}"
exec .venv/bin/python -m app
