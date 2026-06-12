# -*- coding: utf-8 -*-
"""Bridge Web-managed local agents to the local agent-connector daemon."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any


class LocalAgentControlError(RuntimeError):
    """Raised when the local agent connector cannot apply a control action."""


def _repo_root() -> Path:
    # app/services/local_agent_control.py -> backend -> workspace -> repo root
    return Path(__file__).resolve().parents[4]


def _connector_dir() -> Path:
    return _repo_root() / "packages" / "agent-connector"


def control_local_agent(
    *,
    action: str,
    workspace: dict[str, Any],
    agent: dict[str, Any],
    endpoint: str,
) -> dict[str, Any]:
    """Synchronize connector config and issue a daemon lifecycle command.

    The workspace backend is the local control plane in this deployment. Web
    creates the product-layer AgentConfig, while agent-connector owns runtime
    processes. This bridge keeps those two stores aligned before starting or
    restarting the local daemon.
    """
    if action not in {"start", "restart", "stop"}:
        raise LocalAgentControlError(f"Unsupported action: {action}")

    connector_dir = _connector_dir()
    connector_entry = connector_dir / "src" / "index.js"
    connector_bin = connector_dir / "bin" / "agent-connector.js"
    if not connector_entry.exists() or not connector_bin.exists():
        raise LocalAgentControlError(f"agent-connector not found at {connector_dir}")

    script = r"""
const path = require('path');
const input = JSON.parse(process.env.OA_LOCAL_AGENT_CONTROL || '{}');
const { AgentConnector, Daemon } = require(path.join(input.connectorDir, 'src', 'index.js'));

const connector = new AgentConnector({ workspaceEndpoint: input.endpoint });
const config = connector.config.load();
config.version = config.version || 2;
config.agents = Array.isArray(config.agents) ? config.agents : [];
config.networks = Array.isArray(config.networks) ? config.networks : [];

const ws = input.workspace;
const ag = input.agent;

let network = config.networks.find((n) => n.slug === ws.slug || n.id === ws.id);
if (!network) {
  network = { id: ws.id, slug: ws.slug };
  config.networks.push(network);
}
network.id = ws.id;
network.slug = ws.slug;
network.name = ws.name || ws.slug;
network.endpoint = input.endpoint;
network.token = ws.token || '';

let agent = config.agents.find((a) => a.name === ag.name);
if (!agent) {
  agent = { name: ag.name };
  config.agents.push(agent);
}
agent.type = ag.type || 'codex';
agent.role = ag.role || 'worker';
agent.network = ws.slug;
if (ag.workingDir) agent.path = ag.workingDir;
else delete agent.path;

connector.config.save(config);

let pid = connector.getDaemonPid();
let livePid = Daemon.runningDaemonPid(connector._configDir);
let daemonStarted = false;
let command = null;
const messages = [];
if (input.action === 'stop') {
  if (livePid) {
    connector.sendDaemonCommand(`stop:${ag.name}`);
    command = `stop:${ag.name}`;
  }
} else if (!livePid) {
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => messages.push(args.join(' '));
  console.error = (...args) => messages.push(args.join(' '));
  try {
    connector.startDaemon([path.join(input.connectorDir, 'bin', 'agent-connector.js'), 'up', '--foreground', '--no-update-check']);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  daemonStarted = true;
  command = 'daemon:start';
  pid = connector.getDaemonPid();
  livePid = Daemon.runningDaemonPid(connector._configDir) || pid;
} else {
  const verb = input.action === 'restart' ? 'restart' : 'start';
  connector.sendDaemonCommand(`${verb}:${ag.name}`);
  command = `${verb}:${ag.name}`;
}

const status = connector.getDaemonStatus()[ag.name] || null;
process.stdout.write(JSON.stringify({
  ok: true,
  action: input.action,
  pid,
  livePid,
  daemonStarted,
  command,
  messages,
  status,
  configDir: connector._configDir,
}));
"""

    payload = {
        "action": action,
        "workspace": workspace,
        "agent": agent,
        "endpoint": endpoint.rstrip("/"),
        "connectorDir": str(connector_dir),
    }
    env = os.environ.copy()
    env["OA_LOCAL_AGENT_CONTROL"] = json.dumps(payload, ensure_ascii=False)
    env["OPENAGENTS_SKIP_UPDATE_CHECK"] = "1"

    try:
        result = subprocess.run(
            ["node", "-e", script],
            cwd=str(connector_dir),
            env=env,
            text=True,
            capture_output=True,
            timeout=15,
            check=False,
        )
    except FileNotFoundError as exc:
        raise LocalAgentControlError("Node.js not found in PATH") from exc
    except subprocess.TimeoutExpired as exc:
        raise LocalAgentControlError("agent-connector command timed out") from exc

    if result.returncode != 0:
        stderr = (result.stderr or result.stdout or "").strip()
        raise LocalAgentControlError(stderr or f"agent-connector exited with {result.returncode}")

    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise LocalAgentControlError(f"Invalid agent-connector output: {result.stdout[:500]}") from exc
