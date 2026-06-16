# -*- coding: utf-8 -*-
"""Task-derived agent activity projection helpers."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import WorkspaceTask


ACTIVE_TASK_STATUSES = {"todo", "in_progress"}
DONE_DEPENDENCY_STATUSES = {"done", "cancelled"}


@dataclass(frozen=True)
class AgentTaskActivity:
    task: WorkspaceTask
    waiting_on_dependency: bool
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

    by_agent: dict[str, AgentTaskActivity] = {}
    for task in active_tasks:
        agent_name = task.claimed_by or task.assignee
        if not agent_name or agent_name in by_agent:
            continue
        dependencies = tuple(
            task_by_id[dep] for dep in _parse_depends_on(task.depends_on)
            if dep in task_by_id
        )
        waiting = any(dep.status not in DONE_DEPENDENCY_STATUSES for dep in dependencies)
        by_agent[agent_name] = AgentTaskActivity(
            task=task,
            waiting_on_dependency=waiting,
            dependencies=dependencies,
        )
    return by_agent


def active_task_activity_for_agent(db: Session, workspace_id: str, agent_name: str) -> AgentTaskActivity | None:
    return active_task_activity_by_agent(db, workspace_id).get(agent_name)


def task_activity_summary(activity: AgentTaskActivity) -> str:
    task = activity.task
    prefix = "等待依赖" if activity.waiting_on_dependency else "进行中"
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
