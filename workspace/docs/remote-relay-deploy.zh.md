# OpenAgents 远端 Relay 部署说明

> 英文说明见：[Remote Docker Deployment Simulation](remote-docker-deploy.md)。

## 目标

当前远端 Web 不是主控服务器。它只是一个 relay：

- workspace、token、Agent 状态、聊天、任务等权威数据仍在本机控制面。
- 远端 Docker 只提供公网 Web 页面和 nginx `/v1/*` 转发。
- 本机通过 SSH reverse tunnel 把本机控制面暴露给远端 nginx。

## 配置文件

统一配置文件：

```text
workspace/deploy.remote.env
```

这个文件会被以下入口读取：

- 根目录 `..start.bat`
- 根目录 `..start.sh`
- 根目录 `..connect_prod.bat`
- `workspace/start.bat`
- `workspace/start.sh`
- `workspace/scripts/start-local-web.ps1`
- `workspace/scripts/start-remote-docker.ps1`
- `workspace/scripts/connect-remote-relay.ps1`
- `workspace/scripts/deploy-remote-relay.ps1`
- `workspace/scripts/package-remote-relay.ps1`

优先级：

```text
命令行参数 > 环境变量 > workspace/deploy.remote.env > 脚本内置兜底
```

默认配置项：

```text
OA_LOCAL_BACKEND_HOST=127.0.0.1
OA_LOCAL_BACKEND_BIND=0.0.0.0
OA_LOCAL_BACKEND_PORT=8000
OA_LOCAL_FRONTEND_HOST=localhost
OA_LOCAL_FRONTEND_PORT=3001

OA_REMOTE_DOMAIN=oa.yodaze.com
OA_REMOTE_PUBLIC_URL=http://oa.yodaze.com
OA_REMOTE_WEB_BIND=127.0.0.1
OA_REMOTE_WEB_PORT=18080
OA_REMOTE_PROJECT_NAME=openagents-remote-sim

OA_REMOTE_SSH_HOST=159.75.188.203
OA_REMOTE_SSH_PORT=22222
OA_REMOTE_SSH_USER=root
OA_REMOTE_DIR=/opt/openagents
OA_TUNNEL_PORT=8000

OA_LOCAL_CONTROL_API_URL=http://host.docker.internal:8000
```

不要把 workspace token、SSH 密码、API key 写进这个文件。它会进入服务器包，应该只放非密钥部署参数。

## 本机启动

Windows：

```bat
..start.bat
```

Linux/macOS：

```sh
./..start.sh
```

默认启动：

- backend: `http://127.0.0.1:8000`
- frontend: `http://localhost:3001`

如果要换端口，优先改 `workspace/deploy.remote.env`。

## 打包服务器文件

Windows：

```bat
..dist_prod.bat
```

它调用：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File workspace\scripts\package-remote-relay.ps1
```

服务器包会包含：

- `workspace/docker-compose.prod.yml`
- `workspace/deploy.remote.env`
- `workspace/nginx.conf.template`
- `workspace/start.sh`
- `workspace/frontend`

不会包含：

- token、`.env`、SQLite DB、日志、exports
- `node_modules`
- `.next`
- 本机启动脚本
- 未提交文件

如果改了配置并希望服务器包带上新配置，先提交配置文件，再打包。打包脚本使用 `git archive HEAD`，未提交改动不会进入包。

## 部署到远端服务器

可用脚本：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File workspace\scripts\deploy-remote-relay.ps1
```

脚本会读取 `workspace/deploy.remote.env` 里的：

- `OA_REMOTE_SSH_HOST`
- `OA_REMOTE_SSH_PORT`
- `OA_REMOTE_SSH_USER`
- `OA_REMOTE_DIR`
- `OA_REMOTE_DOMAIN`
- `OA_REMOTE_WEB_PORT`

如需临时覆盖：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File workspace\scripts\deploy-remote-relay.ps1 `
  -SshHost 1.2.3.4 `
  -SshPort 22222 `
  -Domain example.com `
  -RemoteWebPort 18080
```

## 服务器启动 Relay

在服务器上进入部署目录：

```sh
cd /opt/openagents/workspace
bash start.sh
```

`start.sh` 会读取同目录的 `deploy.remote.env`。

它会启动 Docker frontend + nginx，并让 nginx 把 `/v1/*` 转发给：

```text
OA_LOCAL_CONTROL_API_URL
```

默认是：

```text
http://host.docker.internal:8000
```

在 Linux Docker 中，`docker-compose.prod.yml` 会把 `host.docker.internal` 映射到 Docker host gateway。

## 打开本机到服务器的隧穿

Windows：

```bat
..connect_prod.bat
```

它调用：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File workspace\scripts\connect-remote-relay.ps1
```

脚本会读取配置，并打开：

```text
server docker gateway:OA_TUNNEL_PORT -> local 127.0.0.1:OA_LOCAL_BACKEND_PORT
```

默认等价于：

```text
server docker gateway:8000 -> local 127.0.0.1:8000
```

保持这个窗口打开。窗口关闭后，远端 `/v1/*` 就无法访问本机控制面。

## 本机 Docker 模拟远端

先启动本机控制面：

```bat
..start.bat
```

再启动 relay 模拟：

```bat
cd workspace
start.bat
```

或者：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File workspace\scripts\start-remote-docker.ps1 -Build
```

打开配置里的 `OA_REMOTE_PUBLIC_URL`。默认是：

```text
http://oa.yodaze.com
```

如果只是本机模拟，建议临时传：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File workspace\scripts\start-remote-docker.ps1 `
  -PublicUrl http://localhost:18080 `
  -Build
```

## 常见问题

### 远端页面能打开，但登录提示无法连接 workspace 服务

检查隧穿窗口是否仍在运行：

```bat
..connect_prod.bat
```

检查服务器 Docker 是否能访问上游：

```sh
docker run --rm --add-host host.docker.internal:host-gateway curlimages/curl:8.10.1 \
  -fsS http://host.docker.internal:8000/v1/agent-catalog
```

### 改了配置但服务器包没变化

服务器包由 `git archive HEAD` 生成。先提交：

```sh
git add workspace/deploy.remote.env
git commit -m "chore(workspace): update remote relay config"
```

再运行：

```bat
..dist_prod.bat
```

### 换域名

修改：

```text
OA_REMOTE_DOMAIN=your.domain
OA_REMOTE_PUBLIC_URL=http://your.domain
```

如果服务器上使用 host nginx，重新运行部署脚本并带 `-ConfigureNginx`。
