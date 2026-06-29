# -*- coding: utf-8 -*-
"""
ONM Event endpoints — the core of the event-native API.

POST /v1/events    Send any event into the mod pipeline
GET  /v1/events    Poll events (filter by after, target, channel, type)
"""

import asyncio
import hashlib
import json as _json
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, Header, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import and_, case, cast, func, or_, select, Text
from sqlalchemy.orm import Session

from app import cache
from app.channel_visibility import (
    apply_event_channel_visibility,
    human_email_from_authorization,
    visible_channel_names,
)
from app.database import get_db
from app.models import AgentDelivery, Channel, ChannelMember, EventRecord, Workspace, WorkspaceGoal, WorkspaceMember, WorkspaceTask
from app.pipeline_factory import pipeline
from app.response import ResponseCode, json_response, success_response
from app.routers.network import _verify_workspace_access, _workspace_filter
from openagents.core.onm_events import Event
from openagents.core.onm_mods import EventRejected, PipelineContext

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1", tags=["Events"])


_PROCESS_CONTEXT_MESSAGE_TYPES = {"status", "thinking", "todos"}
_DURABLE_CONTEXT_CONTENT_LIMIT = 500
_PROCESS_CONTEXT_CONTENT_LIMIT = 160
_HUMAN_MESSAGE_DEDUPE_WINDOW_MS = 120_000


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------

class SendEventRequest(BaseModel):
    type: str
    source: str
    target: str
    payload: Optional[dict] = None
    metadata: Optional[dict] = None
    visibility: Optional[str] = "channel"
    network: Optional[str] = None   # workspace ID or slug


class AckDeliveryRequest(BaseModel):
    network: str
    agent_name: str
    session_id: str
    status: str = "acked"
    error: Optional[str] = None


# ---------------------------------------------------------------------------
# POST /v1/events — send an event through the pipeline
# ---------------------------------------------------------------------------

def _extract_bearer(authorization: Optional[str]) -> Optional[str]:
    """Extract bearer token from Authorization header."""
    if authorization and authorization.lower().startswith("bearer "):
        return authorization[7:].strip()
    return None


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _current_agent_session(db: Session, workspace: Workspace, agent_name: str, session_id: Optional[str]) -> bool:
    if not agent_name or not session_id:
        return False
    member = db.execute(
        select(WorkspaceMember).where(
            WorkspaceMember.workspace_id == workspace.id,
            WorkspaceMember.agent_name == agent_name,
        )
    ).scalar_one_or_none()
    return bool(member and member.session_id and member.session_id == session_id)


def _delivery_event_payload(delivery: AgentDelivery, event: EventRecord) -> dict:
    return {
        "id": delivery.id,
        "event_id": delivery.event_id,
        "agent_name": delivery.agent_name,
        "channel_name": delivery.channel_name,
        "delivery_kind": delivery.delivery_kind,
        "attention_reason": delivery.attention_reason,
        "status": delivery.status,
        "attempts": delivery.attempts,
        "lease_until": delivery.lease_until.isoformat() if delivery.lease_until else None,
        "event": {
            "id": event.id,
            "type": event.type,
            "source": event.source,
            "target": event.target,
            "payload": event.payload,
            "metadata": event.metadata_,
            "timestamp": event.timestamp,
            "visibility": event.visibility,
        },
    }


def _compact_context_text(value: object, limit: int) -> str:
    text = str(value or "").replace("\r\n", "\n").strip()
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 3)].rstrip() + "..."


def _todo_context_summary(payload: dict) -> Optional[str]:
    todos = payload.get("todos")
    if not isinstance(todos, list):
        return None
    counts = {"pending": 0, "in_progress": 0, "completed": 0}
    other = 0
    for item in todos:
        status = ""
        if isinstance(item, dict):
            status = str(item.get("status") or "").lower()
        if status in counts:
            counts[status] += 1
        else:
            other += 1
    parts = [
        f"{counts['pending']} pending",
        f"{counts['in_progress']} in_progress",
        f"{counts['completed']} completed",
    ]
    if other:
        parts.append(f"{other} other")
    return f"todos: {', '.join(parts)}"


def _context_event_payload(payload: Optional[dict]) -> dict:
    original = payload if isinstance(payload, dict) else {}
    result = dict(original)
    message_type = str(result.get("message_type") or result.get("type") or "chat").lower()
    if message_type in _PROCESS_CONTEXT_MESSAGE_TYPES:
        summary = _todo_context_summary(result) if message_type == "todos" else None
        content = summary if summary is not None else result.get("content")
        result["content"] = _compact_context_text(content, _PROCESS_CONTEXT_CONTENT_LIMIT)
        result["context_compacted"] = True
        result.pop("details", None)
        result.pop("process_details", None)
        result.pop("todos", None)
        return result

    if "content" in result:
        result["content"] = _compact_context_text(result.get("content"), _DURABLE_CONTEXT_CONTENT_LIMIT)
        if result["content"] != str(original.get("content") or "").replace("\r\n", "\n").strip():
            result["context_compacted"] = True
    return result


def _event_context_payload(event: EventRecord) -> dict:
    return {
        "id": event.id,
        "type": event.type,
        "source": event.source,
        "target": event.target,
        "payload": _context_event_payload(event.payload),
        "metadata": event.metadata_ or {},
        "timestamp": event.timestamp,
        "visibility": event.visibility,
    }


def _delivery_context_payload(delivery: AgentDelivery, event: EventRecord) -> dict:
    data = _delivery_event_payload(delivery, event)
    data["event"] = _event_context_payload(event)
    return data


def _task_context_payload(task: WorkspaceTask) -> dict:
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
        "depends_on": task.depends_on or [],
        "lane_type": task.lane_type or "unspecified",
        "write_scope": task.write_scope or [],
        "resource_locks": task.resource_locks or [],
        "conflicts_with": task.conflicts_with or [],
        "commit_policy": task.commit_policy or {},
        "result": task.result,
        "updated_at": task.updated_at.isoformat() if task.updated_at else None,
    }


def _task_lock_set(task: WorkspaceTask) -> set[str]:
    return {str(lock).strip() for lock in (task.resource_locks or []) if str(lock).strip()}


def _task_context_with_scheduling(task: WorkspaceTask, active_tasks: list[WorkspaceTask]) -> dict:
    payload = _task_context_payload(task)
    explicit_conflicts = {str(item).strip() for item in (task.conflicts_with or []) if str(item).strip()}
    locks = _task_lock_set(task)
    conflicts = []
    for other in active_tasks:
        if other.id == task.id:
            continue
        if other.status not in {"todo", "in_progress", "in_review"}:
            continue
        other_explicit = {str(item).strip() for item in (other.conflicts_with or []) if str(item).strip()}
        shared_locks = sorted(locks & _task_lock_set(other))
        explicit = other.id in explicit_conflicts or task.id in other_explicit
        if shared_locks or explicit:
            conflicts.append({
                "task_id": other.id,
                "title": other.title,
                "status": other.status,
                "owner": other.claimed_by or other.assignee,
                "shared_locks": shared_locks,
                "explicit": explicit,
            })
    payload["scheduling"] = {
        "parallel_safe": not conflicts,
        "conflicts": conflicts,
    }
    return payload


def _goal_context_payload(goal: WorkspaceGoal) -> dict:
    return {
        "id": goal.id,
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
        "cadence_seconds": goal.cadence_seconds,
        "run_count": goal.run_count,
        "last_run_at": goal.last_run_at.isoformat() if goal.last_run_at else None,
        "next_run_at": goal.next_run_at.isoformat() if goal.next_run_at else None,
        "updated_at": goal.updated_at.isoformat() if goal.updated_at else None,
    }


def _event_response_data(event: EventRecord | Event) -> dict:
    metadata = event.metadata_ if isinstance(event, EventRecord) else event.metadata
    return {
        "id": event.id,
        "type": event.type,
        "source": event.source,
        "target": event.target,
        "payload": event.payload,
        "timestamp": event.timestamp,
        "metadata": metadata,
    }


def _client_message_id(metadata: Optional[dict], payload: Optional[dict]) -> Optional[str]:
    for value in (
        (metadata or {}).get("client_message_id"),
        (payload or {}).get("client_message_id"),
    ):
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _normalized_human_payload(payload: Optional[dict]) -> dict:
    normalized = dict(payload or {})
    normalized.pop("client_message_id", None)
    return normalized


def _find_duplicate_human_message(
    db: Session,
    workspace: Workspace,
    body: SendEventRequest,
) -> Optional[EventRecord]:
    if body.type != "workspace.message.posted":
        return None
    if not (body.source or "").startswith("human:"):
        return None
    if not (body.target or "").startswith("channel/"):
        return None
    if (body.visibility or "channel").lower() == "direct":
        return None

    client_message_id = _client_message_id(body.metadata, body.payload)
    query = select(EventRecord).where(
        EventRecord.network_id == workspace.id,
        EventRecord.type == body.type,
        EventRecord.source == body.source,
        EventRecord.target == body.target,
    )
    if not client_message_id:
        cutoff = int(datetime.now(timezone.utc).timestamp() * 1000) - _HUMAN_MESSAGE_DEDUPE_WINDOW_MS
        query = query.where(EventRecord.timestamp >= cutoff)

    candidates = db.execute(
        query.order_by(EventRecord.timestamp.desc(), EventRecord.id.desc()).limit(50)
    ).scalars().all()
    requested_payload = _normalized_human_payload(body.payload)
    for event in candidates:
        metadata = event.metadata_ or {}
        if client_message_id:
            if _client_message_id(metadata, event.payload) == client_message_id:
                return event
            continue
        if _normalized_human_payload(event.payload) == requested_payload:
            return event
    return None


@router.post("/events")
async def send_event(
    body: SendEventRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    x_workspace_token: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    """
    Send an event into the network pipeline.

    The event flows through mod/auth → mod/workspace → mod/persistence
    before delivery to the target.
    """
    if not body.network:
        return json_response(ResponseCode.BAD_REQUEST, "Missing required field: network")

    # Resolve workspace
    workspace = db.execute(
        select(Workspace).where(_workspace_filter(body.network))
    ).scalar_one_or_none()

    if not workspace:
        return json_response(ResponseCode.NOT_FOUND, "Network not found")

    if (
        body.type == "workspace.message.posted"
        and (
            (body.visibility or "").lower() == "direct"
            or (body.target or "").startswith("openagents:")
        )
    ):
        return json_response(ResponseCode.BAD_REQUEST, "Direct chat is disabled; post to a channel")

    if _verify_workspace_access(workspace, x_workspace_token, authorization):
        existing_event = _find_duplicate_human_message(db, workspace, body)
        if existing_event:
            return success_response(_event_response_data(existing_event))

    # Build ONM Event
    event = Event(
        type=body.type,
        source=body.source,
        target=body.target,
        payload=body.payload,
        metadata=body.metadata or {},
        visibility=body.visibility or "channel",
        network=str(workspace.id),
    )
    human_email = human_email_from_authorization(authorization)

    # Build pipeline context — extra kwargs become context.extra dict
    context = PipelineContext(
        network_id=str(workspace.id),
        agent_address=body.source,
        db=db,
        workspace=workspace,
        token=x_workspace_token,
        bearer_token=_extract_bearer(authorization),
        human_email=human_email,
    )

    # Run through pipeline
    try:
        result = await pipeline.process(event, context)
    except EventRejected as exc:
        # Surface the reason so clients can roll back optimistic UI on
        # specific failures (e.g. routine_channel_locked,
        # channel_join_forbidden). 403 distinguishes "you can't do this"
        # from generic auth failures.
        reason = exc.reason or "rejected"
        code = ResponseCode.FORBIDDEN if "forbidden" in reason or "locked" in reason \
            else ResponseCode.UNAUTHORIZED
        return json_response(code, reason)

    # Session revocation: another client has since joined as this agent.
    # Return a clear error so the stale client can stop its adapter.
    if result.metadata.get("session_error") == "session_revoked":
        db.rollback()
        return json_response(
            ResponseCode.UNAUTHORIZED,
            "session_revoked: another client is now running as this agent",
        )

    db.commit()

    # Fan out push notifications for relevant events. Runs after the
    # response is sent (FastAPI BackgroundTasks); never blocks event
    # creation; failures are logged but never raised. The service opens
    # its own short-lived DB session because `db` here is request-scoped.
    from app.services.push import fanout_for_event
    event_snapshot = {
        **_event_response_data(result),
    }
    background_tasks.add_task(fanout_for_event, str(workspace.id), event_snapshot)

    try:
        cache.publish_event(
            f"ws:{workspace.id}:events",
            _json.dumps(event_snapshot, default=str, separators=(",", ":")).encode(),
        )
    except Exception:
        pass

    # Invoke cloud agents if any are targeted by this message.
    if result.type == "workspace.message.posted":
        from app.services.cloud_agent import invoke_cloud_agents
        background_tasks.add_task(invoke_cloud_agents, str(workspace.id), event_snapshot)

    return success_response(_event_response_data(result))


# ---------------------------------------------------------------------------
# Durable agent deliveries — lease/ack inbox rows
# ---------------------------------------------------------------------------

@router.get("/agent-deliveries/pending")
def lease_pending_deliveries(
    network: str = Query(..., description="Network (workspace) ID or slug"),
    agent: str = Query(..., description="Agent handle"),
    session_id: str = Query(..., description="Current session id from /v1/join"),
    limit: int = Query(20, ge=1, le=100),
    lease_seconds: int = Query(1800, ge=30, le=86400),
    include_ambient: bool = Query(False, description="Also lease ambient non-wakeup deliveries"),
    db: Session = Depends(get_db),
    x_workspace_token: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    workspace = db.execute(
        select(Workspace).where(_workspace_filter(network))
    ).scalar_one_or_none()
    if not workspace:
        return json_response(ResponseCode.NOT_FOUND, "Network not found")
    if not _verify_workspace_access(workspace, x_workspace_token, authorization):
        return json_response(ResponseCode.UNAUTHORIZED, "Invalid workspace credentials")
    if not _current_agent_session(db, workspace, agent, session_id):
        return json_response(ResponseCode.UNAUTHORIZED, "session_revoked: current agent session required")

    now = _utcnow()
    lease_until = now + timedelta(seconds=lease_seconds)
    rows = db.execute(
        select(AgentDelivery, EventRecord)
        .join(EventRecord, EventRecord.id == AgentDelivery.event_id)
        .where(
            AgentDelivery.workspace_id == workspace.id,
            AgentDelivery.agent_name == agent,
            AgentDelivery.status.in_(["pending", "leased"]),
            AgentDelivery.delivery_kind.in_(["attention", "ambient"] if include_ambient else ["attention"]),
            or_(
                EventRecord.type != "workspace.message.posted",
                EventRecord.visibility != "direct",
            ),
            or_(
                AgentDelivery.status == "pending",
                AgentDelivery.lease_until.is_(None),
                AgentDelivery.lease_until < now,
                and_(
                    AgentDelivery.delivery_kind == "attention",
                    AgentDelivery.lease_owner_session_id != session_id,
                ),
            ),
        )
        .order_by(
            case((EventRecord.source.like("human:%"), 0), else_=1),
            AgentDelivery.created_at.asc(),
            EventRecord.timestamp.asc(),
            AgentDelivery.id.asc(),
        )
        .limit(limit)
    ).all()

    deliveries = []
    for delivery, event in rows:
        delivery.status = "leased"
        delivery.attempts = (delivery.attempts or 0) + 1
        delivery.lease_owner_session_id = session_id
        delivery.lease_until = lease_until
        delivery.last_delivered_at = now
        delivery.updated_at = now
        deliveries.append(_delivery_event_payload(delivery, event))

    db.commit()
    return success_response({
        "deliveries": deliveries,
        "lease_seconds": lease_seconds,
    })


@router.post("/agent-deliveries/{delivery_id}/ack")
def ack_delivery(
    delivery_id: str,
    body: AckDeliveryRequest,
    db: Session = Depends(get_db),
    x_workspace_token: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    workspace = db.execute(
        select(Workspace).where(_workspace_filter(body.network))
    ).scalar_one_or_none()
    if not workspace:
        return json_response(ResponseCode.NOT_FOUND, "Network not found")
    if not _verify_workspace_access(workspace, x_workspace_token, authorization):
        return json_response(ResponseCode.UNAUTHORIZED, "Invalid workspace credentials")
    if not _current_agent_session(db, workspace, body.agent_name, body.session_id):
        return json_response(ResponseCode.UNAUTHORIZED, "session_revoked: current agent session required")

    delivery = db.get(AgentDelivery, delivery_id)
    if not delivery or str(delivery.workspace_id) != str(workspace.id) or delivery.agent_name != body.agent_name:
        return json_response(ResponseCode.NOT_FOUND, "Delivery not found")

    if delivery.status == "acked":
        return success_response({"id": delivery.id, "status": delivery.status})
    if delivery.lease_owner_session_id and delivery.lease_owner_session_id != body.session_id:
        return json_response(ResponseCode.CONFLICT, "delivery leased by another session")

    now = _utcnow()
    if body.status == "failed":
        delivery.status = "pending"
        delivery.lease_owner_session_id = None
        delivery.lease_until = None
        delivery.last_error = (body.error or "processing failed")[:2000]
    else:
        delivery.status = "acked"
        delivery.acked_at = now
        delivery.lease_until = None
        delivery.last_error = None
    delivery.updated_at = now
    db.commit()
    return success_response({"id": delivery.id, "status": delivery.status})


@router.get("/agent-context")
def get_agent_context(
    network: str = Query(..., description="Network (workspace) ID or slug"),
    agent: str = Query(..., description="Agent handle"),
    session_id: str = Query(..., description="Current session id from /v1/join"),
    channel: Optional[str] = Query(None, description="Current channel name"),
    current_event_id: Optional[str] = Query(None, description="Current event to exclude from recaps"),
    recent_limit: int = Query(20, ge=1, le=50),
    ambient_limit: int = Query(20, ge=0, le=50),
    db: Session = Depends(get_db),
    x_workspace_token: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    """Return a compact, authoritative runtime context pack for an agent.

    This endpoint is intentionally read-only: ambient delivery rows are used as
    passive context but are not leased or acked, so they never become work.
    """
    workspace = db.execute(
        select(Workspace).where(_workspace_filter(network))
    ).scalar_one_or_none()
    if not workspace:
        return json_response(ResponseCode.NOT_FOUND, "Network not found")
    if not _verify_workspace_access(workspace, x_workspace_token, authorization):
        return json_response(ResponseCode.UNAUTHORIZED, "Invalid workspace credentials")
    if not _current_agent_session(db, workspace, agent, session_id):
        return json_response(ResponseCode.UNAUTHORIZED, "session_revoked: current agent session required")

    channel_row = None
    channel_members = set()
    if channel:
        channel_row = db.execute(
            select(Channel).where(
                Channel.workspace_id == workspace.id,
                Channel.name == channel,
                Channel.status != "deleted",
            )
        ).scalar_one_or_none()
        if channel_row:
            channel_members = {
                row.agent_name
                for row in db.execute(
                    select(ChannelMember.agent_name).where(ChannelMember.channel_id == channel_row.id)
                ).all()
            }

    members = db.execute(
        select(WorkspaceMember).where(WorkspaceMember.workspace_id == workspace.id)
    ).scalars().all()
    member_by_name = {m.agent_name: m for m in members}
    self_member = member_by_name.get(agent)

    def _member_payload(m: WorkspaceMember) -> dict:
        return {
            "agent_name": m.agent_name,
            "role": m.role or "member",
            "description": m.description or "",
            "agent_type": m.agent_type or "",
            "status": m.status or "offline",
            "in_channel": (m.agent_name in channel_members) if channel_row else None,
        }

    role_order = {"master": 0, "architect": 1, "lead": 1, "reviewer": 2, "qa": 3, "member": 4}
    agents = sorted(
        [_member_payload(m) for m in members],
        key=lambda x: (role_order.get((x.get("role") or "member").lower(), 10), x.get("agent_name") or ""),
    )

    recent_messages = []
    if channel:
        query = select(EventRecord).where(
            EventRecord.network_id == workspace.id,
            EventRecord.target == f"channel/{channel}",
            EventRecord.type.startswith("workspace.message"),
        )
        query = apply_event_channel_visibility(
            query,
            db,
            workspace,
            member=agent,
            session_id=session_id,
            human_email=human_email_from_authorization(authorization),
            include_public=False,
        )
        if current_event_id:
            query = query.where(EventRecord.id != current_event_id)
        rows = db.execute(
            query.order_by(EventRecord.timestamp.desc(), EventRecord.id.desc()).limit(recent_limit)
        ).scalars().all()
        recent_messages = [_event_context_payload(e) for e in reversed(rows)]

    ambient_messages = []
    if ambient_limit > 0:
        ambient_query = (
            select(AgentDelivery, EventRecord)
            .join(EventRecord, EventRecord.id == AgentDelivery.event_id)
            .where(
                AgentDelivery.workspace_id == workspace.id,
                AgentDelivery.agent_name == agent,
                AgentDelivery.delivery_kind == "ambient",
                AgentDelivery.status != "acked",
                or_(
                    EventRecord.type != "workspace.message.posted",
                    EventRecord.visibility != "direct",
                ),
            )
        )
        if channel:
            ambient_query = ambient_query.where(AgentDelivery.channel_name == channel)
        if current_event_id:
            ambient_query = ambient_query.where(AgentDelivery.event_id != current_event_id)
        rows = db.execute(
            ambient_query
            .order_by(AgentDelivery.created_at.desc(), EventRecord.timestamp.desc(), AgentDelivery.id.desc())
            .limit(ambient_limit)
        ).all()
        ambient_messages = [_delivery_context_payload(d, e) for d, e in reversed(rows)]

    task_query = select(WorkspaceTask).where(
        WorkspaceTask.workspace_id == workspace.id,
        WorkspaceTask.status.in_(["todo", "in_progress", "in_review"]),
    )
    if channel:
        task_query = task_query.where(
            or_(
                WorkspaceTask.channel_name == channel,
                WorkspaceTask.assignee == agent,
                WorkspaceTask.claimed_by == agent,
            )
        )
    task_rows = db.execute(
        task_query.order_by(WorkspaceTask.created_at.asc(), WorkspaceTask.id.asc()).limit(30)
    ).scalars().all()

    goal_query = select(WorkspaceGoal).where(
        WorkspaceGoal.workspace_id == workspace.id,
        WorkspaceGoal.status.in_(["active", "paused", "blocked"]),
        WorkspaceGoal.coordinator == agent,
    )
    if channel:
        goal_query = goal_query.where(WorkspaceGoal.channel_name == channel)
    goal_rows = db.execute(
        goal_query.order_by(WorkspaceGoal.created_at.asc(), WorkspaceGoal.id.asc()).limit(10)
    ).scalars().all()

    return success_response({
        "workspace": {
            "id": str(workspace.id),
            "slug": workspace.slug,
            "name": workspace.name,
        },
        "channel": {
            "name": channel,
            "title": channel_row.title if channel_row else channel,
            "visibility": channel_row.visibility if channel_row else None,
            "master_agent": channel_row.master_agent if channel_row else None,
        },
        "self": _member_payload(self_member) if self_member else {
            "agent_name": agent,
            "role": "member",
            "description": "",
            "agent_type": "",
            "status": "online",
            "in_channel": None,
        },
        "agents": agents,
        "recent_messages": recent_messages,
        "ambient_messages": ambient_messages,
        "active_tasks": [_task_context_with_scheduling(t, task_rows) for t in task_rows],
        "active_goals": [_goal_context_payload(g) for g in goal_rows],
        "runtime_rules": [
            "Channel messages are visible context for channel members; @mentions and routing are attention, not visibility.",
            "Ambient delivery is passive context only: do not create/claim tasks, @mention others, assign work, or send visible coordination unless explicitly addressed, already owning the referenced task, or acting as channel lead on a required coordination decision.",
            "Do not flatten roles. Use each agent's role and description when deciding delegation.",
            "Non-lead implementers and QA agents report evidence/blockers; they do not assign or direct the channel lead unless explicitly delegated.",
            "Scheduling is context-driven and rolling-parallel, not a fixed org chart or batch barrier: derive work functions from the current request and route safe non-overlapping follow-up work to freed agents while other lanes continue.",
            "For parallel implementation, use scope-aware task contracts: set lane_type, write_scope, resource_locks, conflicts_with, and commit_policy; do not rely on natural-language promises when multiple writers may run.",
            "Multiple writers may work in one repository only when their declared scopes and resource locks do not conflict; use path-scoped edits/staging/commits and never include another agent's dirty files.",
            "For a bug, useful functions may be analysis, fix, and test; for a feature, they may be reference research, design breakdown, and implementation. Use the functions the context actually needs.",
            "Create shared tasks for those work functions only when separate owners improve clarity or throughput; keep single-owner work single-owner.",
            "Agents assigned to verification should reproduce and report evidence; agents assigned to implementation should own code changes.",
            "If another agent must act, @mention that agent explicitly and include a concrete handoff.",
            "Use shared workspace tasks for multi-agent work ownership; use personal todos only for your own execution plan.",
            "Workspace plans are hierarchical: root/stage plans own long-horizon state, create short plans and execution tasks, and must return to planning after short-plan evidence instead of stopping at a flat checkpoint.",
            "Only close a root/stage plan when its plan references are exhausted and there are no active child plans or channel tasks; otherwise update the checkpoint or create the next short plan.",
        ],
    })


# ---------------------------------------------------------------------------
# GET /v1/events — poll events
# ---------------------------------------------------------------------------

@router.get("/events")
def poll_events(
    network: str = Query(..., description="Network (workspace) ID or slug"),
    after: Optional[str] = Query(None, description="Return events after this event ID"),
    before: Optional[str] = Query(None, description="Return events before this event ID"),
    target: Optional[str] = Query(None, description="Filter by target address"),
    channel: Optional[str] = Query(None, description="Filter by channel name"),
    type: Optional[str] = Query(None, description="Filter by event type prefix"),
    search: Optional[str] = Query(None, description="Search message content (case-insensitive)"),
    member: Optional[str] = Query(None, description="Filter to channels where this agent is a member"),
    session_id: Optional[str] = Query(None, description="Session id proving the member agent identity"),
    sort: Optional[str] = Query(None, description="Sort order: 'asc' (default) or 'desc'"),
    limit: int = Query(50, ge=1, le=500, description="Max events to return"),
    db: Session = Depends(get_db),
    x_workspace_token: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    """
    Poll events from the network.

    Supports filtering by target, channel, type, and cursor-based pagination
    using the `after` parameter (event ID — events are sorted by timestamp).
    """
    # Resolve workspace
    workspace = db.execute(
        select(Workspace).where(_workspace_filter(network))
    ).scalar_one_or_none()

    if not workspace:
        return json_response(ResponseCode.NOT_FOUND, "Network not found")

    if not _verify_workspace_access(workspace, x_workspace_token, authorization):
        return json_response(ResponseCode.UNAUTHORIZED, "Invalid workspace credentials")

    human_email = human_email_from_authorization(authorization)

    # Two-level read-through cache for poll traffic.
    #
    # Level 1: FULL key (includes `after`/`before` cursor). Dedupes identical
    # polls from the same agent within the TTL window. Correct for any
    # parameters.
    #
    # Level 2: HEAD-CURSOR tracking. When a non-empty poll returns events,
    # we remember the newest event id for these filters. When a subsequent
    # poll comes in with `after = cached_head_id` (i.e. the client is
    # already caught up to the most recent event we've seen), its "give me
    # anything newer" query is equivalent to a no-cursor "give me the empty
    # set". Many agents sharing the head cursor all hash to the same
    # Level-2 key and share a single DB hit.
    #
    # This is a strict correctness guarantee: we only route to Level 2 when
    # the caller's cursor is EQUAL to the tracked head. Agents that are
    # behind (historical backfill) fall through to Level 1 / DB.
    cache_key = None
    at_head_key = None
    head_tracker_key = None
    incoming_after = after or ""
    if not search and not member and not human_email:
        key_parts = [
            str(workspace.id), target or "", channel or "",
            type or "",
            after or "", before or "",
            sort or "asc", str(limit),
        ]
        cache_key = "v1events:full:" + hashlib.sha1(
            "|".join(key_parts).encode("utf-8")
        ).hexdigest()

        # Per-filter head cursor marker (what the newest event id was for
        # this filter the last time we saw any events). Cursor-free.
        filter_parts = [
            str(workspace.id), target or "", channel or "",
            type or "",
            sort or "asc", str(limit),
        ]
        filter_hash = hashlib.sha1("|".join(filter_parts).encode("utf-8")).hexdigest()
        head_tracker_key = "v1events:head:" + filter_hash

        import json as _json

        # Level 1: exact-match cache
        cached = cache.get_bytes(cache_key)
        if cached is not None:
            try:
                return _json.loads(cached)
            except Exception:
                pass

        # Level 2: if client is at head (after == last-known head), route
        # to a shared cached-empty response. Only fires when we already know
        # the head AND client's cursor matches it — so agents behind head
        # cannot receive this cached empty by mistake.
        if before is None:
            head_id = cache.get_bytes(head_tracker_key)
            if head_id is not None:
                head_id_str = head_id.decode("utf-8") if isinstance(head_id, bytes) else str(head_id)
                if head_id_str and head_id_str == incoming_after:
                    at_head_key = "v1events:athead:" + filter_hash
                    cached_empty = cache.get_bytes(at_head_key)
                    if cached_empty is not None:
                        try:
                            return _json.loads(cached_empty)
                        except Exception:
                            pass

    query = select(EventRecord).where(EventRecord.network_id == workspace.id)
    query = query.where(
        or_(
            EventRecord.type != "workspace.message.posted",
            EventRecord.visibility != "direct",
        )
    )
    query = apply_event_channel_visibility(
        query,
        db,
        workspace,
        member=member,
        session_id=session_id,
        human_email=human_email,
        include_public=member is None,
    )

    if after:
        cursor_row = db.execute(
            select(EventRecord.timestamp, EventRecord.id).where(EventRecord.id == after)
        ).one_or_none()
        if cursor_row is not None:
            # Use (timestamp, id) tuple to avoid skipping/duplicating events with the same timestamp
            query = query.where(
                or_(
                    EventRecord.timestamp > cursor_row.timestamp,
                    and_(EventRecord.timestamp == cursor_row.timestamp, EventRecord.id > cursor_row.id),
                )
            )

    if before:
        cursor_row = db.execute(
            select(EventRecord.timestamp, EventRecord.id).where(EventRecord.id == before)
        ).one_or_none()
        if cursor_row is not None:
            query = query.where(
                or_(
                    EventRecord.timestamp < cursor_row.timestamp,
                    and_(EventRecord.timestamp == cursor_row.timestamp, EventRecord.id < cursor_row.id),
                )
            )

    if target:
        query = query.where(EventRecord.target == target)

    if channel:
        query = query.where(EventRecord.target == f"channel/{channel}")

    if type:
        query = query.where(EventRecord.type.startswith(type))

    if search:
        # Search within payload JSON for content field (works with both JSONB and JSON)
        query = query.where(
            cast(EventRecord.payload, Text).ilike(f"%{search}%")
        )

    if sort == "desc":
        query = query.order_by(EventRecord.timestamp.desc(), EventRecord.id.desc()).limit(limit + 1)
    else:
        query = query.order_by(EventRecord.timestamp.asc(), EventRecord.id.asc()).limit(limit + 1)
    rows = db.execute(query).scalars().all()

    has_more = len(rows) > limit
    events = rows[:limit]

    composing = False
    if not search:
        from app.composing import has_any_composing
        composing = has_any_composing(str(workspace.id))

    response_data = {
        "events": [
            {
                "id": e.id,
                "type": e.type,
                "source": e.source,
                "target": e.target,
                "payload": e.payload,
                "metadata": e.metadata_,
                "timestamp": e.timestamp,
                "visibility": e.visibility,
            }
            for e in events
        ],
        "has_more": has_more,
        "oldest_id": (events[-1].id if sort == "desc" else events[0].id) if events else None,
        "newest_id": (events[0].id if sort == "desc" else events[-1].id) if events else None,
    }
    if composing:
        response_data["composing"] = True

    response = success_response(response_data)

    # Populate cache for subsequent polls within the TTL window.
    # success_response returns a dict; Redis stores the serialized JSON.
    if cache_key is not None and isinstance(response, dict):
        try:
            import json as _json
            serialized = _json.dumps(
                response, default=str, separators=(",", ":")
            ).encode("utf-8")
            # Level 1: exact-match cache (includes cursor). Slightly
            # longer TTL helps dedup adjacent polls from the same agent.
            cache.set_bytes(cache_key, serialized, ttl_seconds=1.5)

            # Level 2 maintenance — track the head cursor for these
            # filters, and cache the "empty" response when the client was
            # already at head.
            if head_tracker_key is not None:
                newest_id = response.get("data", {}).get("newest_id")
                if events and newest_id:
                    # Update head tracker — newest_id is the tip we just saw.
                    # Longer TTL because head updates are cheap and we want
                    # subsequent at-head checks to find it.
                    cache.set_bytes(
                        head_tracker_key,
                        str(newest_id).encode("utf-8"),
                        ttl_seconds=30.0,
                    )
                elif not events and incoming_after:
                    # DB returned empty AND the client had a cursor. This
                    # confirms "after = head" for this filter. Populate
                    # both the head tracker (so other clients can match)
                    # and the shared at-head empty response.
                    filter_hash = head_tracker_key.split(":")[-1]
                    cache.set_bytes(
                        head_tracker_key,
                        incoming_after.encode("utf-8"),
                        ttl_seconds=30.0,
                    )
                    cache.set_bytes(
                        "v1events:athead:" + filter_hash,
                        serialized,
                        ttl_seconds=1.5,
                    )
        except Exception:
            pass

    return response


# ---------------------------------------------------------------------------
# GET /v1/events/latest-per-channel — bulk thread preview endpoint
# ---------------------------------------------------------------------------

@router.get("/events/latest-per-channel")
def latest_per_channel(
    network: str = Query(..., description="Network (workspace) ID or slug"),
    type: Optional[str] = Query("workspace.message", description="Event type prefix to filter"),
    member: Optional[str] = Query(None, description="Filter to channels where this agent is a member"),
    session_id: Optional[str] = Query(None, description="Session id proving the member agent identity"),
    db: Session = Depends(get_db),
    x_workspace_token: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    """
    Return the most recent event per channel in a single query.

    Replaces N separate pollEvents calls for thread list previews.
    Uses a SQL window function to efficiently pick the latest event per target.
    """
    workspace = db.execute(
        select(Workspace).where(_workspace_filter(network))
    ).scalar_one_or_none()

    if not workspace:
        return json_response(ResponseCode.NOT_FOUND, "Network not found")

    if not _verify_workspace_access(workspace, x_workspace_token, authorization):
        return json_response(ResponseCode.UNAUTHORIZED, "Invalid workspace credentials")

    channel_targets = [
        f"channel/{name}"
        for name in visible_channel_names(
            db,
            workspace,
            member=member,
            session_id=session_id,
            human_email=human_email_from_authorization(authorization),
            include_public=member is None,
        )
    ]
    if not channel_targets:
        return success_response({"channels": {}})

    # Window function: ROW_NUMBER() OVER (PARTITION BY target ORDER BY timestamp DESC)
    row_num = func.row_number().over(
        partition_by=EventRecord.target,
        order_by=EventRecord.timestamp.desc(),
    ).label("rn")

    inner = (
        select(EventRecord, row_num)
        .where(
            EventRecord.network_id == workspace.id,
            EventRecord.target.startswith("channel/"),
            EventRecord.target.in_(channel_targets),
        )
    )

    if type:
        inner = inner.where(EventRecord.type.startswith(type))

    inner = inner.subquery()

    # Select only the first row per partition
    query = select(inner).where(inner.c.rn == 1)
    rows = db.execute(query).all()

    channels = {}
    for row in rows:
        channel_name = row.target.replace("channel/", "", 1)
        channels[channel_name] = {
            "id": row.id,
            "type": row.type,
            "source": row.source,
            "target": row.target,
            "payload": row.payload,
            "metadata": row.metadata,
            "timestamp": row.timestamp,
            "visibility": row.visibility,
        }

    return success_response({"channels": channels})


# ---------------------------------------------------------------------------
# GET /v1/events/stream — Server-Sent Events
# ---------------------------------------------------------------------------

@router.get("/events/stream")
async def stream_events(
    request: Request,
    network: str = Query(...),
    channel: Optional[str] = Query(None),
    member: Optional[str] = Query(None),
    session_id: Optional[str] = Query(None),
    token: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    x_workspace_token: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    """Stream new events via Server-Sent Events (SSE).

    Uses Redis pub/sub under the hood. Falls back gracefully — if Redis
    is unavailable the connection closes and the client should fall back
    to polling.
    """
    effective_token = x_workspace_token or token
    workspace = db.execute(
        select(Workspace).where(_workspace_filter(network))
    ).scalar_one_or_none()
    if not workspace:
        return json_response(ResponseCode.NOT_FOUND, "Network not found")
    if not _verify_workspace_access(workspace, effective_token, authorization):
        return json_response(ResponseCode.UNAUTHORIZED, "Invalid credentials")

    workspace_id = str(workspace.id)
    target_prefix = f"channel/{channel}" if channel else None
    allowed_channel_targets = {
        f"channel/{name}"
        for name in visible_channel_names(
            db,
            workspace,
            member=member,
            session_id=session_id,
            human_email=human_email_from_authorization(authorization),
            include_public=member is None,
        )
    }
    if target_prefix and target_prefix not in allowed_channel_targets:
        return json_response(ResponseCode.FORBIDDEN, "private_channel_read_forbidden")

    async def event_generator():
        keepalive_interval = 30
        last_keepalive = asyncio.get_event_loop().time()

        async for data in cache.subscribe_events(f"ws:{workspace_id}:events"):
            if await request.is_disconnected():
                break
            try:
                event = _json.loads(data)
                if target_prefix and event.get("target", "") != target_prefix:
                    continue
                event_target = event.get("target", "")
                if event_target.startswith("channel/") and event_target not in allowed_channel_targets:
                    continue
                event_id = event.get("id", "")
                yield f"id: {event_id}\ndata: {data.decode()}\n\n"
            except Exception:
                continue

            now = asyncio.get_event_loop().time()
            if now - last_keepalive >= keepalive_interval:
                yield ": keepalive\n\n"
                last_keepalive = now

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
