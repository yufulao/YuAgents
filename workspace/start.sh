#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR"

: "${REMOTE_WEB_PORT:=18080}"
: "${REMOTE_WEB_BIND:=127.0.0.1}"
: "${PUBLIC_URL:=http://localhost:${REMOTE_WEB_PORT}}"
: "${LOCAL_CONTROL_API_URL:=http://host.docker.internal:8000}"
: "${CONTROL_CHECK_URL:=${LOCAL_CONTROL_API_URL}}"

case "$CONTROL_CHECK_URL" in
  http://host.docker.internal:*)
    CONTROL_CHECK_URL="http://127.0.0.1:${CONTROL_CHECK_URL##*:}"
    ;;
  http://host.docker.internal/*)
    CONTROL_CHECK_URL="http://127.0.0.1/${CONTROL_CHECK_URL#http://host.docker.internal/}"
    ;;
esac

export REMOTE_WEB_PORT
export REMOTE_WEB_BIND
export LOCAL_CONTROL_API_URL
export WORKSPACE_CREATION_ENABLED=false
export WORKSPACE_DIRECTORY_ENABLED=false
export NEXT_PUBLIC_WORKSPACE_CREATION_ENABLED=false
export NEXT_PUBLIC_WORKSPACE_DIRECTORY_ENABLED=false
unset API_URL

if ! docker compose version >/dev/null 2>&1; then
  echo 'Docker Compose was not found. Install Docker and make sure "docker compose" works.' >&2
  exit 1
fi

echo "Starting OpenAgents prod-style local stack..."
echo "URL: ${PUBLIC_URL}"
echo "Bind: ${REMOTE_WEB_BIND}:${REMOTE_WEB_PORT}"
echo "Local control API from Docker: ${LOCAL_CONTROL_API_URL}"
echo "Local control API preflight from host: ${CONTROL_CHECK_URL}"
echo "Workspace creation: disabled"
echo "Workspace directory: disabled"
echo "Workspace authority: local control plane"

fetch_ok() {
  url="$1"
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time 3 "$url" >/dev/null
  elif command -v wget >/dev/null 2>&1; then
    wget -q -T 3 -O /dev/null "$url"
  else
    echo 'curl or wget is required for readiness checks.' >&2
    return 1
  fi
}

echo
echo "Checking local control plane at ${CONTROL_CHECK_URL} ..."
if ! fetch_ok "${CONTROL_CHECK_URL%/}/v1/agent-catalog"; then
  echo "[ERROR] Local control plane is not reachable from the server host at ${CONTROL_CHECK_URL}." >&2
  echo "Start the local control plane first, or create an SSH reverse tunnel to this server." >&2
  echo "Example from your local machine:" >&2
  echo "  ssh -N -R 8000:127.0.0.1:8000 root@YOUR_SERVER" >&2
  echo "Then rerun with:" >&2
  echo "  LOCAL_CONTROL_API_URL=http://host.docker.internal:8000 bash start.sh" >&2
  echo "If your tunnel listens on a different server port, set both LOCAL_CONTROL_API_URL and CONTROL_CHECK_URL." >&2
  exit 1
fi

echo
echo "Running: docker compose -f docker-compose.prod.yml up -d --build --remove-orphans --force-recreate"
docker compose -f docker-compose.prod.yml up -d --build --remove-orphans --force-recreate

echo
echo "Waiting for remote relay at ${PUBLIC_URL} ..."
i=0
while [ "$i" -lt 60 ]; do
  if fetch_ok "${PUBLIC_URL}/relay-health"; then
    break
  fi
  i=$((i + 1))
  sleep 1
done

if [ "$i" -ge 60 ]; then
  echo "[ERROR] Remote relay did not become ready at ${PUBLIC_URL}." >&2
  echo "Check Docker logs with: docker compose -f docker-compose.prod.yml logs" >&2
  exit 1
fi

if ! fetch_ok "${PUBLIC_URL}/v1/agent-catalog"; then
  echo "[ERROR] Remote relay is running, but /v1 cannot reach the local control API." >&2
  echo "Upstream configured for nginx: ${LOCAL_CONTROL_API_URL}" >&2
  echo "Host preflight URL: ${CONTROL_CHECK_URL}" >&2
  echo "Check Docker logs with: docker compose -f docker-compose.prod.yml logs nginx" >&2
  exit 1
fi

echo
echo "OpenAgents is running at ${PUBLIC_URL}"
echo "Use an existing workspace slug/name and token/password."
echo "The server forwards /v1 requests to the local control plane; it does not store workspace authority."
echo "To stop: docker compose -f docker-compose.prod.yml down"
