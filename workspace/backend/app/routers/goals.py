# -*- coding: utf-8 -*-
"""Durable workspace goal endpoints.

Goals are coordinator-owned run loops for long-running work. They are not
implementation subtasks; they tell the lead agent what objective to keep
driving, how to validate progress, and when to stop.
"""

from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, Header, Query
from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Channel, ChannelMember, WorkspaceGoal, WorkspaceMember
from app.response import ResponseCode, json_response, success_response
from app.routers.network import _emit_event, _resolve_workspace, _verify_workspace_access
from openagents.core.onm_events import Event


router = APIRouter(prefix="/v1", tags=["Workspace Goals"])

GOAL_STATUSES = {"active", "paused", "blocked", "done", "cancelled"}
ACTIVE_GOAL_STATUSES = {"active", "paused", "blocked"}


class CreateWorkspaceGoalRequest(BaseModel):
    network: str
    channel: str = Field(min_length=1)
    coordinator: str = Field(min_length=1)
    objective: str = Field(min_length=1, max_length=4000)
    stop_condition: str = Field(min_length=1, max_length=4000)
    checkpoint: Optional[str] = None
    progress_log: Optional[str] = None
    cadence_seconds: int = Field(default=300, ge=60, le=86400)
    source: str = Field(min_length=1)


class UpdateWorkspaceGoalRequest(BaseModel):
    network: str
    source: str = "openagents:unknown"
    status: Optional[str] = None
    objective: Optional[str] = None
    stop_condition: Optional[str] = None
    checkpoint: Optional[str] = None
    progress_log: Optional[str] = None
    cadence_seconds: Optional[int] = Field(default=None, ge=60, le=86400)
    next_run_seconds: Optional[int] = Field(default=None, ge=0, le=86400)


class ClaimDueWorkspaceGoalRequest(BaseModel):
    network: str
    coordinator: str = Field(min_length=1)
    session_id: str = Field(min_length=1)
    channel: Optional[str] = None
    lease_seconds: int = Field(default=900, ge=60, le=21600)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _normalize_agent_name(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    name = value.strip()
    if name.startswith("@"):
        name = name[1:].strip()
    if name.startswith("openagents:"):
        name = name[len("openagents:"):].strip()
    return name or None


def _is_unknown_source(source: Optional[str]) -> bool:
    if not source:
        return True
    normalized = source.strip()
    return normalized in {"unknown", "openagents:unknown"}


def _serialize_goal(goal: WorkspaceGoal) -> dict:
    return {
        "id": goal.id,
        "workspace_id": str(goal.workspace_id),
        "channel_name": goal.channel_name,
        "coordinator": goal.coordinator,
        "objective": goal.objective,
        "stop_condition": goal.stop_condition,
        "status": goal.status,
        "checkpoint": goal.checkpoint,
        "progress_log": goal.progress_log,
        "created_by": goal.created_by,
        "cadence_seconds": goal.cadence_seconds,
        "run_count": goal.run_count,
        "last_run_at": goal.last_run_at.isoformat() if goal.last_run_at else None,
        "next_run_at": goal.next_run_at.isoformat() if goal.next_run_at else None,
        "lease_until": goal.lease_until.isoformat() if goal.lease_until else None,
        "created_at": goal.created_at.isoformat() if goal.created_at else None,
        "updated_at": goal.updated_at.isoformat() if goal.updated_at else None,
        "completed_at": goal.completed_at.isoformat() if goal.completed_at else None,
    }


def _current_agent_session(db: Session, workspace_id: str, agent_name: str, session_id: Optional[str]) -> bool:
    if not agent_name or not session_id:
        return False
    member = db.execute(
        select(WorkspaceMember).where(
            WorkspaceMember.workspace_id == workspace_id,
            WorkspaceMember.agent_name == agent_name,
        )
    ).scalar_one_or_none()
    return bool(member and member.session_id and member.session_id == session_id)


def _resolve_active_channel(db: Session, workspace_id: str, channel_name: str) -> Optional[Channel]:
    return db.execute(
        select(Channel).where(
            Channel.workspace_id == workspace_id,
            Channel.name == channel_name,
            Channel.status == "active",
        )
    ).scalar_one_or_none()


def _ensure_coordinator_channel_participant(
    db: Session,
    workspace_id: str,
    channel_name: str,
    coordinator: str,
) -> bool:
    member = db.execute(
        select(WorkspaceMember).where(
            WorkspaceMember.workspace_id == workspace_id,
            WorkspaceMember.agent_name == coordinator,
        )
    ).scalar_one_or_none()
    if not member:
        return False
    channel = _resolve_active_channel(db, workspace_id, channel_name)
    if not channel:
        return False
    existing = db.get(ChannelMember, (channel.id, coordinator))
    if not existing:
        db.add(ChannelMember(channel_id=channel.id, agent_name=coordinator))
        db.flush()
    return True


async def _emit_goal_event(db: Session, workspace, goal: WorkspaceGoal, action: str, source: str, token: Optional[str]):
    content = f"@{goal.coordinator} Workspace goal {action}: [{goal.status}] {goal.objective}"
    if goal.checkpoint and action in {"updated", "claimed"}:
        content += f"\nCheckpoint: {goal.checkpoint[:500]}"
    event = Event(
        type="workspace.message.posted",
        source=source,
        target=f"channel/{goal.channel_name}",
        payload={
            "content": content,
            "message_type": "goal",
            "goal": _serialize_goal(goal),
        },
        metadata={
            "workspace_goal_id": goal.id,
            "target_agents": [goal.coordinator],
        },
    )
    await _emit_event(event, workspace, db, token=token)


@router.post("/workspace-goals")
async def create_workspace_goal(
    body: CreateWorkspaceGoalRequest,
    db: Session = Depends(get_db),
    x_workspace_token: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    workspace = _resolve_workspace(db, body.network)
    if not workspace:
        return json_response(ResponseCode.NOT_FOUND, "Network not found")
    if not _verify_workspace_access(workspace, x_workspace_token, authorization):
        return json_response(ResponseCode.UNAUTHORIZED, "Invalid credentials")
    if _is_unknown_source(body.source):
        return json_response(ResponseCode.BAD_REQUEST, "source is required")
    coordinator = _normalize_agent_name(body.coordinator)
    if not coordinator or not _ensure_coordinator_channel_participant(db, str(workspace.id), body.channel, coordinator):
        return json_response(ResponseCode.BAD_REQUEST, "coordinator must be a workspace member in an active channel")

    now = _utcnow()
    goal = WorkspaceGoal(
        workspace_id=str(workspace.id),
        channel_name=body.channel,
        coordinator=coordinator,
        objective=body.objective.strip(),
        stop_condition=body.stop_condition.strip(),
        checkpoint=body.checkpoint,
        progress_log=body.progress_log,
        created_by=body.source.strip(),
        cadence_seconds=body.cadence_seconds,
        next_run_at=now,
        updated_at=now,
    )
    db.add(goal)
    db.flush()
    await _emit_goal_event(db, workspace, goal, "created", body.source.strip(), x_workspace_token)
    db.commit()
    return success_response({"goal": _serialize_goal(goal)})


@router.get("/workspace-goals")
def list_workspace_goals(
    network: str = Query(...),
    channel: Optional[str] = Query(None),
    coordinator: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    active: bool = Query(False),
    limit: int = Query(100, ge=1, le=500),
    db: Session = Depends(get_db),
    x_workspace_token: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    workspace = _resolve_workspace(db, network)
    if not workspace:
        return json_response(ResponseCode.NOT_FOUND, "Network not found")
    if not _verify_workspace_access(workspace, x_workspace_token, authorization):
        return json_response(ResponseCode.UNAUTHORIZED, "Invalid credentials")

    query = select(WorkspaceGoal).where(WorkspaceGoal.workspace_id == str(workspace.id))
    if channel:
        query = query.where(WorkspaceGoal.channel_name == channel)
    normalized_coordinator = _normalize_agent_name(coordinator)
    if normalized_coordinator:
        query = query.where(WorkspaceGoal.coordinator == normalized_coordinator)
    if status:
        query = query.where(WorkspaceGoal.status == status)
    if active:
        query = query.where(WorkspaceGoal.status.in_(list(ACTIVE_GOAL_STATUSES)))
    rows = db.execute(
        query.order_by(WorkspaceGoal.created_at.asc(), WorkspaceGoal.id.asc()).limit(limit)
    ).scalars().all()
    return success_response({"goals": [_serialize_goal(g) for g in rows]})


@router.patch("/workspace-goals/{goal_id}")
async def update_workspace_goal(
    goal_id: str,
    body: UpdateWorkspaceGoalRequest,
    db: Session = Depends(get_db),
    x_workspace_token: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    workspace = _resolve_workspace(db, body.network)
    if not workspace:
        return json_response(ResponseCode.NOT_FOUND, "Network not found")
    if not _verify_workspace_access(workspace, x_workspace_token, authorization):
        return json_response(ResponseCode.UNAUTHORIZED, "Invalid credentials")

    goal = db.get(WorkspaceGoal, goal_id)
    if not goal or str(goal.workspace_id) != str(workspace.id):
        return json_response(ResponseCode.NOT_FOUND, "Goal not found")

    now = _utcnow()
    if body.status is not None:
        if body.status not in GOAL_STATUSES:
            return json_response(ResponseCode.BAD_REQUEST, "Invalid goal status")
        goal.status = body.status
        if body.status in {"done", "cancelled"}:
            goal.completed_at = now
        goal.lease_owner_session_id = None
        goal.lease_until = None
    if body.objective is not None:
        goal.objective = body.objective.strip()
    if body.stop_condition is not None:
        goal.stop_condition = body.stop_condition.strip()
    if body.checkpoint is not None:
        goal.checkpoint = body.checkpoint
    if body.progress_log is not None:
        goal.progress_log = body.progress_log
    if body.cadence_seconds is not None:
        goal.cadence_seconds = body.cadence_seconds
    if body.next_run_seconds is not None and goal.status == "active":
        goal.next_run_at = now + timedelta(seconds=body.next_run_seconds)
        goal.lease_owner_session_id = None
        goal.lease_until = None
    goal.updated_at = now

    source = body.source.strip() if not _is_unknown_source(body.source) else f"openagents:{goal.coordinator}"
    action = "completed" if goal.status in {"done", "cancelled"} else "updated"
    db.flush()
    await _emit_goal_event(db, workspace, goal, action, source, x_workspace_token)
    db.commit()
    return success_response({"goal": _serialize_goal(goal)})


@router.post("/workspace-goals/claim-due")
def claim_due_workspace_goal(
    body: ClaimDueWorkspaceGoalRequest,
    db: Session = Depends(get_db),
    x_workspace_token: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    workspace = _resolve_workspace(db, body.network)
    if not workspace:
        return json_response(ResponseCode.NOT_FOUND, "Network not found")
    if not _verify_workspace_access(workspace, x_workspace_token, authorization):
        return json_response(ResponseCode.UNAUTHORIZED, "Invalid credentials")
    coordinator = _normalize_agent_name(body.coordinator) or body.coordinator
    if not _current_agent_session(db, str(workspace.id), coordinator, body.session_id):
        return json_response(ResponseCode.UNAUTHORIZED, "session_revoked: current agent session required")

    now = _utcnow()
    query = select(WorkspaceGoal).where(
        WorkspaceGoal.workspace_id == str(workspace.id),
        WorkspaceGoal.coordinator == coordinator,
        WorkspaceGoal.status == "active",
        WorkspaceGoal.next_run_at <= now,
        or_(WorkspaceGoal.lease_until == None, WorkspaceGoal.lease_until <= now),  # noqa: E711
    )
    if body.channel:
        query = query.where(WorkspaceGoal.channel_name == body.channel)
    goal = db.execute(
        query.order_by(WorkspaceGoal.next_run_at.asc(), WorkspaceGoal.created_at.asc()).limit(1)
    ).scalar_one_or_none()
    if not goal:
        return success_response({"goal": None})

    goal.run_count = (goal.run_count or 0) + 1
    goal.last_run_at = now
    goal.next_run_at = now + timedelta(seconds=goal.cadence_seconds or 300)
    goal.lease_owner_session_id = body.session_id
    goal.lease_until = now + timedelta(seconds=body.lease_seconds)
    goal.updated_at = now
    db.commit()
    return success_response({"goal": _serialize_goal(goal)})
