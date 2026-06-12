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
or another private path back to the local control plane.

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
