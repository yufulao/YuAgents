# -*- coding: utf-8 -*-
"""
Timer endpoints — agent planning support.

POST   /v1/timers          Create a timer (fires a message after delay)
GET    /v1/timers          List active timers in scope
PATCH  /v1/timers/{id}     Edit an active timer
DELETE /v1/timers/{id}     Cancel a timer
"""

import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, Header, Path, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import TimerRecord, Workspace
from app.response import ResponseCode, json_response, success_response
from app.routers.network import _resolve_workspace, _verify_workspace_access

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1", tags=["Timers"])

MAX_DELAY = 86400  # 24 hours
MAX_REPEAT_INTERVAL = 86400  # 24 hours
MIN_REPEAT_INTERVAL = 60


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------

class CreateTimerRequest(BaseModel):
    delay: int
    message: str
    network: str
    source: str
    channel: Optional[str] = None
    thread_id: Optional[str] = None
    target_agent: Optional[str] = None
    repeat_interval_seconds: Optional[int] = None
    creator_type: Optional[str] = None


class UpdateTimerRequest(BaseModel):
    source: Optional[str] = None
    message: Optional[str] = None
    delay: Optional[int] = None
    target_agent: Optional[str] = None
    repeat_interval_seconds: Optional[int] = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _model_fields_set(model: BaseModel) -> set[str]:
    return set(getattr(model, "model_fields_set", getattr(model, "__fields_set__", set())))


def _normalize_target_agent(value: Optional[str]) -> Optional[str]:
    target_agent = (value or "").strip() or None
    if target_agent and target_agent.startswith("openagents:"):
        target_agent = target_agent.replace("openagents:", "", 1)
    return target_agent

def _serialize_timer(t: TimerRecord) -> dict:
    return {
        "id": t.id,
        "message": t.message,
        "delay_seconds": t.delay_seconds,
        "fires_at": t.fires_at.isoformat() if t.fires_at else None,
        "status": t.status,
        "created_by": t.created_by,
        "creator_type": getattr(t, "creator_type", "agent") or "agent",
        "target_agent": getattr(t, "target_agent", None),
        "repeat_interval_seconds": getattr(t, "repeat_interval_seconds", None),
        "fire_count": getattr(t, "fire_count", 0) or 0,
        "channel_name": t.channel_name,
        "thread_id": t.thread_id,
        "created_at": t.created_at.isoformat() if t.created_at else None,
    }


# ---------------------------------------------------------------------------
# POST /v1/timers
# ---------------------------------------------------------------------------

@router.post("/timers")
def create_timer(
    body: CreateTimerRequest,
    db: Session = Depends(get_db),
    x_workspace_token: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    """Create a timer that posts a message to the channel after a delay."""
    workspace = _resolve_workspace(db, body.network)
    if not workspace:
        return json_response(ResponseCode.NOT_FOUND, "Network not found")
    if not _verify_workspace_access(workspace, x_workspace_token, authorization):
        return json_response(ResponseCode.UNAUTHORIZED, "Invalid credentials")

    if body.delay < 1 or body.delay > MAX_DELAY:
        return json_response(
            ResponseCode.BAD_REQUEST,
            f"delay must be between 1 and {MAX_DELAY} seconds",
        )
    if body.repeat_interval_seconds is not None:
        if body.repeat_interval_seconds < MIN_REPEAT_INTERVAL or body.repeat_interval_seconds > MAX_REPEAT_INTERVAL:
            return json_response(
                ResponseCode.BAD_REQUEST,
                f"repeat_interval_seconds must be between {MIN_REPEAT_INTERVAL} and {MAX_REPEAT_INTERVAL} seconds",
            )
    creator_type = (body.creator_type or ("agent" if body.source.startswith("openagents:") else "human")).strip().lower()
    if creator_type not in {"agent", "human"}:
        return json_response(ResponseCode.BAD_REQUEST, "creator_type must be agent or human")
    target_agent = _normalize_target_agent(body.target_agent)
    if creator_type == "human" and not target_agent:
        return json_response(ResponseCode.BAD_REQUEST, "target_agent is required for human-created timers")

    now = datetime.now(timezone.utc)
    channel_name = body.channel or "default"

    timer = TimerRecord(
        workspace_id=str(workspace.id),
        channel_name=channel_name,
        thread_id=body.thread_id,
        created_by=body.source,
        creator_type=creator_type,
        target_agent=target_agent,
        message=body.message,
        delay_seconds=body.delay,
        repeat_interval_seconds=body.repeat_interval_seconds,
        fires_at=now + timedelta(seconds=body.delay),
    )
    db.add(timer)
    db.commit()

    return success_response(_serialize_timer(timer))


# ---------------------------------------------------------------------------
# GET /v1/timers
# ---------------------------------------------------------------------------

@router.get("/timers")
def list_timers(
    network: str = Query(...),
    channel: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    x_workspace_token: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    """List active timers in scope."""
    workspace = _resolve_workspace(db, network)
    if not workspace:
        return json_response(ResponseCode.NOT_FOUND, "Network not found")
    if not _verify_workspace_access(workspace, x_workspace_token, authorization):
        return json_response(ResponseCode.UNAUTHORIZED, "Invalid credentials")

    query = select(TimerRecord).where(
        TimerRecord.workspace_id == str(workspace.id),
        TimerRecord.status == "active",
    )
    if channel:
        query = query.where(TimerRecord.channel_name == channel)

    query = query.order_by(TimerRecord.fires_at.asc())
    rows = db.execute(query).scalars().all()

    return success_response({"timers": [_serialize_timer(t) for t in rows]})


# ---------------------------------------------------------------------------
# PATCH /v1/timers/{timer_id}
# ---------------------------------------------------------------------------

@router.patch("/timers/{timer_id}")
def update_timer(
    body: UpdateTimerRequest,
    timer_id: str = Path(...),
    db: Session = Depends(get_db),
    x_workspace_token: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    """Edit an active timer without recreating it."""
    timer = db.execute(
        select(TimerRecord).where(TimerRecord.id == timer_id)
    ).scalar_one_or_none()
    if not timer:
        return json_response(ResponseCode.NOT_FOUND, "Timer not found")

    workspace = db.execute(
        select(Workspace).where(Workspace.id == timer.workspace_id)
    ).scalar_one_or_none()
    if not workspace:
        return json_response(ResponseCode.NOT_FOUND, "Workspace not found")
    if not _verify_workspace_access(workspace, x_workspace_token, authorization):
        return json_response(ResponseCode.UNAUTHORIZED, "Invalid credentials")

    if timer.status != "active":
        return json_response(ResponseCode.BAD_REQUEST, f"Timer is already {timer.status}")
    creator_type = getattr(timer, "creator_type", "agent") or "agent"
    if creator_type == "human" and (not body.source or body.source.startswith("openagents:")):
        return json_response(
            ResponseCode.FORBIDDEN,
            "This timer was created by the user and cannot be edited by an agent",
        )

    changed_fields = _model_fields_set(body)
    if "message" in changed_fields:
        message = (body.message or "").strip()
        if not message:
            return json_response(ResponseCode.BAD_REQUEST, "message is required")
        timer.message = message
    if "delay" in changed_fields:
        if body.delay is None or body.delay < 1 or body.delay > MAX_DELAY:
            return json_response(
                ResponseCode.BAD_REQUEST,
                f"delay must be between 1 and {MAX_DELAY} seconds",
            )
        timer.delay_seconds = body.delay
        timer.fires_at = datetime.now(timezone.utc) + timedelta(seconds=body.delay)
    if "target_agent" in changed_fields:
        timer.target_agent = _normalize_target_agent(body.target_agent)
        if creator_type == "human" and not timer.target_agent:
            return json_response(ResponseCode.BAD_REQUEST, "target_agent is required for human-created timers")
    if "repeat_interval_seconds" in changed_fields:
        if body.repeat_interval_seconds is not None:
            if body.repeat_interval_seconds < MIN_REPEAT_INTERVAL or body.repeat_interval_seconds > MAX_REPEAT_INTERVAL:
                return json_response(
                    ResponseCode.BAD_REQUEST,
                    f"repeat_interval_seconds must be between {MIN_REPEAT_INTERVAL} and {MAX_REPEAT_INTERVAL} seconds",
                )
        timer.repeat_interval_seconds = body.repeat_interval_seconds

    db.commit()
    db.refresh(timer)
    return success_response(_serialize_timer(timer))


# ---------------------------------------------------------------------------
# DELETE /v1/timers/{timer_id}
# ---------------------------------------------------------------------------

@router.delete("/timers/{timer_id}")
def cancel_timer(
    timer_id: str = Path(...),
    network: Optional[str] = Query(None),
    source: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    x_workspace_token: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    """Cancel an active timer."""
    timer = db.execute(
        select(TimerRecord).where(TimerRecord.id == timer_id)
    ).scalar_one_or_none()
    if not timer:
        return json_response(ResponseCode.NOT_FOUND, "Timer not found")

    workspace = db.execute(
        select(Workspace).where(Workspace.id == timer.workspace_id)
    ).scalar_one_or_none()
    if not workspace:
        return json_response(ResponseCode.NOT_FOUND, "Workspace not found")
    if not _verify_workspace_access(workspace, x_workspace_token, authorization):
        return json_response(ResponseCode.UNAUTHORIZED, "Invalid credentials")

    if timer.status != "active":
        return json_response(ResponseCode.BAD_REQUEST, f"Timer is already {timer.status}")
    creator_type = getattr(timer, "creator_type", "agent") or "agent"
    if creator_type == "human" and (not source or source.startswith("openagents:")):
        return json_response(
            ResponseCode.FORBIDDEN,
            "This timer was created by the user and cannot be cancelled by an agent",
        )

    timer.status = "cancelled"
    db.commit()

    return success_response({"id": timer.id, "status": "cancelled"})
