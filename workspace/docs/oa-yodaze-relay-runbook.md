# oa.yodaze.com Remote Relay Runbook

This flow keeps OpenAgents local-first:

- Local Windows machine: authoritative control plane, workspace DB, agents.
- Remote Linux server: public Web entry and HTTP relay only.
- SSH reverse tunnel: exposes local `127.0.0.1:8000` to the server.

Server defaults:

- Domain: `oa.yodaze.com`
- Server IP: `159.75.188.203`
- SSH port: `22222`
- Remote directory: `/opt/openagents`
- Remote relay container port on server: `127.0.0.1:18080`

## First Deploy Or Update Server Files

From the repository root on the local Windows machine:

```bat
deploy-oa-yodaze.bat
```

This uploads the remote relay files to `/opt/openagents`, ensures Docker is
available, and configures host nginx so `http://oa.yodaze.com` proxies to
`127.0.0.1:18080`.

The deploy archive is intentionally small. It is generated with `git archive`
from tracked source files only:

- `workspace/docker-compose.prod.yml`
- `workspace/nginx.conf.template`
- `workspace/start.sh`
- `workspace/frontend`

It does not upload local runtime state or generated files such as `node_modules`,
`.next`, logs, screenshots, exports, SQLite DBs, `.env` files, or root-level
helper scripts. Docker installs frontend dependencies again on the server during
`docker compose up --build` through the frontend Dockerfile's `npm ci` step.

## Package Only

If you only want a 7z package to upload manually:

```bat
package-oa-yodaze.bat
```

This requires 7-Zip on the local machine. The script checks `PATH` plus common
install locations such as `C:\Program Files\7-Zip\7z.exe`.

The package is written to `dist\openagents-oa-yodaze-relay-YYYYMMDD-HHMMSS.7z`.
It uses the same tracked-file whitelist as the deploy script, so it does not
include local environments, generated builds, `node_modules`, `.next`, exports,
logs, SQLite DBs, or untracked files.

After uploading it to the server, extract it under `/opt/openagents` so the
server has:

```text
/opt/openagents/workspace/docker-compose.prod.yml
/opt/openagents/workspace/nginx.conf.template
/opt/openagents/workspace/start.sh
/opt/openagents/workspace/frontend/...
```

The underlying command is:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File workspace\scripts\deploy-remote-relay.ps1 -InstallDocker -ConfigureNginx
```

If SSH rejects the reverse tunnel bind later, set this on the server:

```text
GatewayPorts clientspecified
```

Then reload sshd:

```sh
sudo systemctl reload sshd || sudo systemctl reload ssh
```

## Daily Start

From the repository root on the local Windows machine:

```bat
connect-oa-yodaze.bat
```

This does all runtime work:

1. Starts local OpenAgents Web/control plane with `start.bat`.
2. Waits for local API `http://127.0.0.1:8000/v1/agent-catalog`.
3. Stops any stale server listener on the tunnel port.
4. Opens an SSH reverse tunnel from the server Docker gateway to local API.
5. Starts the remote Docker relay on the server.
6. Opens `http://oa.yodaze.com`.

Keep the PowerShell window open. Closing it stops the tunnel, and the remote Web
will show that it cannot reach the local control API.

## Manual Commands

Deploy/update files:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File workspace\scripts\deploy-remote-relay.ps1 `
  -SshHost 159.75.188.203 `
  -SshPort 22222 `
  -User root `
  -RemoteDir /opt/openagents `
  -Domain oa.yodaze.com `
  -ConfigureNginx
```

Start local control plane, tunnel, and remote relay:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File workspace\scripts\connect-remote-relay.ps1 `
  -SshHost 159.75.188.203 `
  -SshPort 22222 `
  -User root `
  -RemoteDir /opt/openagents `
  -Domain oa.yodaze.com `
  -StartLocal
```

If local Web is already running, omit `-StartLocal`.

## Stop

Stop the SSH tunnel by closing the `connect-oa-yodaze.bat` PowerShell window or
pressing `Ctrl+C`.

Stop remote relay containers:

```powershell
ssh -p 22222 root@159.75.188.203 "cd /opt/openagents/workspace && docker compose -f docker-compose.prod.yml down"
```

Local Web windows started by `start.bat` can be closed manually.

## Checks

Local control plane:

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8000/v1/agent-catalog
```

Public relay health:

```powershell
Invoke-WebRequest -UseBasicParsing http://oa.yodaze.com/relay-health
```

Public relay API:

```powershell
Invoke-WebRequest -UseBasicParsing http://oa.yodaze.com/v1/agent-catalog
```

Remote Docker status:

```powershell
ssh -p 22222 root@159.75.188.203 "cd /opt/openagents/workspace && docker compose -f docker-compose.prod.yml ps"
```

Remote Docker logs:

```powershell
ssh -p 22222 root@159.75.188.203 "cd /opt/openagents/workspace && docker compose -f docker-compose.prod.yml logs --tail=200"
```

## Common Failures

`Remote relay cannot reach the local control API`

- The SSH reverse tunnel is not running, or it exited.
- Keep `connect-oa-yodaze.bat` open.
- If the tunnel exits immediately, enable `GatewayPorts clientspecified` on the
  server sshd and reload sshd.

`/v1/workspaces` returns 403 on the server`

- Expected. Remote relay mode disables workspace creation and directory listing.
- Enter an existing workspace name/slug and token/password.

Wrong workspace name/token still enters a workspace shell

- This should not happen. The frontend must call `/v1/workspaces/resolve` before
  routing. Run `connect-oa-yodaze.bat` again after deploying latest files.

Docker container can not reach `host.docker.internal`

- The compose file includes `host.docker.internal:host-gateway`.
- Verify from the server:

```sh
docker run --rm --add-host host.docker.internal:host-gateway curlimages/curl:8.10.1 \
  -fsS http://host.docker.internal:8000/v1/agent-catalog
```
