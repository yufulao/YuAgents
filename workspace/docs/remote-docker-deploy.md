# Remote Docker Deployment Simulation

This is the local "remote server" flow. It uses the production Docker Compose
stack as a relay. It does not create, seed, sync, or enumerate workspaces.
Workspace authority stays on the local control plane.

Remote mode keeps these controls disabled:

- `WORKSPACE_CREATION_ENABLED=false`
- `WORKSPACE_DIRECTORY_ENABLED=false`
- `NEXT_PUBLIC_WORKSPACE_CREATION_ENABLED=false`
- `NEXT_PUBLIC_WORKSPACE_DIRECTORY_ENABLED=false`

The remote frontend uses same-origin `/v1` by default. Remote nginx forwards
`/v1/*` to `LOCAL_CONTROL_API_URL`. In the local Docker simulation that defaults to:

```text
http://host.docker.internal:8000
```

For a real Linux server, point `LOCAL_CONTROL_API_URL` at an SSH reverse tunnel
or another private path back to the local control plane. The relay container
must be able to reach this URL; otherwise `/v1/*` will return a clear 502.

The default Linux setup assumes an SSH reverse tunnel listens on the server
host at `127.0.0.1:8000`, and Docker reaches that host port as
`host.docker.internal:8000`:

```text
server host preflight:  http://127.0.0.1:8000
nginx container upstream: http://host.docker.internal:8000
```

## Start

From the repository root:

```powershell
start.bat
```

Then in another terminal, from `workspace`:

```bat
start.bat
```

On Linux/macOS, run the equivalent shell script from `workspace`:

```sh
sh start.sh
```

For a real remote Linux server, first create the reverse tunnel from the local
machine that runs the authoritative control plane:

```sh
ssh -N -R 8000:127.0.0.1:8000 root@YOUR_SERVER
```

Then start the relay on the server:

```sh
cd /home/OpenAgents/workspace
LOCAL_CONTROL_API_URL=http://host.docker.internal:8000 bash start.sh
```

If your reverse tunnel uses a different server port, set both URLs:

```sh
LOCAL_CONTROL_API_URL=http://host.docker.internal:18000 \
CONTROL_CHECK_URL=http://127.0.0.1:18000 \
bash start.sh
```

Open:

```text
http://localhost:18080
```

Use an existing workspace name/slug and token/password. The Docker stack does
not have a workspace database; login is verified by the local control plane.

## Options

Use a different local port:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File workspace\scripts\start-remote-docker.ps1 -Port 18081 -Build
```

Bind to all interfaces for a LAN/server-style check:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File workspace\scripts\start-remote-docker.ps1 -Bind 0.0.0.0 -PublicUrl http://YOUR_HOST_OR_IP:18080 -Build
```

Point the relay at a different local-control URL:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File workspace\scripts\start-remote-docker.ps1 -LocalControlApiUrl http://host.docker.internal:8000 -Build
```

On Linux `start.sh` performs two checks:

- `CONTROL_CHECK_URL/v1/agent-catalog` from the server host before Docker build.
- `PUBLIC_URL/v1/agent-catalog` through nginx after the relay starts.

If the first check fails, the local control plane or reverse tunnel is missing.
If the second check fails, the container cannot reach `LOCAL_CONTROL_API_URL`.

Check containers:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File workspace\scripts\start-remote-docker.ps1 -Status
```

Follow logs:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File workspace\scripts\start-remote-docker.ps1 -Logs
```

Stop:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File workspace\scripts\start-remote-docker.ps1 -Down
```

## Smoke Test

`workspace\scripts\test-remote-web.ps1` is separate. It is an automated smoke
test and intentionally seeds a temporary workspace in a temporary SQLite DB so
it can verify login behavior. Do not use that script as the pure Docker deploy
simulation.
