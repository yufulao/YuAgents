# -*- coding: utf-8 -*-
"""Tests for hierarchical workspace plan checkpoints."""

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
        "source": "openagents:agent-alpha",
        "objective": "Drive ENG-200 until all delegated lanes finish.",
        "stop_condition": "Parent task is done or explicitly blocked with evidence.",
        "checkpoint": "Create A/B/QA lanes.",
        "cadence_seconds": 120,
    }, headers={"X-Workspace-Token": workspace["token"]})
    assert created.status_code == 200
    goal = created.json()["data"]["goal"]
    assert goal["status"] == "active"
    assert goal["coordinator"] == "agent-alpha"
    assert goal["plan_level"] == "root_plan"
    assert goal["continuation_policy"] == "long_horizon"
    assert goal["root_goal_id"] == goal["id"]
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
    assert any("hierarchical" in rule.lower() for rule in context.json()["data"]["runtime_rules"])

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
        "source": "openagents:agent-alpha",
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


def test_human_cannot_create_workspace_goal_for_agent(client, workspace):
    channel_name = workspace["channel"]["name"]
    join = client.post("/v1/join", json={
        "agent_name": "agent-alpha",
        "token": workspace["token"],
        "network": workspace["id"],
    })
    assert join.status_code == 200

    created = client.post("/v1/workspace-goals", json={
        "network": workspace["id"],
        "channel": channel_name,
        "coordinator": "agent-alpha",
        "source": "human:user1",
        "objective": "Keep coordinating until release is green.",
        "stop_condition": "Release checks passed.",
        "cadence_seconds": 60,
    }, headers={"X-Workspace-Token": workspace["token"]})
    assert created.status_code == 400
    assert created.json()["code"] == 400
    assert "source must match" in created.json()["message"]


def test_child_plan_completion_resumes_parent_plan(client, workspace, db):
    from app.models import WorkspaceGoal

    channel_name = workspace["channel"]["name"]
    join = client.post("/v1/join", json={
        "agent_name": "agent-alpha",
        "token": workspace["token"],
        "network": workspace["id"],
    })
    assert join.status_code == 200
    session_id = join.json()["data"]["session_id"]

    root = client.post("/v1/workspace-goals", json={
        "network": workspace["id"],
        "channel": channel_name,
        "coordinator": "agent-alpha",
        "source": "openagents:agent-alpha",
        "objective": "Finish the whole L0/L1 plan.",
        "stop_condition": "All plan refs exhausted.",
        "plan_level": "root_plan",
        "plan_refs": ["docs/LONG_PLAN.md"],
        "cadence_seconds": 300,
    }, headers={"X-Workspace-Token": workspace["token"]})
    assert root.status_code == 200
    root_goal = root.json()["data"]["goal"]

    root_row = db.get(WorkspaceGoal, root_goal["id"])
    root_row.next_run_at = datetime.now(timezone.utc) + timedelta(hours=1)
    root_row.lease_owner_session_id = "stale-session"
    root_row.lease_until = datetime.now(timezone.utc) + timedelta(hours=1)
    db.commit()

    child = client.post("/v1/workspace-goals", json={
        "network": workspace["id"],
        "channel": channel_name,
        "coordinator": "agent-alpha",
        "source": "openagents:agent-alpha",
        "parent_goal_id": root_goal["id"],
        "objective": "Implement and VQ the next short plan.",
        "stop_condition": "Evidence accepted.",
        "cadence_seconds": 120,
    }, headers={"X-Workspace-Token": workspace["token"]})
    assert child.status_code == 200
    child_goal = child.json()["data"]["goal"]
    assert child_goal["plan_level"] == "short_plan"
    assert child_goal["continuation_policy"] == "return_to_parent"
    assert child_goal["root_goal_id"] == root_goal["id"]

    completed = client.patch(f"/v1/workspace-goals/{child_goal['id']}", json={
        "network": workspace["id"],
        "source": "openagents:agent-alpha",
        "status": "done",
        "progress_log": "Short plan evidence accepted.",
    }, headers={"X-Workspace-Token": workspace["token"]})
    assert completed.status_code == 200

    db.expire_all()
    resumed = db.get(WorkspaceGoal, root_goal["id"])
    resumed_next = resumed.next_run_at
    if resumed_next.tzinfo is None:
        resumed_next = resumed_next.replace(tzinfo=timezone.utc)
    assert resumed_next <= datetime.now(timezone.utc)
    assert resumed.lease_owner_session_id is None
    assert resumed.lease_until is None

    claimed = client.post("/v1/workspace-goals/claim-due", json={
        "network": workspace["id"],
        "coordinator": "agent-alpha",
        "session_id": session_id,
        "channel": channel_name,
    }, headers={"X-Workspace-Token": workspace["token"]})
    assert claimed.status_code == 200
    assert claimed.json()["data"]["goal"]["id"] == root_goal["id"]


def test_long_horizon_plan_cannot_close_with_active_child_plan(client, workspace):
    channel_name = workspace["channel"]["name"]
    join = client.post("/v1/join", json={
        "agent_name": "agent-alpha",
        "token": workspace["token"],
        "network": workspace["id"],
    })
    assert join.status_code == 200

    root = client.post("/v1/workspace-goals", json={
        "network": workspace["id"],
        "channel": channel_name,
        "coordinator": "agent-alpha",
        "source": "openagents:agent-alpha",
        "objective": "Finish the whole L0/L1 plan.",
        "stop_condition": "All plan refs exhausted.",
        "plan_level": "root_plan",
    }, headers={"X-Workspace-Token": workspace["token"]})
    assert root.status_code == 200
    root_goal = root.json()["data"]["goal"]

    child = client.post("/v1/workspace-goals", json={
        "network": workspace["id"],
        "channel": channel_name,
        "coordinator": "agent-alpha",
        "source": "openagents:agent-alpha",
        "parent_goal_id": root_goal["id"],
        "objective": "Short child plan.",
        "stop_condition": "Evidence accepted.",
    }, headers={"X-Workspace-Token": workspace["token"]})
    assert child.status_code == 200

    closed = client.patch(f"/v1/workspace-goals/{root_goal['id']}", json={
        "network": workspace["id"],
        "source": "openagents:agent-alpha",
        "status": "done",
        "progress_log": "Trying to close early.",
    }, headers={"X-Workspace-Token": workspace["token"]})
    assert closed.status_code == 409
    assert "child plans are active" in closed.json()["message"]


def test_last_root_plan_requires_successor_or_global_exhaustion(client, workspace):
    channel_name = workspace["channel"]["name"]
    join = client.post("/v1/join", json={
        "agent_name": "agent-alpha",
        "token": workspace["token"],
        "network": workspace["id"],
    })
    assert join.status_code == 200

    root = client.post("/v1/workspace-goals", json={
        "network": workspace["id"],
        "channel": channel_name,
        "coordinator": "agent-alpha",
        "source": "openagents:agent-alpha",
        "objective": "Finish the current spine.",
        "stop_condition": "Current spine refs exhausted.",
        "plan_level": "root_plan",
        "continuation_policy": "long_horizon",
        "plan_refs": ["RTSPINE-A"],
    }, headers={"X-Workspace-Token": workspace["token"]})
    assert root.status_code == 200
    root_goal = root.json()["data"]["goal"]

    closed_without_successor = client.patch(f"/v1/workspace-goals/{root_goal['id']}", json={
        "network": workspace["id"],
        "source": "openagents:agent-alpha",
        "status": "done",
        "progress_log": "LONG_PLAN_EXHAUSTED for this narrow spine.",
    }, headers={"X-Workspace-Token": workspace["token"]})
    assert closed_without_successor.status_code == 409
    assert "successor active plan or GLOBAL_WORK_EXHAUSTED" in closed_without_successor.json()["message"]

    successor = client.post("/v1/workspace-goals", json={
        "network": workspace["id"],
        "channel": channel_name,
        "coordinator": "agent-alpha",
        "source": "openagents:agent-alpha",
        "objective": "Continue the next spine.",
        "stop_condition": "Next spine refs exhausted.",
        "plan_level": "root_plan",
        "continuation_policy": "long_horizon",
        "plan_refs": ["RTSPINE-B"],
    }, headers={"X-Workspace-Token": workspace["token"]})
    assert successor.status_code == 200

    closed_with_successor = client.patch(f"/v1/workspace-goals/{root_goal['id']}", json={
        "network": workspace["id"],
        "source": "openagents:agent-alpha",
        "status": "done",
        "progress_log": "Current spine exhausted; successor root is active.",
    }, headers={"X-Workspace-Token": workspace["token"]})
    assert closed_with_successor.status_code == 200
    assert closed_with_successor.json()["data"]["goal"]["status"] == "done"


def test_last_root_plan_can_close_with_global_exhaustion(client, workspace):
    channel_name = workspace["channel"]["name"]
    join = client.post("/v1/join", json={
        "agent_name": "agent-alpha",
        "token": workspace["token"],
        "network": workspace["id"],
    })
    assert join.status_code == 200

    root = client.post("/v1/workspace-goals", json={
        "network": workspace["id"],
        "channel": channel_name,
        "coordinator": "agent-alpha",
        "source": "openagents:agent-alpha",
        "objective": "Finish the whole project plan.",
        "stop_condition": "Whole channel objective exhausted.",
        "plan_level": "root_plan",
        "continuation_policy": "long_horizon",
        "plan_refs": ["docs/LONG_PLAN.md"],
    }, headers={"X-Workspace-Token": workspace["token"]})
    assert root.status_code == 200
    root_goal = root.json()["data"]["goal"]

    closed = client.patch(f"/v1/workspace-goals/{root_goal['id']}", json={
        "network": workspace["id"],
        "source": "openagents:agent-alpha",
        "status": "done",
        "progress_log": "GLOBAL_WORK_EXHAUSTED: every long-plan frontier is complete with evidence.",
    }, headers={"X-Workspace-Token": workspace["token"]})
    assert closed.status_code == 200
    assert closed.json()["data"]["goal"]["status"] == "done"
