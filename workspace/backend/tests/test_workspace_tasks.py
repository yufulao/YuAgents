# -*- coding: utf-8 -*-
"""Tests for shared workspace task graph endpoints."""


def test_create_list_claim_and_update_workspace_task(client, workspace):
    channel_name = workspace["channel"]["name"]
    beta_join = client.post("/v1/join", json={
        "agent_name": "agent-beta",
        "token": workspace["token"],
        "network": workspace["id"],
    })
    assert beta_join.status_code == 200
    beta_session = beta_join.json()["data"]["session_id"]

    join_channel = client.post("/v1/events", json={
        "type": "network.channel.join",
        "source": "human:user1",
        "target": f"channel/{channel_name}",
        "payload": {"channel": channel_name, "agent_name": "agent-beta"},
        "network": workspace["id"],
    }, headers={"X-Workspace-Token": workspace["token"]})
    assert join_channel.status_code == 200

    created = client.post("/v1/workspace-tasks", json={
        "network": workspace["id"],
        "channel": channel_name,
        "title": "Retest the relay login flow",
        "description": "QA should verify valid and invalid tokens.",
        "assignee": "agent-beta",
        "priority": "high",
        "source": "openagents:agent-alpha",
    }, headers={"X-Workspace-Token": workspace["token"]})
    assert created.status_code == 200
    task = created.json()["data"]["task"]
    assert task["status"] == "todo"
    assert task["assignee"] == "agent-beta"
    assert task["claimed_by"] is None

    listed = client.get("/v1/workspace-tasks", params={
        "network": workspace["id"],
        "channel": channel_name,
        "active": True,
    }, headers={"X-Workspace-Token": workspace["token"]})
    assert listed.status_code == 200
    assert [t["id"] for t in listed.json()["data"]["tasks"]] == [task["id"]]

    # The created task event mentions @agent-beta, so normal delivery routing
    # makes the assignee's work durable.
    pending = client.get("/v1/agent-deliveries/pending", params={
        "network": workspace["id"],
        "agent": "agent-beta",
        "session_id": beta_session,
    }, headers={"X-Workspace-Token": workspace["token"]})
    assert pending.status_code == 200
    deliveries = pending.json()["data"]["deliveries"]
    assert len(deliveries) == 1
    assert deliveries[0]["event"]["payload"]["message_type"] == "task"

    claimed = client.post(f"/v1/workspace-tasks/{task['id']}/claim", json={
        "network": workspace["id"],
        "agent_name": "agent-beta",
        "session_id": beta_session,
    }, headers={"X-Workspace-Token": workspace["token"]})
    assert claimed.status_code == 200
    claimed_task = claimed.json()["data"]["task"]
    assert claimed_task["status"] == "in_progress"
    assert claimed_task["claimed_by"] == "agent-beta"

    conflict = client.post(f"/v1/workspace-tasks/{task['id']}/claim", json={
        "network": workspace["id"],
        "agent_name": "agent-alpha",
    }, headers={"X-Workspace-Token": workspace["token"]})
    assert conflict.status_code == 409

    updated = client.patch(f"/v1/workspace-tasks/{task['id']}", json={
        "network": workspace["id"],
        "source": "openagents:agent-beta",
        "status": "in_review",
        "result": "Valid token passed; invalid token rejected.",
    }, headers={"X-Workspace-Token": workspace["token"]})
    assert updated.status_code == 200
    updated_task = updated.json()["data"]["task"]
    assert updated_task["status"] == "in_review"
    assert "invalid token" in updated_task["result"]


def test_agent_context_pack_includes_active_workspace_tasks(client, workspace):
    alpha_join = client.post("/v1/join", json={
        "agent_name": "agent-alpha",
        "token": workspace["token"],
        "network": workspace["id"],
    })
    assert alpha_join.status_code == 200
    session_id = alpha_join.json()["data"]["session_id"]
    channel_name = workspace["channel"]["name"]

    created = client.post("/v1/workspace-tasks", json={
        "network": workspace["id"],
        "channel": channel_name,
        "title": "Split implementation work",
        "assignee": "agent-alpha",
        "source": "human:user1",
    }, headers={"X-Workspace-Token": workspace["token"]})
    assert created.status_code == 200
    task_id = created.json()["data"]["task"]["id"]

    context = client.get("/v1/agent-context", params={
        "network": workspace["id"],
        "agent": "agent-alpha",
        "session_id": session_id,
        "channel": channel_name,
    }, headers={"X-Workspace-Token": workspace["token"]})
    assert context.status_code == 200
    tasks = context.json()["data"]["active_tasks"]
    assert any(t["id"] == task_id and t["title"] == "Split implementation work" for t in tasks)
