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
    assert deliveries[0]["event"]["payload"]["content"].startswith("@agent-beta Workspace task created:")
    assert deliveries[0]["event"]["metadata"]["target_agents"] == ["agent-beta"]

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

    repeat_claim = client.post(f"/v1/workspace-tasks/{task['id']}/claim", json={
        "network": workspace["id"],
        "agent_name": "agent-beta",
        "session_id": beta_session,
    }, headers={"X-Workspace-Token": workspace["token"]})
    assert repeat_claim.status_code == 200

    events = client.get("/v1/events", params={
        "network": workspace["id"],
        "type": "workspace.message.posted",
    }, headers={"X-Workspace-Token": workspace["token"]})
    assert events.status_code == 200
    claimed_events = [
        event for event in events.json()["data"]["events"]
        if event["payload"].get("message_type") == "task"
        and "Workspace task claimed:" in event["payload"].get("content", "")
        and task["id"] == event["payload"].get("task", {}).get("id")
    ]
    assert len(claimed_events) == 1


def test_create_workspace_task_requires_source(client, workspace):
    channel_name = workspace["channel"]["name"]
    missing = client.post("/v1/workspace-tasks", json={
        "network": workspace["id"],
        "channel": channel_name,
        "title": "Missing source should not create unknown task",
        "assignee": "agent-beta",
    }, headers={"X-Workspace-Token": workspace["token"]})
    assert missing.status_code == 400
    assert "source is required" in missing.json()["message"]

    unknown = client.post("/v1/workspace-tasks", json={
        "network": workspace["id"],
        "channel": channel_name,
        "title": "Unknown source should not create unknown task",
        "assignee": "agent-beta",
        "source": "openagents:unknown",
    }, headers={"X-Workspace-Token": workspace["token"]})
    assert unknown.status_code == 400
    assert "source is required" in unknown.json()["message"]


def test_create_workspace_task_requires_active_channel(client, workspace):
    missing = client.post("/v1/workspace-tasks", json={
        "network": workspace["id"],
        "title": "Missing channel should not create default task",
        "assignee": "agent-beta",
        "source": "openagents:agent-alpha",
    }, headers={"X-Workspace-Token": workspace["token"]})
    assert missing.status_code == 400
    assert "channel is required" in missing.json()["message"]

    default = client.post("/v1/workspace-tasks", json={
        "network": workspace["id"],
        "channel": "default",
        "title": "Default channel should not be accepted",
        "assignee": "agent-beta",
        "source": "openagents:agent-alpha",
    }, headers={"X-Workspace-Token": workspace["token"]})
    assert default.status_code == 400
    assert "active channel" in default.json()["message"]

    nonexistent = client.post("/v1/workspace-tasks", json={
        "network": workspace["id"],
        "channel": "missing-channel",
        "title": "Unknown channel should not be accepted",
        "assignee": "agent-beta",
        "source": "openagents:agent-alpha",
    }, headers={"X-Workspace-Token": workspace["token"]})
    assert nonexistent.status_code == 400
    assert "active channel" in nonexistent.json()["message"]


def test_create_workspace_task_adds_assignee_to_channel_and_wakes(client, workspace, db):
    from app.models import Channel, ChannelMember

    channel_name = workspace["channel"]["name"]
    beta_join = client.post("/v1/join", json={
        "agent_name": "agent-beta",
        "token": workspace["token"],
        "network": workspace["id"],
    })
    assert beta_join.status_code == 200
    beta_session = beta_join.json()["data"]["session_id"]

    created = client.post("/v1/workspace-tasks", json={
        "network": workspace["id"],
        "channel": channel_name,
        "title": "Scout independent RHI work",
        "assignee": "agent-beta",
        "source": "openagents:agent-alpha",
    }, headers={"X-Workspace-Token": workspace["token"]})
    assert created.status_code == 200
    task = created.json()["data"]["task"]
    assert task["assignee"] == "agent-beta"

    channel = db.query(Channel).filter_by(workspace_id=workspace["id"], name=channel_name).one()
    assert db.get(ChannelMember, (channel.id, "agent-beta")) is not None

    pending = client.get("/v1/agent-deliveries/pending", params={
        "network": workspace["id"],
        "agent": "agent-beta",
        "session_id": beta_session,
    }, headers={"X-Workspace-Token": workspace["token"]})
    assert pending.status_code == 200
    deliveries = pending.json()["data"]["deliveries"]
    assert len(deliveries) == 1
    assert deliveries[0]["delivery_kind"] == "attention"
    assert deliveries[0]["event"]["payload"]["content"].startswith("@agent-beta Workspace task created:")
    assert deliveries[0]["event"]["metadata"]["target_agents"] == ["agent-beta"]


def test_assigning_workspace_task_wakes_new_assignee(client, workspace):
    channel_name = workspace["channel"]["name"]
    beta_join = client.post("/v1/join", json={
        "agent_name": "agent-beta",
        "token": workspace["token"],
        "network": workspace["id"],
    })
    assert beta_join.status_code == 200
    beta_session = beta_join.json()["data"]["session_id"]

    created = client.post("/v1/workspace-tasks", json={
        "network": workspace["id"],
        "channel": channel_name,
        "title": "Review module boundaries",
        "source": "openagents:agent-alpha",
    }, headers={"X-Workspace-Token": workspace["token"]})
    assert created.status_code == 200
    task = created.json()["data"]["task"]
    assert task["assignee"] is None

    updated = client.patch(f"/v1/workspace-tasks/{task['id']}", json={
        "network": workspace["id"],
        "source": "openagents:agent-alpha",
        "assignee": "@agent-beta",
    }, headers={"X-Workspace-Token": workspace["token"]})
    assert updated.status_code == 200
    assert updated.json()["data"]["task"]["assignee"] == "agent-beta"

    pending = client.get("/v1/agent-deliveries/pending", params={
        "network": workspace["id"],
        "agent": "agent-beta",
        "session_id": beta_session,
    }, headers={"X-Workspace-Token": workspace["token"]})
    assert pending.status_code == 200
    deliveries = pending.json()["data"]["deliveries"]
    assert len(deliveries) == 1
    assert deliveries[0]["delivery_kind"] == "attention"
    assert deliveries[0]["event"]["payload"]["content"].startswith("@agent-beta Workspace task updated:")
    assert deliveries[0]["event"]["metadata"]["target_agents"] == ["agent-beta"]


def test_workspace_task_update_with_unknown_source_uses_claimed_agent(client, workspace):
    channel_name = workspace["channel"]["name"]
    beta_join = client.post("/v1/join", json={
        "agent_name": "agent-beta",
        "token": workspace["token"],
        "network": workspace["id"],
    })
    assert beta_join.status_code == 200
    beta_session = beta_join.json()["data"]["session_id"]

    created = client.post("/v1/workspace-tasks", json={
        "network": workspace["id"],
        "channel": channel_name,
        "title": "QA复核：全模块性能、规范、依赖边界",
        "assignee": "agent-beta",
        "source": "openagents:agent-alpha",
    }, headers={"X-Workspace-Token": workspace["token"]})
    assert created.status_code == 200
    task = created.json()["data"]["task"]

    claimed = client.post(f"/v1/workspace-tasks/{task['id']}/claim", json={
        "network": workspace["id"],
        "agent_name": "agent-beta",
        "session_id": beta_session,
    }, headers={"X-Workspace-Token": workspace["token"]})
    assert claimed.status_code == 200

    completed = client.patch(f"/v1/workspace-tasks/{task['id']}", json={
        "network": workspace["id"],
        "status": "done",
        "result": "All modules passed.",
    }, headers={"X-Workspace-Token": workspace["token"]})
    assert completed.status_code == 200

    events = client.get("/v1/events", params={
        "network": workspace["id"],
        "type": "workspace.message.posted",
    }, headers={"X-Workspace-Token": workspace["token"]})
    assert events.status_code == 200
    completed_events = [
        event for event in events.json()["data"]["events"]
        if event["payload"].get("message_type") == "task"
        and "Workspace task completed:" in event["payload"].get("content", "")
    ]
    assert completed_events[-1]["source"] == "openagents:agent-beta"
    assert completed_events[-1]["source"] != "openagents:unknown"


def test_workspace_task_normalizes_openagents_prefixed_chinese_assignee(client, workspace):
    channel_name = workspace["channel"]["name"]
    agent_name = "博丽灵梦"
    join = client.post("/v1/join", json={
        "agent_name": agent_name,
        "token": workspace["token"],
        "network": workspace["id"],
    })
    assert join.status_code == 200
    session_id = join.json()["data"]["session_id"]

    join_channel = client.post("/v1/events", json={
        "type": "network.channel.join",
        "source": "human:user1",
        "target": f"channel/{channel_name}",
        "payload": {"channel": channel_name, "agent_name": agent_name},
        "network": workspace["id"],
    }, headers={"X-Workspace-Token": workspace["token"]})
    assert join_channel.status_code == 200

    created = client.post("/v1/workspace-tasks", json={
        "network": workspace["id"],
        "channel": channel_name,
        "title": "QA复核：全模块性能、规范、依赖边界",
        "assignee": "openagents:博丽灵梦",
        "source": "openagents:八云紫",
    }, headers={"X-Workspace-Token": workspace["token"]})
    assert created.status_code == 200
    task = created.json()["data"]["task"]
    assert task["assignee"] == agent_name

    listed = client.get("/v1/workspace-tasks", params={
        "network": workspace["id"],
        "channel": channel_name,
        "assignee": "openagents:博丽灵梦",
        "active": True,
    }, headers={"X-Workspace-Token": workspace["token"]})
    assert listed.status_code == 200
    assert [t["id"] for t in listed.json()["data"]["tasks"]] == [task["id"]]

    pending = client.get("/v1/agent-deliveries/pending", params={
        "network": workspace["id"],
        "agent": agent_name,
        "session_id": session_id,
    }, headers={"X-Workspace-Token": workspace["token"]})
    assert pending.status_code == 200
    deliveries = pending.json()["data"]["deliveries"]
    assert len(deliveries) == 1
    assert deliveries[0]["delivery_kind"] == "attention"
    assert deliveries[0]["event"]["payload"]["content"].startswith("@博丽灵梦 Workspace task created:")
    assert "@openagents:" not in deliveries[0]["event"]["payload"]["content"]
    assert deliveries[0]["event"]["metadata"]["target_agents"] == ["博丽灵梦"]


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
