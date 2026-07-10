# -*- coding: utf-8 -*-
"""Tests for Web-managed agent configuration APIs."""

import json
from types import SimpleNamespace
from datetime import datetime, timezone

import pytest

from app.models import AgentConfig, WorkspaceMember
from app.services import local_agent_control


def _auth(workspace):
    return {"X-Workspace-Token": workspace["token"]}


def test_create_managed_agent_returns_local_agent_contract(client, workspace, db):
    resp = client.post(
        f"/v1/workspaces/{workspace['id']}/agents",
        headers=_auth(workspace),
        json={
            "agent_name": "codex-main",
            "agent_type": "codex",
            "display_name": "灵梦 Codex",
            "working_dir": "C:/repo",
            "model_provider": "openai",
            "model_name": "gpt-5",
            "mode": "code",
            "quality": "high",
        },
    )

    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["handle"] == "codex-main"
    assert data["displayName"] == "灵梦 Codex"
    assert data["agentType"] == "codex"
    assert data["modelProvider"] == "openai"
    assert data["model"] == "gpt-5"
    assert data["mode"] == "code"
    assert data["quality"] == "high"

    cfg = db.query(AgentConfig).filter_by(handle="codex-main").one()
    assert cfg.display_name == "灵梦 Codex"
    assert cfg.working_dir == "C:/repo"
    assert cfg.mode == "code"


def test_update_disable_and_delete_managed_agent(client, workspace, db):
    client.post(
        f"/v1/workspaces/{workspace['id']}/agents",
        headers=_auth(workspace),
        json={"agent_name": "local-a", "agent_type": "claude"},
    )

    update = client.patch(
        f"/v1/workspaces/{workspace['id']}/agents/local-a",
        headers=_auth(workspace),
        json={
            "display_name": "本地 Claude",
            "lifecycle_status": "disabled",
            "quality": "max",
        },
    )
    assert update.status_code == 200
    data = update.json()["data"]
    assert data["displayName"] == "本地 Claude"
    assert data["lifecycleState"] == "stopped"
    assert data["quality"] == "max"

    detail = client.get(f"/v1/workspaces/{workspace['id']}", headers=_auth(workspace))
    agent = next(a for a in detail.json()["data"]["agents"] if a["agentName"] == "local-a")
    assert agent["status"] == "stopped"

    delete = client.delete(f"/v1/workspaces/{workspace['id']}/agents/local-a", headers=_auth(workspace))
    assert delete.status_code == 200
    assert db.query(AgentConfig).filter_by(handle="local-a").count() == 0


def test_create_managed_agent_defaults_mode_to_execute(client, workspace, db):
    resp = client.post(
        f"/v1/workspaces/{workspace['id']}/agents",
        headers=_auth(workspace),
        json={"agent_name": "mode-default", "agent_type": "codex"},
    )

    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["mode"] == "execute"

    cfg = db.query(AgentConfig).filter_by(handle="mode-default").one()
    assert cfg.mode == "execute"


def test_create_managed_agent_accepts_blank_working_dir(client, workspace, db):
    resp = client.post(
        f"/v1/workspaces/{workspace['id']}/agents",
        headers=_auth(workspace),
        json={
            "agent_name": "blank-dir",
            "agent_type": "codex",
            "working_dir": "",
            "model_provider": "openai",
            "model_name": "gpt-5",
            "mode": "execute",
            "quality": "medium",
        },
    )

    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["workingDir"] is None
    assert data["modelProvider"] == "openai"
    assert data["model"] == "gpt-5"

    cfg = db.query(AgentConfig).filter_by(handle="blank-dir").one()
    member = db.query(WorkspaceMember).filter_by(agent_name="blank-dir").one()
    assert cfg.working_dir is None
    assert member.working_dir is None


def test_create_managed_agent_rejects_stale_config_duplicate(client, workspace, db):
    db.add(AgentConfig(
        workspace_id=workspace["id"],
        handle="stale-config",
        display_name="stale-config",
        avatar={"type": "pixel", "value": "stale-config"},
        agent_type="codex",
    ))
    db.commit()

    resp = client.post(
        f"/v1/workspaces/{workspace['id']}/agents",
        headers=_auth(workspace),
        json={"agent_name": "stale-config", "agent_type": "codex"},
    )

    assert resp.status_code == 400
    assert "already exists" in resp.json()["message"]
    assert db.query(WorkspaceMember).filter_by(agent_name="stale-config").count() == 0


def test_create_managed_agent_accepts_chinese_one_field_name(client, workspace, db):
    resp = client.post(
        f"/v1/workspaces/{workspace['id']}/agents",
        headers=_auth(workspace),
        json={"agent_name": "紫", "agent_type": "codex"},
    )

    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["handle"] == "紫"
    assert data["agentName"] == "紫"
    assert data["displayName"] == "紫"

    cfg = db.query(AgentConfig).filter_by(handle="紫").one()
    assert cfg.display_name == "紫"


def test_managed_agent_rejects_invalid_mode(client, workspace):
    create = client.post(
        f"/v1/workspaces/{workspace['id']}/agents",
        headers=_auth(workspace),
        json={"agent_name": "bad-mode", "agent_type": "codex", "mode": "invalid-mode"},
    )
    assert create.status_code == 400
    assert "Invalid mode" in create.json()["message"]

    client.post(
        f"/v1/workspaces/{workspace['id']}/agents",
        headers=_auth(workspace),
        json={"agent_name": "good-mode", "agent_type": "codex"},
    )
    update = client.patch(
        f"/v1/workspaces/{workspace['id']}/agents/good-mode",
        headers=_auth(workspace),
        json={"mode": "invalid-mode"},
    )
    assert update.status_code == 400
    assert "Invalid mode" in update.json()["message"]


def test_managed_agent_accepts_execute_mode_and_xhigh_quality(client, workspace):
    create = client.post(
        f"/v1/workspaces/{workspace['id']}/agents",
        headers=_auth(workspace),
        json={
            "agent_name": "codex-execute",
            "agent_type": "codex",
            "mode": "execute",
            "quality": "xhigh",
        },
    )
    assert create.status_code == 200
    data = create.json()["data"]
    assert data["mode"] == "execute"
    assert data["quality"] == "xhigh"


def test_managed_agent_accepts_dynamic_codex_reasoning_level(client, workspace):
    create = client.post(
        f"/v1/workspaces/{workspace['id']}/agents",
        headers=_auth(workspace),
        json={
            "agent_name": "codex-dynamic-level",
            "agent_type": "codex",
            "quality": "reasoning-5.6",
        },
    )
    assert create.status_code == 200
    assert create.json()["data"]["quality"] == "reasoning-5.6"

    update = client.patch(
        f"/v1/workspaces/{workspace['id']}/agents/codex-dynamic-level",
        headers=_auth(workspace),
        json={"quality": "model_5.6-fast"},
    )
    assert update.status_code == 200
    assert update.json()["data"]["quality"] == "model_5.6-fast"


def test_managed_agent_rejects_unsafe_quality_token(client, workspace):
    create = client.post(
        f"/v1/workspaces/{workspace['id']}/agents",
        headers=_auth(workspace),
        json={
            "agent_name": "codex-bad-quality",
            "agent_type": "codex",
            "quality": "bad value",
        },
    )
    assert create.status_code == 400
    assert "Invalid quality" in create.json()["message"]


def test_control_managed_agent_starts_local_daemon_bridge(client, workspace, monkeypatch):
    client.post(
        f"/v1/workspaces/{workspace['id']}/agents",
        headers=_auth(workspace),
        json={
            "agent_name": "local-runner",
            "agent_type": "codex",
            "working_dir": "C:/repo",
        },
    )

    calls = []

    def fake_control_local_agent(**kwargs):
        calls.append(kwargs)
        return {"ok": True, "command": "start:local-runner", "pid": 1234}

    monkeypatch.setattr("app.routers.workspaces.control_local_agent", fake_control_local_agent)

    resp = client.post(
        f"/v1/workspaces/{workspace['id']}/agents/local-runner/control",
        headers=_auth(workspace),
        json={"action": "start"},
    )

    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["agent"]["agentName"] == "local-runner"
    assert data["agent"]["status"] == "starting"
    assert data["control"]["command"] == "start:local-runner"
    assert calls[0]["action"] == "start"
    assert calls[0]["agent"]["name"] == "local-runner"
    assert calls[0]["agent"]["type"] == "codex"
    assert calls[0]["agent"]["workingDir"] == "C:/repo"
    assert calls[0]["workspace"]["token"] == workspace["token"]
    assert calls[0]["endpoint"] == "http://127.0.0.1:8000"


def test_control_managed_agent_uses_configured_local_endpoint(client, workspace, monkeypatch):
    client.post(
        f"/v1/workspaces/{workspace['id']}/agents",
        headers=_auth(workspace),
        json={"agent_name": "local-endpoint", "agent_type": "codex"},
    )

    calls = []

    def fake_control_local_agent(**kwargs):
        calls.append(kwargs)
        return {"ok": True, "command": "start:local-endpoint", "pid": 1234}

    monkeypatch.setattr("app.routers.workspaces.config.LOCAL_AGENT_CONTROL_ENDPOINT", "http://127.0.0.1:8123/")
    monkeypatch.setattr("app.routers.workspaces.control_local_agent", fake_control_local_agent)

    resp = client.post(
        f"/v1/workspaces/{workspace['id']}/agents/local-endpoint/control",
        headers=_auth(workspace),
        json={"action": "start"},
    )

    assert resp.status_code == 200
    assert calls[0]["endpoint"] == "http://127.0.0.1:8123"


def test_control_managed_agent_keeps_fast_join_online(client, workspace, db, monkeypatch):
    client.post(
        f"/v1/workspaces/{workspace['id']}/agents",
        headers=_auth(workspace),
        json={"agent_name": "fast-joiner", "agent_type": "codex"},
    )

    def fake_control_local_agent(**kwargs):
        member = db.query(WorkspaceMember).filter_by(
            workspace_id=workspace["id"],
            agent_name="fast-joiner",
        ).one()
        member.status = "online"
        member.last_heartbeat = datetime.now(timezone.utc)
        member.session_id = "session-from-fast-daemon-join"
        db.commit()
        return {"ok": True, "command": "daemon:start", "pid": 1234}

    monkeypatch.setattr("app.routers.workspaces.control_local_agent", fake_control_local_agent)

    resp = client.post(
        f"/v1/workspaces/{workspace['id']}/agents/fast-joiner/control",
        headers=_auth(workspace),
        json={"action": "start"},
    )

    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["agent"]["agentName"] == "fast-joiner"
    assert data["agent"]["status"] == "online"


def test_local_agent_control_uses_utf8_and_rejects_empty_stdout(monkeypatch, tmp_path):
    connector_dir = tmp_path / "packages" / "agent-connector"
    (connector_dir / "src").mkdir(parents=True)
    (connector_dir / "bin").mkdir()
    (connector_dir / "src" / "index.js").write_text("// connector", encoding="utf-8")
    (connector_dir / "bin" / "agent-connector.js").write_text("// bin", encoding="utf-8")
    monkeypatch.setattr(local_agent_control, "_connector_dir", lambda: connector_dir)

    def fake_run(*args, **kwargs):
        assert kwargs["encoding"] == "utf-8"
        assert kwargs["errors"] == "replace"
        return SimpleNamespace(returncode=0, stdout=None, stderr="")

    monkeypatch.setattr(local_agent_control.subprocess, "run", fake_run)

    with pytest.raises(local_agent_control.LocalAgentControlError) as exc:
        local_agent_control.control_local_agent(
            action="start",
            endpoint="http://testserver",
            workspace={"id": "workspace-id", "slug": "ws", "name": "WS", "token": "token"},
            agent={"name": "local-runner", "type": "codex", "role": "worker"},
        )

    assert "returned no output" in str(exc.value)


def test_local_agent_control_parses_json_stdout(monkeypatch, tmp_path):
    connector_dir = tmp_path / "packages" / "agent-connector"
    (connector_dir / "src").mkdir(parents=True)
    (connector_dir / "bin").mkdir()
    (connector_dir / "src" / "index.js").write_text("// connector", encoding="utf-8")
    (connector_dir / "bin" / "agent-connector.js").write_text("// bin", encoding="utf-8")
    monkeypatch.setattr(local_agent_control, "_connector_dir", lambda: connector_dir)

    def fake_run(*args, **kwargs):
        return SimpleNamespace(returncode=0, stdout=' {"ok": true, "command": "start:local-runner"}\n', stderr="")

    monkeypatch.setattr(local_agent_control.subprocess, "run", fake_run)

    result = local_agent_control.control_local_agent(
        action="start",
        endpoint="http://testserver",
        workspace={"id": "workspace-id", "slug": "ws", "name": "WS", "token": "token"},
        agent={"name": "local-runner", "type": "codex", "role": "worker"},
    )

    assert result == {"ok": True, "command": "start:local-runner"}


def test_cloud_agent_allows_empty_api_key(client, workspace):
    resp = client.post(
        "/v1/cloud-agents",
        headers=_auth(workspace),
        json={
            "network": workspace["id"],
            "agent_name": "official-openai",
            "provider": "openai",
            "model": "gpt-5.5",
            "api_key": None,
        },
    )

    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["agentName"] == "official-openai"
    assert data["apiKeyMasked"] is None


def test_codex_local_catalog_reads_dynamic_model_cache(client, monkeypatch, tmp_path):
    codex_home = tmp_path / ".codex"
    codex_home.mkdir()
    (codex_home / "config.toml").write_text(
        'model = "gpt-5.6"\nmodel_reasoning_effort = "xhigh"\n',
        encoding="utf-8",
    )
    (codex_home / "models_cache.json").write_text(
        json.dumps({
            "models": [
                {
                    "slug": "gpt-5.6",
                    "display_name": "GPT-5.6",
                    "default_reasoning_level": "medium",
                    "supported_reasoning_levels": [{"effort": "xhigh"}],
                    "additional_speed_tiers": ["fast"],
                    "service_tiers": [{"id": "priority", "name": "Fast"}],
                }
            ]
        }),
        encoding="utf-8",
    )
    monkeypatch.setenv("CODEX_HOME", str(codex_home))

    resp = client.get("/v1/agent-catalog/codex-local")

    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["config"]["model"] == "gpt-5.6"
    assert data["config"]["model_reasoning_effort"] == "xhigh"
    assert data["models"][0]["slug"] == "gpt-5.6"
    assert data["models"][0]["additional_speed_tiers"] == ["fast"]
