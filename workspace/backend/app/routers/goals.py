# -*- coding: utf-8 -*-
"""Durable workspace plan checkpoint endpoints.

The /workspace-goals path is kept for client compatibility, but the model is
hierarchical: a root/stage plan owns long-horizon state, short plans and
execution checkpoints can be children, and child completion wakes the parent
instead of letting the system stop at a flat short target.
"""

from datetime import datetime, timedelta, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, Header, Query
from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Channel, ChannelMember, WorkspaceGoal, WorkspaceMember, WorkspaceTask
from app.response import ResponseCode, json_response, success_response
from app.routers.network import _emit_event, _resolve_workspace, _verify_workspace_access
from openagents.core.onm_events import Event


router = APIRouter(prefix="/v1", tags=["Workspace Plans"])

GOAL_STATUSES = {"active", "paused", "blocked", "done", "cancelled"}
ACTIVE_GOAL_STATUSES = {"active", "paused", "blocked"}
PLAN_LEVELS = {"root_plan", "stage_plan", "short_plan", "execution"}
CONTINUATION_POLICIES = {"long_horizon", "return_to_parent", "standalone"}
PARENT_RESUME_STATUSES = {"done", "cancelled", "blocked"}
GLOBAL_EXHAUSTION_MARKERS = {"GLOBAL_WORK_EXHAUSTED", "PROJECT_WORK_EXHAUSTED"}


class CreateWorkspaceGoalRequest(BaseModel):
    network: str
    channel: str = Field(min_length=1)
    coordinator: str = Field(min_length=1)
    objective: str = Field(min_length=1, max_length=4000)
    stop_condition: str = Field(min_length=1, max_length=4000)
    checkpoint: Optional[str] = None
    progress_log: Optional[str] = None
    parent_goal_id: Optional[str] = None
    plan_level: Optional[str] = None
    continuation_policy: Optional[str] = None
    plan_refs: List[str] = Field(default_factory=list)
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
    plan_level: Optional[str] = None
    continuation_policy: Optional[str] = None
    plan_refs: Optional[List[str]] = None
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


def _clean_string_list(values: Optional[list], *, limit: int = 20, item_limit: int = 500) -> list[str]:
    cleaned: list[str] = []
    for value in values or []:
        text_value = str(value).strip()
        if not text_value:
            continue
        cleaned.append(text_value[:item_limit])
        if len(cleaned) >= limit:
            break
    return cleaned


def _default_plan_level(parent_goal_id: Optional[str], plan_level: Optional[str]) -> str:
    if plan_level:
        return plan_level.strip()
    return "short_plan" if parent_goal_id else "root_plan"


def _default_continuation_policy(plan_level: str, parent_goal_id: Optional[str], policy: Optional[str]) -> str:
    if policy:
        return policy.strip()
    if parent_goal_id:
        return "return_to_parent"
    if plan_level in {"root_plan", "stage_plan"}:
        return "long_horizon"
    return "standalone"


def _serialize_goal(goal: WorkspaceGoal) -> dict:
    return {
        "id": goal.id,
        "workspace_id": str(goal.workspace_id),
        "channel_name": goal.channel_name,
        "coordinator": goal.coordinator,
        "parent_goal_id": goal.parent_goal_id,
        "root_goal_id": goal.root_goal_id,
        "plan_level": goal.plan_level or "root_plan",
        "continuation_policy": goal.continuation_policy or "long_horizon",
        "plan_refs": goal.plan_refs or [],
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
    event_type_action = "closed" if action == "completed" else action
    event = Event(
        type=f"workspace.goal.{event_type_action}",
        source=source,
        target=f"channel/{goal.channel_name}",
        payload={
            "action": action,
            "goal": _serialize_goal(goal),
        },
        metadata={
            "workspace_goal_id": goal.id,
        },
    )
    await _emit_event(event, workspace, db, token=token)


def _active_child_goal_count(db: Session, goal: WorkspaceGoal) -> int:
    rows = db.execute(
        select(WorkspaceGoal).where(
            WorkspaceGoal.workspace_id == goal.workspace_id,
            WorkspaceGoal.parent_goal_id == goal.id,
            WorkspaceGoal.status.in_(list(ACTIVE_GOAL_STATUSES)),
        )
    ).scalars().all()
    return len(rows)


def _active_channel_task_count(db: Session, goal: WorkspaceGoal) -> int:
    rows = db.execute(
        select(WorkspaceTask).where(
            WorkspaceTask.workspace_id == goal.workspace_id,
            WorkspaceTask.channel_name == goal.channel_name,
            WorkspaceTask.status.in_(["todo", "in_progress", "in_review"]),
        )
    ).scalars().all()
    return len(rows)


def _other_active_channel_root_plan_count(db: Session, goal: WorkspaceGoal) -> int:
    rows = db.execute(
        select(WorkspaceGoal).where(
            WorkspaceGoal.workspace_id == goal.workspace_id,
            WorkspaceGoal.channel_name == goal.channel_name,
            WorkspaceGoal.status.in_(list(ACTIVE_GOAL_STATUSES)),
            WorkspaceGoal.parent_goal_id.is_(None),
            WorkspaceGoal.plan_level == "root_plan",
            WorkspaceGoal.continuation_policy == "long_horizon",
            WorkspaceGoal.id != goal.id,
        )
    ).scalars().all()
    return len(rows)


def _has_global_exhaustion_evidence(goal: WorkspaceGoal, body: UpdateWorkspaceGoalRequest) -> bool:
    parts = [
        body.checkpoint,
        body.progress_log,
        body.stop_condition,
        goal.checkpoint,
        goal.progress_log,
        goal.stop_condition,
    ]
    text = "\n".join(str(part or "") for part in parts).upper()
    return any(marker in text for marker in GLOBAL_EXHAUSTION_MARKERS)


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
    source_agent = _normalize_agent_name(body.source)
    if not coordinator or source_agent != coordinator:
        return json_response(ResponseCode.BAD_REQUEST, "source must match the goal owner agent")
    if not coordinator or not _ensure_coordinator_channel_participant(db, str(workspace.id), body.channel, coordinator):
        return json_response(ResponseCode.BAD_REQUEST, "coordinator must be a workspace member in an active channel")

    parent_goal = None
    if body.parent_goal_id:
        parent_goal = db.get(WorkspaceGoal, body.parent_goal_id)
        if not parent_goal or str(parent_goal.workspace_id) != str(workspace.id):
            return json_response(ResponseCode.NOT_FOUND, "Parent plan not found")
        if parent_goal.channel_name != body.channel or parent_goal.coordinator != coordinator:
            return json_response(ResponseCode.BAD_REQUEST, "parent plan must match channel and coordinator")
        if parent_goal.status in {"done", "cancelled"}:
            return json_response(ResponseCode.CONFLICT, "parent plan is already closed")

    plan_level = _default_plan_level(body.parent_goal_id, body.plan_level)
    if plan_level not in PLAN_LEVELS:
        return json_response(ResponseCode.BAD_REQUEST, "Invalid plan_level")
    continuation_policy = _default_continuation_policy(plan_level, body.parent_goal_id, body.continuation_policy)
    if continuation_policy not in CONTINUATION_POLICIES:
        return json_response(ResponseCode.BAD_REQUEST, "Invalid continuation_policy")

    now = _utcnow()
    goal = WorkspaceGoal(
        workspace_id=str(workspace.id),
        channel_name=body.channel,
        coordinator=coordinator,
        parent_goal_id=parent_goal.id if parent_goal else None,
        root_goal_id=(parent_goal.root_goal_id or parent_goal.id) if parent_goal else None,
        plan_level=plan_level,
        continuation_policy=continuation_policy,
        plan_refs=_clean_string_list(body.plan_refs),
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
    if not goal.root_goal_id:
        goal.root_goal_id = goal.id
        db.flush()
    await _emit_goal_event(db, workspace, goal, "created", body.source.strip(), x_workspace_token)
    db.commit()
    return success_response({"goal": _serialize_goal(goal)})


@router.get("/workspace-goals")
def list_workspace_goals(
    network: str = Query(...),
    channel: Optional[str] = Query(None),
    coordinator: Optional[str] = Query(None),
    parent_goal_id: Optional[str] = Query(None),
    root_goal_id: Optional[str] = Query(None),
    plan_level: Optional[str] = Query(None),
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
    if parent_goal_id:
        query = query.where(WorkspaceGoal.parent_goal_id == parent_goal_id)
    if root_goal_id:
        query = query.where(WorkspaceGoal.root_goal_id == root_goal_id)
    if plan_level:
        query = query.where(WorkspaceGoal.plan_level == plan_level)
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
    source_agent = _normalize_agent_name(body.source)
    if source_agent != goal.coordinator:
        return json_response(ResponseCode.BAD_REQUEST, "source must match the goal owner agent")

    now = _utcnow()
    if body.plan_level is not None:
        plan_level = body.plan_level.strip()
        if plan_level not in PLAN_LEVELS:
            return json_response(ResponseCode.BAD_REQUEST, "Invalid plan_level")
        goal.plan_level = plan_level
    if body.continuation_policy is not None:
        continuation_policy = body.continuation_policy.strip()
        if continuation_policy not in CONTINUATION_POLICIES:
            return json_response(ResponseCode.BAD_REQUEST, "Invalid continuation_policy")
        goal.continuation_policy = continuation_policy
    if body.plan_refs is not None:
        goal.plan_refs = _clean_string_list(body.plan_refs)

    parent_to_resume = None
    if body.status is not None:
        if body.status not in GOAL_STATUSES:
            return json_response(ResponseCode.BAD_REQUEST, "Invalid goal status")
        if body.status in {"done", "cancelled"} and (goal.plan_level or "root_plan") in {"root_plan", "stage_plan"}:
            active_children = _active_child_goal_count(db, goal)
            if active_children:
                return json_response(ResponseCode.CONFLICT, "Cannot close long-horizon plan while child plans are active")
            active_tasks = _active_channel_task_count(db, goal)
            if active_tasks:
                return json_response(ResponseCode.CONFLICT, "Cannot close long-horizon plan while channel tasks are active")
            if (
                body.status == "done"
                and (goal.plan_level or "root_plan") == "root_plan"
                and not goal.parent_goal_id
                and (goal.continuation_policy or "long_horizon") == "long_horizon"
                and not _other_active_channel_root_plan_count(db, goal)
                and not _has_global_exhaustion_evidence(goal, body)
            ):
                return json_response(
                    ResponseCode.CONFLICT,
                    "Cannot close the last active root plan without a successor active plan or GLOBAL_WORK_EXHAUSTED evidence",
                )
        goal.status = body.status
        if body.status in {"done", "cancelled"}:
            goal.completed_at = now
        goal.lease_owner_session_id = None
        goal.lease_until = None
        if body.status in PARENT_RESUME_STATUSES and goal.parent_goal_id:
            parent = db.get(WorkspaceGoal, goal.parent_goal_id)
            if parent and str(parent.workspace_id) == str(workspace.id) and parent.status == "active":
                parent.next_run_at = now
                parent.lease_owner_session_id = None
                parent.lease_until = None
                parent.updated_at = now
                parent_to_resume = parent
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

    source = body.source.strip()
    action = "completed" if goal.status in {"done", "cancelled"} else "updated"
    db.flush()
    await _emit_goal_event(db, workspace, goal, action, source, x_workspace_token)
    if parent_to_resume:
        await _emit_goal_event(db, workspace, parent_to_resume, "resumed", source, x_workspace_token)
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
