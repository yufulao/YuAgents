# -*- coding: utf-8 -*-
"""
Shared workspace task endpoints.

These are the multi-agent ownership contract. They complement, but do not
replace, per-agent todos: todos are private planning state; workspace_tasks are
shared assignment/claim/result state.
"""

from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, Header, Query
from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import WorkspaceMember, WorkspaceTask
from app.response import ResponseCode, json_response, success_response
from app.routers.network import _emit_event, _resolve_workspace, _verify_workspace_access
from openagents.core.onm_events import Event


router = APIRouter(prefix="/v1", tags=["Workspace Tasks"])

TASK_STATUSES = {"todo", "in_progress", "in_review", "done", "cancelled"}
TASK_PRIORITIES = {"low", "normal", "high", "urgent"}


class CreateWorkspaceTaskRequest(BaseModel):
    network: str
    title: str = Field(min_length=1, max_length=500)
    channel: Optional[str] = None
    description: Optional[str] = None
    assignee: Optional[str] = None
    priority: str = "normal"
    status: str = "todo"
    depends_on: List[str] = Field(default_factory=list)
    parent_task_id: Optional[str] = None
    source: str = "openagents:unknown"


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
    accepted_by: Optional[str] = None


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _agent_source(agent_name: str) -> str:
    return agent_name if agent_name.startswith("openagents:") else f"openagents:{agent_name}"


def _agent_name_from_source(source: str) -> str:
    return source[len("openagents:"):] if source.startswith("openagents:") else source


def _normalize_agent_name(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    name = value.strip()
    if name.startswith("@"):
        name = name[1:].strip()
    return name or None


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


async def _emit_task_event(db: Session, workspace, task: WorkspaceTask, action: str, source: str, token: Optional[str]):
    channel = task.channel_name or "default"
    assignee = _normalize_agent_name(task.assignee)
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

    now = _utcnow()
    task = WorkspaceTask(
        workspace_id=str(workspace.id),
        channel_name=body.channel,
        parent_task_id=body.parent_task_id,
        title=body.title.strip(),
        description=body.description,
        status=body.status,
        priority=body.priority,
        assignee=_normalize_agent_name(body.assignee),
        created_by=body.source,
        depends_on=body.depends_on or [],
        updated_at=now,
    )
    if task.status == "done":
        task.completed_at = now
    db.add(task)
    db.flush()
    await _emit_task_event(db, workspace, task, "created", body.source, x_workspace_token)
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
    if assignee:
        query = query.where(or_(WorkspaceTask.assignee == assignee, WorkspaceTask.claimed_by == assignee))
    if created_by:
        query = query.where(WorkspaceTask.created_by == created_by)
    if active:
        query = query.where(WorkspaceTask.status.in_(["todo", "in_progress", "in_review"]))
    rows = db.execute(
        query.order_by(WorkspaceTask.created_at.asc(), WorkspaceTask.id.asc()).limit(limit)
    ).scalars().all()
    return success_response({"tasks": [_serialize_task(t) for t in rows]})


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
    if body.session_id and not _current_agent_session(db, str(workspace.id), body.agent_name, body.session_id):
        return json_response(ResponseCode.UNAUTHORIZED, "session_revoked: current agent session required")

    task = db.get(WorkspaceTask, task_id)
    if not task or str(task.workspace_id) != str(workspace.id):
        return json_response(ResponseCode.NOT_FOUND, "Task not found")
    if task.status in {"done", "cancelled"}:
        return json_response(ResponseCode.CONFLICT, "Task is already closed")
    if task.claimed_by and task.claimed_by != body.agent_name:
        return json_response(ResponseCode.CONFLICT, f"Task already claimed by {task.claimed_by}")

    now = _utcnow()
    task.claimed_by = body.agent_name
    task.claimed_at = task.claimed_at or now
    task.assignee = task.assignee or body.agent_name
    task.status = "in_progress" if task.status == "todo" else task.status
    task.updated_at = now
    db.flush()
    await _emit_task_event(db, workspace, task, "claimed", _agent_source(body.agent_name), x_workspace_token)
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
        task.assignee = _normalize_agent_name(body.assignee)
    if body.description is not None:
        task.description = body.description
    if body.result is not None:
        task.result = body.result
    if body.depends_on is not None:
        task.depends_on = body.depends_on
    if body.accepted_by is not None:
        task.accepted_by = body.accepted_by
    if not task.claimed_by and body.source.startswith("openagents:") and task.status == "in_progress":
        task.claimed_by = _agent_name_from_source(body.source)
        task.claimed_at = now
    task.updated_at = now

    action = "completed" if task.status == "done" else "updated"
    db.flush()
    await _emit_task_event(db, workspace, task, action, body.source, x_workspace_token)
    db.commit()
    return success_response({"task": _serialize_task(task)})
