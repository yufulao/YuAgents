#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT/workspace/backend"
FRONTEND_DIR="$ROOT/workspace/frontend"
RUN_DIR="$ROOT/.openagents-local"
BACKEND_LOG="$RUN_DIR/backend.log"
FRONTEND_LOG="$RUN_DIR/frontend.log"
BACKEND_PID="$RUN_DIR/backend.pid"
FRONTEND_PID="$RUN_DIR/frontend.pid"

echo "OpenAgents local Web startup"
echo "Root: $ROOT"
echo

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[ERROR] $1 was not found in PATH." >&2
    exit 1
  fi
}

require_cmd python
require_cmd node
require_cmd npm

if [[ ! -f "$BACKEND_DIR/app/main.py" ]]; then
  echo "[ERROR] Workspace backend was not found: $BACKEND_DIR/app/main.py" >&2
  exit 1
fi

if [[ ! -f "$FRONTEND_DIR/package.json" ]]; then
  echo "[ERROR] Workspace frontend was not found: $FRONTEND_DIR/package.json" >&2
  exit 1
fi

mkdir -p "$RUN_DIR"

stop_pid_file() {
  local file="$1"
  if [[ -f "$file" ]]; then
    local pid
    pid="$(cat "$file" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
      kill "$pid" >/dev/null 2>&1 || true
    fi
    rm -f "$file"
  fi
}

stop_port() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -ti "tcp:$port" -sTCP:LISTEN | xargs -r kill >/dev/null 2>&1 || true
  elif command -v fuser >/dev/null 2>&1; then
    fuser -k "${port}/tcp" >/dev/null 2>&1 || true
  fi
}

wait_for_url() {
  local url="$1"
  local attempts="$2"
  local label="$3"
  for _ in $(seq 1 "$attempts"); do
    if python - "$url" <<'PY' >/dev/null 2>&1
import sys
from urllib.request import urlopen
urlopen(sys.argv[1], timeout=2).read(1)
PY
    then
      return 0
    fi
    sleep 1
  done
  echo "[ERROR] $label did not become ready: $url" >&2
  return 1
}

echo "Stopping existing local Web processes on ports 8000 and 3001..."
stop_pid_file "$BACKEND_PID"
stop_pid_file "$FRONTEND_PID"
stop_port 8000
stop_port 3001
sleep 1

echo "Starting backend on http://127.0.0.1:8000"
(
  cd "$BACKEND_DIR"
  export DATABASE_URL="sqlite:///./workspace_dev.db"
  export CORS_ORIGINS="*"
  export WORKSPACE_CREATION_ENABLED="true"
  export WORKSPACE_DIRECTORY_ENABLED="true"
  exec python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
) >"$BACKEND_LOG" 2>&1 &
echo "$!" > "$BACKEND_PID"

echo "Waiting for backend API..."
if ! wait_for_url "http://127.0.0.1:8000/v1/workspaces" 60 "Backend"; then
  echo "Check log: $BACKEND_LOG" >&2
  exit 1
fi

echo "Starting frontend on http://localhost:3001"
(
  cd "$FRONTEND_DIR"
  unset NEXT_PUBLIC_API_URL
  export NEXT_PUBLIC_WORKSPACE_CREATION_ENABLED="true"
  export NEXT_PUBLIC_WORKSPACE_DIRECTORY_ENABLED="true"
  exec npm run dev
) >"$FRONTEND_LOG" 2>&1 &
echo "$!" > "$FRONTEND_PID"

echo "Waiting for frontend Web page..."
if ! wait_for_url "http://localhost:3001" 90 "Frontend"; then
  echo "Check log: $FRONTEND_LOG" >&2
  exit 1
fi

echo
echo "OpenAgents local Web is ready."
echo "Backend log:  $BACKEND_LOG"
echo "Frontend log: $FRONTEND_LOG"
echo "http://localhost:3001"
echo

if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "http://localhost:3001" >/dev/null 2>&1 || true
elif command -v open >/dev/null 2>&1; then
  open "http://localhost:3001" >/dev/null 2>&1 || true
fi
