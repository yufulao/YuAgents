# -*- coding: utf-8 -*-
"""Tests for Web-managed agent configuration APIs."""

import json

from app.models import AgentConfig


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
