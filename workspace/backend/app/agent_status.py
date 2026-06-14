# -*- coding: utf-8 -*-
"""Agent status projection helpers.

Slock/Raft-style presence, activity, and workload state are separate.
The legacy `status` field remains a derived display value for older clients.
"""

from __future__ import annotations

from datetime import datetime, timezone, timedelta
from typing import Any

from app.models import AgentConfig, WorkspaceMember


ACTIVE_STATES = {
    "starting",
    "thinking",
    "editing_file",
    "running_command",
    "waiting_input",
    "stopping",
}
ERROR_STATES = {"error", "failed"}
STOPPED_STATES = {"stopped", "disabled"}
OFFLINE_STATES = {"offline", "left", "removed"}
ACTIVE_STATE_STALE_AFTER = timedelta(minutes=10)


def _aware(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def _metadata(cfg: AgentConfig | None) -> dict[str, Any]:
    value = (cfg.config_metadata if cfg else None) or {}
    return value if isinstance(value, dict) else {}


def _parse_datetime(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return _aware(value)
    if isinstance(value, str) and value.strip():
        try:
            return _aware(datetime.fromisoformat(value.replace("Z", "+00:00")))
        except ValueError:
            return None
    return None


def project_agent_status(
    member: WorkspaceMember,
    now: datetime,
    timeout: timedelta,
    cfg: AgentConfig | None = None,
) -> dict[str, str | bool]:
    metadata = _metadata(cfg)
    raw_status = str(member.status or "offline")
    lifecycle_state = str(metadata.get("lifecycle_state") or raw_status)
    current_channel = metadata.get("current_channel")
    activity_updated_at = (
        _parse_datetime(metadata.get("activity_updated_at"))
        or _aware(getattr(cfg, "updated_at", None))
    )

    is_cloud = (member.agent_type or "").startswith("cloud:")
    heartbeat = _aware(member.last_heartbeat)
    stale = bool(
        not is_cloud
        and heartbeat is not None
        and (now - heartbeat) > timeout
    )
    disabled = bool(metadata.get("disabled")) or raw_status in STOPPED_STATES

    if disabled:
        presence_status = "stopped"
    elif stale or raw_status in OFFLINE_STATES:
        presence_status = "offline"
    elif heartbeat is not None or raw_status in ACTIVE_STATES or raw_status == "online":
        presence_status = "online"
    else:
        presence_status = "offline"

    if presence_status == "stopped":
        activity_state = "stopped"
    elif presence_status == "offline":
        activity_state = "offline"
    elif (
        lifecycle_state in ACTIVE_STATES
        and activity_updated_at is not None
        and (now - activity_updated_at) > ACTIVE_STATE_STALE_AFTER
    ):
        activity_state = "idle"
        current_channel = None
    elif lifecycle_state in ACTIVE_STATES:
        activity_state = lifecycle_state
    elif lifecycle_state in ERROR_STATES:
        activity_state = "error"
    else:
        activity_state = "idle"

    if activity_state == "waiting_input":
        workload_state = "waiting"
    elif activity_state == "error":
        workload_state = "blocked"
    elif activity_state in ACTIVE_STATES:
        workload_state = "active"
    elif current_channel and presence_status == "online":
        workload_state = "active"
    elif presence_status == "online":
        workload_state = "idle"
    else:
        workload_state = presence_status

    display_status = presence_status if activity_state == "idle" else activity_state

    return {
        "presence_status": presence_status,
        "activity_state": activity_state,
        "workload_state": workload_state,
        "display_status": display_status,
        "is_connected": presence_status == "online",
        "has_active_work": workload_state in {"active", "waiting", "blocked"},
    }
