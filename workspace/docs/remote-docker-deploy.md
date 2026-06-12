# Remote Docker Deployment Simulation

This is the local "remote server" flow. It uses the production Docker Compose
stack and does not create, seed, or enumerate workspaces.

Remote mode keeps these controls disabled:

- `WORKSPACE_CREATION_ENABLED=false`
- `WORKSPACE_DIRECTORY_ENABLED=false`
- `NEXT_PUBLIC_WORKSPACE_CREATION_ENABLED=false`
- `NEXT_PUBLIC_WORKSPACE_DIRECTORY_ENABLED=false`

## Start

From the repository root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File workspace\scripts\start-remote-docker.ps1 -Build
```

Open:

```text
http://localhost:18080
```

Use an existing workspace name/slug and token/password. A fresh empty Docker
database has no workspace to enter until you restore or provide one through the
server-side database.

## Options

Use a different local port:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File workspace\scripts\start-remote-docker.ps1 -Port 18081 -Build
```

Bind to all interfaces for a LAN/server-style check:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File workspace\scripts\start-remote-docker.ps1 -Bind 0.0.0.0 -PublicUrl http://YOUR_HOST_OR_IP:18080 -Build
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
