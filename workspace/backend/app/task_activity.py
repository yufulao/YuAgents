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
    status_by_id = {str(task.id): task.status for task in tasks}
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
        waiting = any(
            status_by_id.get(dep) not in DONE_DEPENDENCY_STATUSES
            for dep in _parse_depends_on(task.depends_on)
            if dep in status_by_id
        )
        by_agent[agent_name] = AgentTaskActivity(task=task, waiting_on_dependency=waiting)
    return by_agent


def active_task_activity_for_agent(db: Session, workspace_id: str, agent_name: str) -> AgentTaskActivity | None:
    return active_task_activity_by_agent(db, workspace_id).get(agent_name)


def task_activity_summary(activity: AgentTaskActivity) -> str:
    task = activity.task
    prefix = "等待依赖" if activity.waiting_on_dependency else "进行中"
    return f"{prefix}: {task.title}"


def task_activity_payload(activity: AgentTaskActivity | None) -> dict[str, Any] | None:
    if activity is None:
        return None
    task = activity.task
    return {
        "id": task.id,
        "title": task.title,
        "status": task.status,
        "assignee": task.assignee,
        "claimed_by": task.claimed_by,
        "channel_name": task.channel_name,
        "waiting_on_dependency": activity.waiting_on_dependency,
        "updated_at": task.updated_at.isoformat() if task.updated_at else None,
    }
