# -*- coding: utf-8 -*-
"""Tests for durable coordinator workspace goals."""

from datetime import datetime, timedelta, timezone


def test_create_context_and_claim_due_workspace_goal(client, workspace):
    channel_name = workspace["channel"]["name"]
    join = client.post("/v1/join", json={
        "agent_name": "agent-alpha",
        "token": workspace["token"],
        "network": workspace["id"],
    })
    assert join.status_code == 200
    session_id = join.json()["data"]["session_id"]

    created = client.post("/v1/workspace-goals", json={
        "network": workspace["id"],
        "channel": channel_name,
        "coordinator": "agent-alpha",
        "source": "human:user1",
        "objective": "Drive ENG-200 until all delegated lanes finish.",
        "stop_condition": "Parent task is done or explicitly blocked with evidence.",
        "checkpoint": "Create A/B/QA lanes.",
        "cadence_seconds": 120,
    }, headers={"X-Workspace-Token": workspace["token"]})
    assert created.status_code == 200
    goal = created.json()["data"]["goal"]
    assert goal["status"] == "active"
    assert goal["coordinator"] == "agent-alpha"
    assert goal["run_count"] == 0

    context = client.get("/v1/agent-context", params={
        "network": workspace["id"],
        "agent": "agent-alpha",
        "session_id": session_id,
        "channel": channel_name,
    }, headers={"X-Workspace-Token": workspace["token"]})
    assert context.status_code == 200
    goals = context.json()["data"]["active_goals"]
    assert any(g["id"] == goal["id"] and "ENG-200" in g["objective"] for g in goals)
    assert any("workspace goals" in rule.lower() for rule in context.json()["data"]["runtime_rules"])

    claimed = client.post("/v1/workspace-goals/claim-due", json={
        "network": workspace["id"],
        "coordinator": "agent-alpha",
        "session_id": session_id,
        "channel": channel_name,
        "lease_seconds": 600,
    }, headers={"X-Workspace-Token": workspace["token"]})
    assert claimed.status_code == 200
    claimed_goal = claimed.json()["data"]["goal"]
    assert claimed_goal["id"] == goal["id"]
    assert claimed_goal["run_count"] == 1
    assert claimed_goal["last_run_at"] is not None
    assert claimed_goal["lease_until"] is not None

    second_claim = client.post("/v1/workspace-goals/claim-due", json={
        "network": workspace["id"],
        "coordinator": "agent-alpha",
        "session_id": session_id,
        "channel": channel_name,
    }, headers={"X-Workspace-Token": workspace["token"]})
    assert second_claim.status_code == 200
    assert second_claim.json()["data"]["goal"] is None


def test_paused_workspace_goal_does_not_claim_due(client, workspace, db):
    from app.models import WorkspaceGoal

    channel_name = workspace["channel"]["name"]
    join = client.post("/v1/join", json={
        "agent_name": "agent-alpha",
        "token": workspace["token"],
        "network": workspace["id"],
    })
    assert join.status_code == 200
    session_id = join.json()["data"]["session_id"]

    created = client.post("/v1/workspace-goals", json={
        "network": workspace["id"],
        "channel": channel_name,
        "coordinator": "agent-alpha",
        "source": "human:user1",
        "objective": "Keep coordinating until release is green.",
        "stop_condition": "Release checks passed.",
        "cadence_seconds": 60,
    }, headers={"X-Workspace-Token": workspace["token"]})
    assert created.status_code == 200
    goal_id = created.json()["data"]["goal"]["id"]

    paused = client.patch(f"/v1/workspace-goals/{goal_id}", json={
        "network": workspace["id"],
        "source": "openagents:agent-alpha",
        "status": "paused",
        "checkpoint": "Paused by coordinator.",
    }, headers={"X-Workspace-Token": workspace["token"]})
    assert paused.status_code == 200
    assert paused.json()["data"]["goal"]["status"] == "paused"

    goal_row = db.get(WorkspaceGoal, goal_id)
    goal_row.next_run_at = datetime.now(timezone.utc) - timedelta(minutes=5)
    db.commit()

    claimed = client.post("/v1/workspace-goals/claim-due", json={
        "network": workspace["id"],
        "coordinator": "agent-alpha",
        "session_id": session_id,
        "channel": channel_name,
    }, headers={"X-Workspace-Token": workspace["token"]})
    assert claimed.status_code == 200
    assert claimed.json()["data"]["goal"] is None

    listed = client.get("/v1/workspace-goals", params={
        "network": workspace["id"],
        "channel": channel_name,
        "coordinator": "agent-alpha",
        "active": True,
    }, headers={"X-Workspace-Token": workspace["token"]})
    assert listed.status_code == 200
    assert [g["id"] for g in listed.json()["data"]["goals"]] == [goal_id]
