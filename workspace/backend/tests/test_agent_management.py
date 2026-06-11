# -*- coding: utf-8 -*-
"""Tests for Web-managed agent configuration APIs."""

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
    assert data["quality"] == "high"

    cfg = db.query(AgentConfig).filter_by(handle="codex-main").one()
    assert cfg.display_name == "灵梦 Codex"
    assert cfg.working_dir == "C:/repo"


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
