# -*- coding: utf-8 -*-
"""Task-derived agent activity projection helpers."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import TodoRecord, WorkspaceTask


ACTIVE_TASK_STATUSES = {"in_progress"}
DONE_DEPENDENCY_STATUSES = {"done", "cancelled"}
STALE_TASK_WAITING_AFTER = timedelta(minutes=30)
WAITING_TODO_MARKERS = (
    "wait",
    "wait for",
    "waiting for",
    "waiting",
    "blocked",
    "等待",
    "依赖",
    "阻塞",
)


@dataclass(frozen=True)
class AgentTaskActivity:
    task: WorkspaceTask
    waiting_on_dependency: bool
    waiting_reason: str | None = None
    dependencies: tuple[WorkspaceTask, ...] = ()


def _parse_depends_on(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [str(item) for item in value if item]
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return [value]
        if isinstance(parsed, list):
            return [str(item) for item in parsed if item]
    return []


def _sort_key(task: WorkspaceTask) -> tuple[int, datetime]:
    updated = task.updated_at if isinstance(task.updated_at, datetime) else datetime.min
    return (1 if task.status == "in_progress" else 0, updated)


def _naive_utc(value: datetime | None) -> datetime | None:
    if not isinstance(value, datetime):
        return None
    if value.tzinfo is None:
        return value
    return value.astimezone(timezone.utc).replace(tzinfo=None)


def _has_waiting_marker(*parts: Any) -> bool:
    text = "\n".join(str(part or "") for part in parts).lower()
    return any(marker in text for marker in WAITING_TODO_MARKERS)


def _is_stale_task(task: WorkspaceTask, now: datetime) -> bool:
    updated = (
        _naive_utc(task.updated_at)
        or _naive_utc(task.claimed_at)
        or _naive_utc(task.created_at)
    )
    if updated is None:
        return False
    return now - updated > STALE_TASK_WAITING_AFTER


def _waiting_todos_by_agent(db: Session, workspace_id: str) -> set[str]:
    rows = db.execute(
        select(TodoRecord).where(
            TodoRecord.workspace_id == str(workspace_id),
            TodoRecord.status.in_(("pending", "in_progress")),
        )
    ).scalars().all()
    waiting: set[str] = set()
    for todo in rows:
        agent = todo.assignee or (todo.created_by or "").replace("openagents:", "", 1)
        if agent and _has_waiting_marker(todo.content):
            waiting.add(agent)
    return waiting


def active_task_activity_by_agent(db: Session, workspace_id: str) -> dict[str, AgentTaskActivity]:
    tasks = db.execute(
        select(WorkspaceTask).where(WorkspaceTask.workspace_id == str(workspace_id))
    ).scalars().all()
    task_by_id = {str(task.id): task for task in tasks}
    active_tasks = [
        task for task in tasks
        if task.status in ACTIVE_TASK_STATUSES and (task.claimed_by or task.assignee)
    ]
    active_tasks.sort(key=_sort_key, reverse=True)
    waiting_todos = _waiting_todos_by_agent(db, workspace_id)
    now = datetime.utcnow()

    by_agent: dict[str, AgentTaskActivity] = {}
    for task in active_tasks:
        agent_name = task.claimed_by or task.assignee
        if not agent_name or agent_name in by_agent:
            continue
        dependencies = tuple(
            task_by_id[dep] for dep in _parse_depends_on(task.depends_on)
            if dep in task_by_id
        )
        has_pending_dependencies = any(dep.status not in DONE_DEPENDENCY_STATUSES for dep in dependencies)
        has_waiting_text = _has_waiting_marker(task.result, task.description, task.title)
        stale_task = _is_stale_task(task, now)
        waiting = has_pending_dependencies or agent_name in waiting_todos or has_waiting_text or stale_task
        waiting_reason = None
        if has_pending_dependencies or agent_name in waiting_todos:
            waiting_reason = "dependency"
        elif has_waiting_text:
            waiting_reason = "waiting"
        elif stale_task:
            waiting_reason = "stale"
        by_agent[agent_name] = AgentTaskActivity(
            task=task,
            waiting_on_dependency=waiting,
            waiting_reason=waiting_reason,
            dependencies=dependencies,
        )
    return by_agent


def active_task_activity_for_agent(db: Session, workspace_id: str, agent_name: str) -> AgentTaskActivity | None:
    return active_task_activity_by_agent(db, workspace_id).get(agent_name)


def task_activity_summary(activity: AgentTaskActivity) -> str:
    task = activity.task
    if activity.waiting_reason == "dependency":
        prefix = "等待依赖"
    elif activity.waiting_reason == "stale":
        prefix = "停滞"
    elif activity.waiting_on_dependency:
        prefix = "等待"
    else:
        prefix = "进行中"
    return f"{prefix}: {task.title}"


def _dependency_payload(task: WorkspaceTask, camel_case: bool) -> dict[str, Any]:
    if camel_case:
        return {
            "id": task.id,
            "title": task.title,
            "status": task.status,
            "assignee": task.assignee,
            "claimedBy": task.claimed_by,
            "updatedAt": task.updated_at.isoformat() if task.updated_at else None,
        }
    return {
        "id": task.id,
        "title": task.title,
        "status": task.status,
        "assignee": task.assignee,
        "claimed_by": task.claimed_by,
        "updated_at": task.updated_at.isoformat() if task.updated_at else None,
    }


def task_activity_payload(
    activity: AgentTaskActivity | None,
    *,
    camel_case: bool = False,
) -> dict[str, Any] | None:
    if activity is None:
        return None
    task = activity.task
    dependencies = [_dependency_payload(dep, camel_case) for dep in activity.dependencies]
    depends_on = _parse_depends_on(task.depends_on)
    if camel_case:
        return {
            "id": task.id,
            "title": task.title,
            "description": task.description,
            "status": task.status,
            "priority": task.priority,
            "assignee": task.assignee,
            "claimedBy": task.claimed_by,
            "createdBy": task.created_by,
            "channelName": task.channel_name,
            "waitingOnDependency": activity.waiting_on_dependency,
            "dependsOn": depends_on,
            "dependencies": dependencies,
            "result": task.result,
            "updatedAt": task.updated_at.isoformat() if task.updated_at else None,
            "claimedAt": task.claimed_at.isoformat() if task.claimed_at else None,
        }
    return {
        "id": task.id,
        "title": task.title,
        "description": task.description,
        "status": task.status,
        "priority": task.priority,
        "assignee": task.assignee,
        "claimed_by": task.claimed_by,
        "created_by": task.created_by,
        "channel_name": task.channel_name,
        "waiting_on_dependency": activity.waiting_on_dependency,
        "depends_on": depends_on,
        "dependencies": dependencies,
        "result": task.result,
        "updated_at": task.updated_at.isoformat() if task.updated_at else None,
        "claimed_at": task.claimed_at.isoformat() if task.claimed_at else None,
    }
