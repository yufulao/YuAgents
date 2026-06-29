# -*- coding: utf-8 -*-
"""
Shared workspace task endpoints.

These are the multi-agent ownership contract. They complement, but do not
replace, per-agent todos: todos are private planning state; workspace_tasks are
shared assignment/claim/result state.
"""

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, Header, Query
from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Channel, ChannelMember, WorkspaceMember, WorkspaceTask
from app.response import ResponseCode, json_response, success_response
from app.routers.network import _emit_event, _resolve_workspace, _verify_workspace_access
from openagents.core.onm_events import Event


router = APIRouter(prefix="/v1", tags=["Workspace Tasks"])

TASK_STATUSES = {"todo", "in_progress", "in_review", "done", "cancelled"}
TASK_PRIORITIES = {"low", "normal", "high", "urgent"}
TASK_LANE_TYPES = {"unspecified", "coordination", "read_only", "write", "verification", "handoff"}


class CreateWorkspaceTaskRequest(BaseModel):
    network: str
    title: str = Field(min_length=1, max_length=500)
    channel: Optional[str] = None
    description: Optional[str] = None
    assignee: Optional[str] = None
    priority: str = "normal"
    status: str = "todo"
    depends_on: List[str] = Field(default_factory=list)
    lane_type: str = "unspecified"
    write_scope: List[str] = Field(default_factory=list)
    resource_locks: List[str] = Field(default_factory=list)
    conflicts_with: List[str] = Field(default_factory=list)
    commit_policy: Dict[str, Any] = Field(default_factory=dict)
    parent_task_id: Optional[str] = None
    source: Optional[str] = None


class ClaimWorkspaceTaskRequest(BaseModel):
    network: str
    agent_name: str
    session_id: Optional[str] = None


class UpdateWorkspaceTaskRequest(BaseModel):
    network: str
    source: str = "openagents:unknown"
    status: Optional[str] = None
    assignee: Optional[str] = None
    priority: Optional[str] = None
    description: Optional[str] = None
    result: Optional[str] = None
    depends_on: Optional[List[str]] = None
    lane_type: Optional[str] = None
    write_scope: Optional[List[str]] = None
    resource_locks: Optional[List[str]] = None
    conflicts_with: Optional[List[str]] = None
    commit_policy: Optional[Dict[str, Any]] = None
    accepted_by: Optional[str] = None


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _agent_source(agent_name: str) -> str:
    return agent_name if agent_name.startswith("openagents:") else f"openagents:{agent_name}"


def _agent_name_from_source(source: str) -> str:
    return source[len("openagents:"):] if source.startswith("openagents:") else source


def _is_unknown_source(source: Optional[str]) -> bool:
    if not source:
        return True
    normalized = source.strip()
    return normalized in {"unknown", "openagents:unknown"}


def _normalize_agent_name(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    name = value.strip()
    if name.startswith("@"):
        name = name[1:].strip()
    if name.startswith("openagents:"):
        name = name[len("openagents:"):].strip()
    return name or None


def _normalize_string_list(values: Optional[List[str]]) -> List[str]:
    if not values:
        return []
    normalized: List[str] = []
    seen = set()
    for value in values:
        if not isinstance(value, str):
            continue
        item = value.strip()
        if not item or item in seen:
            continue
        seen.add(item)
        normalized.append(item)
    return normalized


def _task_lock_set(task: WorkspaceTask) -> set[str]:
    return set(_normalize_string_list(task.resource_locks or []))


def _task_conflict_summary(task: WorkspaceTask, active_tasks: List[WorkspaceTask]) -> dict:
    explicit_conflicts = set(_normalize_string_list(task.conflicts_with or []))
    locks = _task_lock_set(task)
    conflicts = []
    for other in active_tasks:
        if other.id == task.id:
            continue
        if other.status not in {"todo", "in_progress", "in_review"}:
            continue
        shared_locks = sorted(locks & _task_lock_set(other))
        explicit = other.id in explicit_conflicts or task.id in set(_normalize_string_list(other.conflicts_with or []))
        if shared_locks or explicit:
            conflicts.append({
                "task_id": other.id,
                "title": other.title,
                "status": other.status,
                "owner": other.claimed_by or other.assignee,
                "shared_locks": shared_locks,
                "explicit": explicit,
            })
    return {
        "conflicts": conflicts,
        "parallel_safe": not conflicts,
    }


def _blocking_active_task(db: Session, task: WorkspaceTask) -> Optional[dict]:
    active_tasks = db.execute(
        select(WorkspaceTask).where(
            WorkspaceTask.workspace_id == task.workspace_id,
            WorkspaceTask.status.in_(["in_progress", "in_review"]),
            WorkspaceTask.id != task.id,
        )
    ).scalars().all()
    summary = _task_conflict_summary(task, active_tasks)
    conflicts = summary.get("conflicts") or []
    return conflicts[0] if conflicts else None


def _resolve_task_event_source(task: WorkspaceTask, requested_source: Optional[str]) -> str:
    if not _is_unknown_source(requested_source):
        return requested_source.strip()
    if task.claimed_by:
        return _agent_source(task.claimed_by)
    if task.assignee:
        return _agent_source(task.assignee)
    if task.created_by and not _is_unknown_source(task.created_by):
        return task.created_by
    return "openagents:system"


def _serialize_task(task: WorkspaceTask) -> dict:
    return {
        "id": task.id,
        "workspace_id": str(task.workspace_id),
        "channel_name": task.channel_name,
        "parent_task_id": task.parent_task_id,
        "title": task.title,
        "description": task.description,
        "status": task.status,
        "priority": task.priority,
        "assignee": task.assignee,
        "claimed_by": task.claimed_by,
        "created_by": task.created_by,
        "result": task.result,
        "depends_on": task.depends_on or [],
        "lane_type": task.lane_type or "unspecified",
        "write_scope": task.write_scope or [],
        "resource_locks": task.resource_locks or [],
        "conflicts_with": task.conflicts_with or [],
        "commit_policy": task.commit_policy or {},
        "accepted_by": task.accepted_by,
        "created_at": task.created_at.isoformat() if task.created_at else None,
        "updated_at": task.updated_at.isoformat() if task.updated_at else None,
        "claimed_at": task.claimed_at.isoformat() if task.claimed_at else None,
        "completed_at": task.completed_at.isoformat() if task.completed_at else None,
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


def _resolve_active_channel_name(db: Session, workspace_id: str, channel: Optional[str]) -> Optional[str]:
    channel_name = (channel or "").strip()
    if not channel_name or channel_name == "default":
        return None
    record = db.execute(
        select(Channel).where(
            Channel.workspace_id == workspace_id,
            Channel.name == channel_name,
            Channel.status == "active",
        )
    ).scalar_one_or_none()
    return channel_name if record else None


def _ensure_assignee_channel_participant(
    db: Session,
    workspace_id: str,
    channel_name: Optional[str],
    assignee: Optional[str],
) -> bool:
    agent_name = _normalize_agent_name(assignee)
    if not agent_name:
        return True
    if not channel_name:
        return False
    member = db.execute(
        select(WorkspaceMember).where(
            WorkspaceMember.workspace_id == workspace_id,
            WorkspaceMember.agent_name == agent_name,
        )
    ).scalar_one_or_none()
    if not member:
        return False
    channel = db.execute(
        select(Channel).where(
            Channel.workspace_id == workspace_id,
            Channel.name == channel_name,
            Channel.status == "active",
        )
    ).scalar_one_or_none()
    if not channel:
        return False
    existing = db.get(ChannelMember, (channel.id, agent_name))
    if not existing:
        db.add(ChannelMember(channel_id=channel.id, agent_name=agent_name))
        db.flush()
    return True


async def _emit_task_event(db: Session, workspace, task: WorkspaceTask, action: str, source: str, token: Optional[str]):
    channel = task.channel_name or "default"
    assignee = _normalize_agent_name(task.assignee)
    _ensure_assignee_channel_participant(db, str(workspace.id), channel, assignee)
    mention = f"@{assignee} " if assignee and action in {"created", "updated"} else ""
    status = task.status or "todo"
    content = f"{mention}Workspace task {action}: [{status}] {task.title}"
    if task.result and action in {"updated", "completed"}:
        content += f"\nResult: {task.result[:500]}"
    event = Event(
        type="workspace.message.posted",
        source=source,
        target=f"channel/{channel}",
        payload={
            "content": content,
            "message_type": "task",
            "task": _serialize_task(task),
        },
        metadata={
            "workspace_task_id": task.id,
            "target_agents": [assignee] if assignee and action in {"created", "updated"} else [],
        },
    )
    await _emit_event(event, workspace, db, token=token)


@router.post("/workspace-tasks")
async def create_workspace_task(
    body: CreateWorkspaceTaskRequest,
    db: Session = Depends(get_db),
    x_workspace_token: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    workspace = _resolve_workspace(db, body.network)
    if not workspace:
        return json_response(ResponseCode.NOT_FOUND, "Network not found")
    if not _verify_workspace_access(workspace, x_workspace_token, authorization):
        return json_response(ResponseCode.UNAUTHORIZED, "Invalid credentials")
    if body.status not in TASK_STATUSES:
        return json_response(ResponseCode.BAD_REQUEST, "Invalid task status")
    if body.priority not in TASK_PRIORITIES:
        return json_response(ResponseCode.BAD_REQUEST, "Invalid task priority")
    if body.lane_type not in TASK_LANE_TYPES:
        return json_response(ResponseCode.BAD_REQUEST, "Invalid task lane_type")
    if _is_unknown_source(body.source):
        return json_response(ResponseCode.BAD_REQUEST, "source is required")
    channel_name = _resolve_active_channel_name(db, str(workspace.id), body.channel)
    if not channel_name:
        return json_response(ResponseCode.BAD_REQUEST, "channel is required and must reference an active channel")
    assignee = _normalize_agent_name(body.assignee)
    if assignee and not _ensure_assignee_channel_participant(db, str(workspace.id), channel_name, assignee):
        return json_response(ResponseCode.BAD_REQUEST, "assignee must be a workspace member in an active channel")

    now = _utcnow()
    created_by = body.source.strip()
    task = WorkspaceTask(
        workspace_id=str(workspace.id),
        channel_name=channel_name,
        parent_task_id=body.parent_task_id,
        title=body.title.strip(),
        description=body.description,
        status=body.status,
        priority=body.priority,
        assignee=assignee,
        created_by=created_by,
        depends_on=_normalize_string_list(body.depends_on),
        lane_type=body.lane_type,
        write_scope=_normalize_string_list(body.write_scope),
        resource_locks=_normalize_string_list(body.resource_locks),
        conflicts_with=_normalize_string_list(body.conflicts_with),
        commit_policy=body.commit_policy or {},
        updated_at=now,
    )
    if task.status == "done":
        task.completed_at = now
    db.add(task)
    db.flush()
    await _emit_task_event(db, workspace, task, "created", created_by, x_workspace_token)
    db.commit()
    return success_response({"task": _serialize_task(task)})


@router.get("/workspace-tasks")
def list_workspace_tasks(
    network: str = Query(...),
    channel: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    assignee: Optional[str] = Query(None),
    created_by: Optional[str] = Query(None),
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

    query = select(WorkspaceTask).where(WorkspaceTask.workspace_id == str(workspace.id))
    if channel:
        query = query.where(WorkspaceTask.channel_name == channel)
    if status:
        query = query.where(WorkspaceTask.status == status)
    normalized_assignee = _normalize_agent_name(assignee)
    if normalized_assignee:
        query = query.where(or_(WorkspaceTask.assignee == normalized_assignee, WorkspaceTask.claimed_by == normalized_assignee))
    if created_by:
        query = query.where(WorkspaceTask.created_by == created_by)
    if active:
        query = query.where(WorkspaceTask.status.in_(["todo", "in_progress", "in_review"]))
    rows = db.execute(
        query.order_by(WorkspaceTask.created_at.asc(), WorkspaceTask.id.asc()).limit(limit)
    ).scalars().all()
    serialized = []
    active_tasks = rows if active else db.execute(
        select(WorkspaceTask).where(
            WorkspaceTask.workspace_id == str(workspace.id),
            WorkspaceTask.status.in_(["todo", "in_progress", "in_review"]),
        )
    ).scalars().all()
    for task in rows:
        item = _serialize_task(task)
        item["scheduling"] = _task_conflict_summary(task, active_tasks)
        serialized.append(item)
    return success_response({"tasks": serialized})


@router.post("/workspace-tasks/{task_id}/claim")
async def claim_workspace_task(
    task_id: str,
    body: ClaimWorkspaceTaskRequest,
    db: Session = Depends(get_db),
    x_workspace_token: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    workspace = _resolve_workspace(db, body.network)
    if not workspace:
        return json_response(ResponseCode.NOT_FOUND, "Network not found")
    if not _verify_workspace_access(workspace, x_workspace_token, authorization):
        return json_response(ResponseCode.UNAUTHORIZED, "Invalid credentials")
    agent_name = _normalize_agent_name(body.agent_name) or body.agent_name
    if body.session_id and not _current_agent_session(db, str(workspace.id), agent_name, body.session_id):
        return json_response(ResponseCode.UNAUTHORIZED, "session_revoked: current agent session required")

    task = db.get(WorkspaceTask, task_id)
    if not task or str(task.workspace_id) != str(workspace.id):
        return json_response(ResponseCode.NOT_FOUND, "Task not found")
    if task.status in {"done", "cancelled"}:
        return json_response(ResponseCode.CONFLICT, "Task is already closed")
    if task.claimed_by and task.claimed_by != agent_name:
        return json_response(ResponseCode.CONFLICT, f"Task already claimed by {task.claimed_by}")
    if task.claimed_by == agent_name and task.status != "todo":
        return success_response({"task": _serialize_task(task)})
    blocker = _blocking_active_task(db, task)
    if blocker:
        shared = ", ".join(blocker.get("shared_locks") or [])
        detail = f"Task conflicts with active task {blocker['task_id']}"
        if shared:
            detail += f" on resource_locks: {shared}"
        return json_response(ResponseCode.CONFLICT, detail)

    now = _utcnow()
    task.claimed_by = agent_name
    task.claimed_at = task.claimed_at or now
    task.assignee = task.assignee or agent_name
    task.status = "in_progress" if task.status == "todo" else task.status
    task.updated_at = now
    db.flush()
    await _emit_task_event(db, workspace, task, "claimed", _agent_source(agent_name), x_workspace_token)
    db.commit()
    return success_response({"task": _serialize_task(task)})


@router.patch("/workspace-tasks/{task_id}")
async def update_workspace_task(
    task_id: str,
    body: UpdateWorkspaceTaskRequest,
    db: Session = Depends(get_db),
    x_workspace_token: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    workspace = _resolve_workspace(db, body.network)
    if not workspace:
        return json_response(ResponseCode.NOT_FOUND, "Network not found")
    if not _verify_workspace_access(workspace, x_workspace_token, authorization):
        return json_response(ResponseCode.UNAUTHORIZED, "Invalid credentials")

    task = db.get(WorkspaceTask, task_id)
    if not task or str(task.workspace_id) != str(workspace.id):
        return json_response(ResponseCode.NOT_FOUND, "Task not found")

    now = _utcnow()
    if body.status is not None:
        if body.status not in TASK_STATUSES:
            return json_response(ResponseCode.BAD_REQUEST, "Invalid task status")
        task.status = body.status
        if body.status == "done":
            task.completed_at = now
    if body.priority is not None:
        if body.priority not in TASK_PRIORITIES:
            return json_response(ResponseCode.BAD_REQUEST, "Invalid task priority")
        task.priority = body.priority
    if body.assignee is not None:
        assignee = _normalize_agent_name(body.assignee)
        if assignee and not _ensure_assignee_channel_participant(db, str(workspace.id), task.channel_name, assignee):
            return json_response(ResponseCode.BAD_REQUEST, "assignee must be a workspace member in an active channel")
        task.assignee = assignee
    if body.description is not None:
        task.description = body.description
    if body.result is not None:
        task.result = body.result
    if body.depends_on is not None:
        task.depends_on = _normalize_string_list(body.depends_on)
    if body.lane_type is not None:
        if body.lane_type not in TASK_LANE_TYPES:
            return json_response(ResponseCode.BAD_REQUEST, "Invalid task lane_type")
        task.lane_type = body.lane_type
    if body.write_scope is not None:
        task.write_scope = _normalize_string_list(body.write_scope)
    if body.resource_locks is not None:
        task.resource_locks = _normalize_string_list(body.resource_locks)
    if body.conflicts_with is not None:
        task.conflicts_with = _normalize_string_list(body.conflicts_with)
    if body.commit_policy is not None:
        task.commit_policy = body.commit_policy or {}
    if body.accepted_by is not None:
        task.accepted_by = body.accepted_by
    event_source = _resolve_task_event_source(task, body.source)
    if not task.claimed_by and event_source.startswith("openagents:") and task.status == "in_progress":
        task.claimed_by = _agent_name_from_source(event_source)
        task.claimed_at = now
    task.updated_at = now

    action = "completed" if task.status == "done" else "updated"
    db.flush()
    await _emit_task_event(db, workspace, task, action, event_source, x_workspace_token)
    db.commit()
    return success_response({"task": _serialize_task(task)})
