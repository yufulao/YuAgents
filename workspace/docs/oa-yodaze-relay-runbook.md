# oa.yodaze.com Relay Runbook

This runbook has moved to the shared, configurable relay deployment guide:

- 中文优先：[OpenAgents 远端 Relay 部署说明](remote-relay-deploy.zh.md)
- English: [Remote Docker Deployment Simulation](remote-docker-deploy.md)

The deployment no longer keeps SSH host, domain, ports, or remote directory
hardcoded in this document. Edit:

```text
workspace/deploy.remote.env
```

Then use the root entrypoints:

```bat
..start.bat
..dist_prod.bat
..connect_prod.bat
```

On Linux/macOS local development, use:

```sh
./..start.sh
```
