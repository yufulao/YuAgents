# -*- coding: utf-8 -*-
"""
mod/persistence — save events to PostgreSQL.

Observe mod (priority 90). Stores every event that passes through the
pipeline into the events table.

Expects context.extra to contain:
  - db: SQLAlchemy Session
  - workspace: Workspace ORM object (for network_id)
"""

import logging
from typing import List, Optional

from sqlalchemy import select

from openagents.core.onm_events import Event
from openagents.core.onm_mods import ObserveMod, PipelineContext

logger = logging.getLogger(__name__)


class PersistenceMod(ObserveMod):
    """Persist events to the events table."""
    name = "persistence"
    intercepts: List[str] = []   # Match all events
    priority = 90

    # Event types that are handled by their mods (e.g. heartbeats update
    # workspace_members.last_heartbeat) and don't need a permanent event record.
    _SKIP_PERSIST = frozenset({"network.ping"})

    async def process(self, event: Event, context: PipelineContext) -> Optional[Event]:
        if event.type in self._SKIP_PERSIST:
            return None

        from app.models import EventRecord

        db = context.extra.get("db")
        workspace = context.extra.get("workspace")
        if not db or not workspace:
            logger.warning("persistence: no db or workspace in context, skipping")
            return None

        record = EventRecord(
            id=event.id,
            network_id=workspace.id,
            type=event.type,
            source=event.source,
            target=event.target,
            payload=event.payload,
            metadata_=event.metadata,
            timestamp=event.timestamp,
            visibility=event.visibility if isinstance(event.visibility, str) else event.visibility,
        )
        db.add(record)
        db.flush()  # flush, don't commit — the router commits

        if event.type.startswith("workspace.message") and event.target.startswith("channel/"):
            from sqlalchemy import update
            from app.models import Channel

            channel_name = event.target[len("channel/"):]
            db.execute(
                update(Channel)
                .where(
                    Channel.workspace_id == workspace.id,
                    Channel.name == channel_name,
                )
                .values(last_event_at=event.timestamp)
            )
            db.flush()

        if event.type == "workspace.message.posted" and event.target.startswith("channel/"):
            self._create_agent_deliveries(event, context, record)

        return None  # observe mods return value is ignored

    def _create_agent_deliveries(self, event: Event, context: PipelineContext, record) -> None:
        from app.models import AgentDelivery

        metadata = event.metadata or {}
        targets = metadata.get("target_agents")
        if not isinstance(targets, list) or targets == ["__no_response__"]:
            return

        payload = event.payload or {}
        if payload.get("message_type") in {"thinking", "status", "todos", "loading"}:
            return

        db = context.extra.get("db")
        workspace = context.extra.get("workspace")
        if not db or not workspace:
            return

        channel_name = event.target[len("channel/"):] if event.target.startswith("channel/") else None
        seen = set()
        for target in targets:
            if not isinstance(target, str) or not target or target in seen or target == "__no_response__":
                continue
            seen.add(target)
            existing = db.execute(
                select(AgentDelivery).where(
                    AgentDelivery.event_id == record.id,
                    AgentDelivery.agent_name == target,
                )
            ).scalar_one_or_none()
            if existing:
                continue
            db.add(AgentDelivery(
                workspace_id=workspace.id,
                event_id=record.id,
                agent_name=target,
                channel_name=channel_name,
                status="pending",
            ))
        db.flush()
