# YuAgents / OpenAgents Workspace

本仓库是面向本地优先部署的 OpenAgents Workspace 改造版。目标是把多 Agent 协作、工作区、任务、线程、状态和本地 Agent 生命周期管理集中到一个 Web 工作台里，同时保持控制权和数据主权在本机。

## 核心原则

- 本机是主控平面：workspace、token、Agent 配置、任务、消息和运行控制都以本机服务为准。
- 远端服务器只做 Relay：公网入口负责转发 Web/API 流量，不创建、不枚举、不持有 workspace 权威数据。
- Web 是主要操作入口：创建 workspace、查看 token、创建/启动/重启 Agent、聊天、线程和任务都从 Web 完成。
- 配置显式化：域名、端口、SSH、Docker Relay 等部署参数集中在 `workspace/deploy.remote.env`。

## 快速启动：本机 Web

Windows：

```bat
..start.bat
```

Linux / macOS：

```bash
./..start.sh
```

启动成功后打开：

```text
http://localhost:3001
```

本机启动脚本会：

- 启动 backend：`http://127.0.0.1:8000`
- 启动 frontend：`http://localhost:3001`
- 使用本地 SQLite：`workspace/backend/workspace_dev.db`
- 首次运行时自动创建 `workspace/backend/.venv` 并安装 Python backend 依赖
- 首次运行时在缺少 `workspace/frontend/node_modules` 时自动安装 npm 依赖

日志位置：

```text
workspace/logs/local-backend.log
workspace/logs/local-backend.err.log
workspace/logs/local-frontend.log
workspace/logs/local-frontend.err.log
```

如果启动超时，脚本会直接打印对应日志尾部，优先看 `local-backend.err.log` 或 `local-frontend.err.log`。

## 远端 Relay / Docker 私有入口

本机主控启动后，可以启动一个“远端服务器形态”的本地 Docker Relay 模拟：

```bat
cd workspace
start.bat
```

默认入口：

```text
http://localhost:18080
```

这个 Relay 只把 `/v1/*` 转发回本机控制平面，不在 Docker 里运行 workspace backend/db，也不会创建、枚举或泄露 workspace token。

正式远端部署和 SSH 反向隧道说明见：

- 中文主文档：[workspace/docs/remote-relay-deploy.zh.md](workspace/docs/remote-relay-deploy.zh.md)
- English reference: [workspace/docs/remote-docker-deploy.md](workspace/docs/remote-docker-deploy.md)

## 部署配置

所有非密钥部署参数集中在：

```text
workspace/deploy.remote.env
```

常用项：

```env
OA_LOCAL_BACKEND_HOST=127.0.0.1
OA_LOCAL_BACKEND_BIND=0.0.0.0
OA_LOCAL_BACKEND_PORT=8000
OA_LOCAL_FRONTEND_HOST=localhost
OA_LOCAL_FRONTEND_PORT=3001

OA_REMOTE_DOMAIN=oa.yodaze.com
OA_REMOTE_PUBLIC_URL=http://oa.yodaze.com
OA_REMOTE_WEB_BIND=127.0.0.1
OA_REMOTE_WEB_PORT=18080

OA_REMOTE_SSH_HOST=159.75.188.203
OA_REMOTE_SSH_PORT=22222
OA_REMOTE_SSH_USER=root
OA_REMOTE_DIR=/opt/openagents
OA_TUNNEL_PORT=8000
OA_LOCAL_CONTROL_API_URL=http://host.docker.internal:8000
```

优先级：

```text
命令行参数 > 环境变量 > workspace/deploy.remote.env > 脚本默认值
```

不要把真实密钥、workspace token、API key 写入 `deploy.remote.env` 并提交。

## 常用脚本

| 脚本 | 用途 |
| --- | --- |
| `..start.bat` | Windows 本机 Web 一键启动 |
| `..start.sh` | Linux/macOS 本机 Web 一键启动 |
| `workspace/start.bat` | 本地 Docker Relay 模拟 |
| `workspace/scripts/start-local-web.ps1` | Windows 本机 Web 启动实现 |
| `workspace/scripts/start-remote-docker.ps1` | Docker Relay 启动/状态/日志/停止 |
| `workspace/scripts/connect-remote-relay.ps1` | 远端 Relay 部署后建立 SSH 反向隧道 |
| `workspace/scripts/package-remote-relay.ps1` | 打包远端 Relay 服务器文件 |
| `..dist_prod.bat` | 生成远端 Relay 分发包 |
| `..connect_prod.bat` | 按配置连接生产 Relay |

## 开发与测试

Backend：

```bash
cd workspace/backend
python -m pytest tests -q
```

Frontend：

```bash
cd workspace/frontend
npm install
npm run build
```

常用针对性验证：

```bash
python -m pytest workspace/backend/tests/test_workspaces.py -q
python -m pytest workspace/backend/tests/test_workspace_tasks.py -q
node --test packages/agent-connector/test/daemon.test.js
```

## 故障排查

### `Timed out waiting for backend API`

优先检查：

```text
workspace/logs/local-backend.err.log
```

常见原因：

- Python 没有加入 PATH，或版本过旧。
- 首次安装 Python 依赖失败。
- 8000 端口被安全软件或其他程序占用。
- 仓库路径被杀毒/权限策略限制，导致 `.venv` 或 SQLite 文件不可写。

处理方式：

```bat
cd workspace\backend
.venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\python.exe -m uvicorn app.main:app --host 0.0.0.0 --port 8000
```

### `Failed to fetch` 或 CORS 报错

本机 Web 请通过以下地址访问：

```text
http://localhost:3001
```

如果用机器名访问，例如 `http://YUFULAO:3001`，后端必须绑定 `0.0.0.0:8000`，当前 `..start.bat` 已按这个方式启动。

### 远端 Relay 无法登录 workspace

确认本机主控平面正在运行：

```text
http://127.0.0.1:8000/v1/agent-catalog
```

Relay 只转发请求，不保存 workspace。必须使用本机已有 workspace 的名称/slug 和 token/password 登录。

## 项目结构

```text
workspace/
  backend/        FastAPI workspace API、本地 SQLite/Postgres 支持
  frontend/       Next.js workspace Web UI
  scripts/        本机启动、Relay、打包和测试脚本
  docs/           远端 Relay 与 Docker 部署文档
packages/
  agent-connector/ 本机 Agent daemon、状态、消息投递和运行时桥接
sdk/              OpenAgents SDK / Studio 旧版相关代码
docs/             架构与迁移文档
```

## License

Apache-2.0。详见 [LICENSE](LICENSE)。
