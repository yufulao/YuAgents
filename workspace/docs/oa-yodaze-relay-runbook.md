# oa.yodaze.com Relay Runbook

This deployment is local-first:

- Local Windows machine owns the workspace DB, agents, and control API.
- Remote Linux server only runs the public Web relay.
- `..prod_connect.bat` opens the SSH reverse tunnel over server SSH port `22222`.

Defaults:

- Domain: `oa.yodaze.com`
- Server IP: `159.75.188.203`
- SSH port: `22222`
- Remote directory: `/opt/openagents`
- Remote relay bind: `127.0.0.1:18080`
- Local control API: `127.0.0.1:8000`

## Local Control Plane

From the repository root on the local Windows machine:

```bat
..start.bat
```

This starts the authoritative local backend on `:8000` and the local Web on
`:3001`.

## Local Private Server Simulation

For local Docker/private-server simulation, go into `workspace` and run:

```bat
start.bat
```

That starts the Docker relay locally. It is for testing the remote-mode Web
surface without using the real server.

## Production Package

From the repository root:

```bat
..package_prod.bat
```

This creates:

```text
dist\openagents-oa-yodaze-relay-YYYYMMDD-HHMMSS.zip
```

The zip contains only the server relay files:

- `workspace/docker-compose.prod.yml`
- `workspace/nginx.conf.template`
- `workspace/start.sh`
- `workspace/frontend`

It does not include local environments, generated builds, `node_modules`,
`.next`, exports, logs, SQLite DBs, or untracked files. Docker installs frontend
dependencies on the server with `npm ci` during `docker compose up --build`.

Upload the zip to the server and extract it under `/opt/openagents`, so these
paths exist:

```text
/opt/openagents/workspace/docker-compose.prod.yml
/opt/openagents/workspace/nginx.conf.template
/opt/openagents/workspace/start.sh
/opt/openagents/workspace/frontend/...
```

## Server Start

On the server:

```sh
cd /opt/openagents/workspace
bash start.sh
```

`start.sh` starts the remote Docker relay even if the local reverse tunnel is
not connected yet. The Web page and `/relay-health` can come up first; `/v1/*`
will become usable after `..prod_connect.bat` opens the tunnel from the local
machine.

The server's SSH daemon must already listen on port `22222`. `start.sh` does
not configure sshd; it only starts the Docker relay. If reverse tunnel binding
to the Docker gateway is rejected, set this in sshd config and reload sshd:

```text
GatewayPorts clientspecified
```

```sh
sudo systemctl reload sshd || sudo systemctl reload ssh
```

For `http://oa.yodaze.com`, host nginx should proxy port 80 to
`127.0.0.1:18080`.

## Production Connect

After local `..start.bat` is running and server `bash start.sh` has started the
relay, run from the repository root on the local Windows machine:

```bat
..prod_connect.bat
```

This connects to `root@159.75.188.203` on SSH port `22222`, opens the reverse
tunnel from the server Docker gateway `:8000` to local `127.0.0.1:8000`, and
keeps that tunnel alive. Keep the window open while using `oa.yodaze.com`.

## Checks

Local control plane:

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8000/v1/agent-catalog
```

Public relay health:

```powershell
Invoke-WebRequest -UseBasicParsing http://oa.yodaze.com/relay-health
```

Public relay API after `..prod_connect.bat`:

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

Stop remote relay containers:

```powershell
ssh -p 22222 root@159.75.188.203 "cd /opt/openagents/workspace && docker compose -f docker-compose.prod.yml down"
```
