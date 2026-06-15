#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT/workspace/backend"
FRONTEND_DIR="$ROOT/workspace/frontend"
RUN_DIR="$ROOT/.openagents-local"
BACKEND_VENV="$BACKEND_DIR/.venv"
BACKEND_PYTHON="$BACKEND_VENV/bin/python"
CONFIG_FILE="${OPENAGENTS_DEPLOY_CONFIG:-$ROOT/workspace/deploy.remote.env}"
BACKEND_LOG="$RUN_DIR/backend.log"
FRONTEND_LOG="$RUN_DIR/frontend.log"
BACKEND_PID="$RUN_DIR/backend.pid"
FRONTEND_PID="$RUN_DIR/frontend.pid"

if [[ -f "$CONFIG_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$CONFIG_FILE"
  set +a
fi

LOCAL_BACKEND_HOST="${OA_LOCAL_BACKEND_HOST:-127.0.0.1}"
LOCAL_BACKEND_BIND="${OA_LOCAL_BACKEND_BIND:-0.0.0.0}"
LOCAL_BACKEND_PORT="${OA_LOCAL_BACKEND_PORT:-8000}"
LOCAL_FRONTEND_HOST="${OA_LOCAL_FRONTEND_HOST:-localhost}"
LOCAL_FRONTEND_PORT="${OA_LOCAL_FRONTEND_PORT:-3001}"
LOCAL_BACKEND_URL="http://${LOCAL_BACKEND_HOST}:${LOCAL_BACKEND_PORT}"
LOCAL_FRONTEND_URL="http://${LOCAL_FRONTEND_HOST}:${LOCAL_FRONTEND_PORT}"

echo "OpenAgents local Web startup"
echo "Root: $ROOT"
echo "Config: $CONFIG_FILE"
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

show_log_tail() {
  local file="$1"
  if [[ ! -f "$file" ]]; then
    echo "  (missing log: $file)" >&2
    return 0
  fi
  echo >&2
  echo "----- Last 80 lines: $file -----" >&2
  tail -n 80 "$file" >&2 || true
  echo "----- End log -----" >&2
}

ensure_backend_python_env() {
  local requirements="$BACKEND_DIR/requirements.txt"
  if [[ ! -f "$requirements" ]]; then
    echo "[ERROR] Backend requirements file was not found: $requirements" >&2
    exit 1
  fi
  if [[ ! -x "$BACKEND_PYTHON" ]]; then
    echo "Creating backend Python virtual environment at $BACKEND_VENV..."
    python -m venv "$BACKEND_VENV"
  fi
  if ! "$BACKEND_PYTHON" -c "import fastapi, uvicorn, sqlalchemy" >/dev/null 2>&1; then
    echo "Installing backend Python dependencies..."
    "$BACKEND_PYTHON" -m pip install --upgrade pip
    "$BACKEND_PYTHON" -m pip install -r "$requirements"
  fi
}

ensure_frontend_dependencies() {
  if [[ ! -d "$FRONTEND_DIR/node_modules" ]]; then
    echo "Installing frontend npm dependencies..."
    (
      cd "$FRONTEND_DIR"
      if [[ -f package-lock.json ]]; then
        npm ci
      else
        npm install
      fi
    )
  fi
}

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
  local pid="${4:-}"
  for _ in $(seq 1 "$attempts"); do
    if python - "$url" <<'PY' >/dev/null 2>&1
import sys
from urllib.request import urlopen
urlopen(sys.argv[1], timeout=2).read(1)
PY
    then
      return 0
    fi
    if [[ -n "$pid" ]] && ! kill -0 "$pid" >/dev/null 2>&1; then
      echo "[ERROR] $label exited before becoming ready." >&2
      return 2
    fi
    sleep 1
  done
  echo "[ERROR] $label did not become ready: $url" >&2
  return 1
}

ensure_backend_python_env
ensure_frontend_dependencies

echo "Stopping existing local Web processes on ports ${LOCAL_BACKEND_PORT} and ${LOCAL_FRONTEND_PORT}..."
stop_pid_file "$BACKEND_PID"
stop_pid_file "$FRONTEND_PID"
stop_port "$LOCAL_BACKEND_PORT"
stop_port "$LOCAL_FRONTEND_PORT"
sleep 1

echo "Starting backend on $LOCAL_BACKEND_URL"
(
  cd "$BACKEND_DIR"
  export DATABASE_URL="sqlite:///./workspace_dev.db"
  export CORS_ORIGINS="*"
  export WORKSPACE_CREATION_ENABLED="true"
  export WORKSPACE_DIRECTORY_ENABLED="true"
  exec "$BACKEND_PYTHON" -m uvicorn app.main:app --host "$LOCAL_BACKEND_BIND" --port "$LOCAL_BACKEND_PORT"
) >"$BACKEND_LOG" 2>&1 &
echo "$!" > "$BACKEND_PID"

echo "Waiting for backend API..."
if ! wait_for_url "$LOCAL_BACKEND_URL/v1/workspaces" 90 "Backend" "$(cat "$BACKEND_PID")"; then
  show_log_tail "$BACKEND_LOG"
  exit 1
fi

echo "Starting frontend on $LOCAL_FRONTEND_URL"
(
  cd "$FRONTEND_DIR"
  unset NEXT_PUBLIC_API_URL
  export NEXT_PUBLIC_WORKSPACE_CREATION_ENABLED="true"
  export NEXT_PUBLIC_WORKSPACE_DIRECTORY_ENABLED="true"
  exec npm run dev
) >"$FRONTEND_LOG" 2>&1 &
echo "$!" > "$FRONTEND_PID"

echo "Waiting for frontend Web page..."
if ! wait_for_url "$LOCAL_FRONTEND_URL" 120 "Frontend" "$(cat "$FRONTEND_PID")"; then
  show_log_tail "$FRONTEND_LOG"
  exit 1
fi

echo
echo "OpenAgents local Web is ready."
echo "Backend log:  $BACKEND_LOG"
echo "Frontend log: $FRONTEND_LOG"
echo "$LOCAL_FRONTEND_URL"
echo

if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$LOCAL_FRONTEND_URL" >/dev/null 2>&1 || true
elif command -v open >/dev/null 2>&1; then
  open "$LOCAL_FRONTEND_URL" >/dev/null 2>&1 || true
fi
