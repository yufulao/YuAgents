#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR"

CONFIG_FILE="${OPENAGENTS_DEPLOY_CONFIG:-$SCRIPT_DIR/deploy.remote.env}"
if [ -f "$CONFIG_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$CONFIG_FILE"
  set +a
fi

: "${REMOTE_WEB_PORT:=${OA_REMOTE_WEB_PORT:-18080}}"
: "${REMOTE_WEB_BIND:=${OA_REMOTE_WEB_BIND:-127.0.0.1}}"
: "${PUBLIC_URL:=${OA_REMOTE_PUBLIC_URL:-http://localhost:${REMOTE_WEB_PORT}}}"
: "${LOCAL_CONTROL_API_URL:=${OA_LOCAL_CONTROL_API_URL:-http://host.docker.internal:8000}}"
: "${CONTROL_CHECK_URL:=${LOCAL_CONTROL_API_URL}}"
: "${DOCKER_HOST_GATEWAY:=}"

if [ -z "$DOCKER_HOST_GATEWAY" ] && command -v docker >/dev/null 2>&1; then
  DOCKER_HOST_GATEWAY="$(docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}' 2>/dev/null || true)"
fi
: "${DOCKER_HOST_GATEWAY:=127.0.0.1}"

case "$CONTROL_CHECK_URL" in
  http://host.docker.internal:*)
    CONTROL_CHECK_URL="http://${DOCKER_HOST_GATEWAY}:${CONTROL_CHECK_URL#http://host.docker.internal:}"
    ;;
  http://host.docker.internal/*)
    CONTROL_CHECK_URL="http://${DOCKER_HOST_GATEWAY}/${CONTROL_CHECK_URL#http://host.docker.internal/}"
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
echo "Config: ${CONFIG_FILE}"
echo "URL: ${PUBLIC_URL}"
echo "Bind: ${REMOTE_WEB_BIND}:${REMOTE_WEB_PORT}"
echo "Local control API from Docker: ${LOCAL_CONTROL_API_URL}"
echo "Docker host gateway: ${DOCKER_HOST_GATEWAY}"
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
if fetch_ok "${CONTROL_CHECK_URL%/}/v1/agent-catalog"; then
  CONTROL_READY=1
  echo "Local control API is reachable."
else
  CONTROL_READY=0
  echo "[WARN] Local control API is not reachable yet."
  echo "The remote relay will still start. Start the local reverse tunnel from"
  echo "the local machine with ..prod_connect.bat, then /v1 will become ready."
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

if [ "$CONTROL_READY" -eq 1 ] && ! fetch_ok "${PUBLIC_URL}/v1/agent-catalog"; then
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
if [ "$CONTROL_READY" -eq 0 ]; then
  echo "Waiting for the local reverse tunnel before workspace APIs can work."
fi
echo "To stop: docker compose -f docker-compose.prod.yml down"
