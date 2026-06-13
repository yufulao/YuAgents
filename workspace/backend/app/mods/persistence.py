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
        from app.models import AgentDelivery, Channel

        metadata = event.metadata or {}
        targets = metadata.get("target_agents")
        target_set = {
            target for target in targets
            if isinstance(target, str) and target and target != "__no_response__"
        } if isinstance(targets, list) else set()

        payload = event.payload or {}
        if payload.get("message_type") in {"thinking", "status", "todos", "loading"}:
            return

        db = context.extra.get("db")
        workspace = context.extra.get("workspace")
        if not db or not workspace:
            return

        channel_name = event.target[len("channel/"):] if event.target.startswith("channel/") else None
        if not channel_name:
            return
        channel = db.execute(
            select(Channel).where(
                Channel.workspace_id == workspace.id,
                Channel.name == channel_name,
            )
        ).scalar_one_or_none()
        if not channel:
            return

        participants = [
            participant.agent_name
            for participant in channel.participants
            if participant.agent_name
        ]
        sender = None
        if event.source and event.source.startswith("openagents:"):
            sender = event.source[len("openagents:"):]

        seen = set()
        for target in participants:
            if target in seen or target == sender:
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
            is_attention = target in target_set
            db.add(AgentDelivery(
                workspace_id=workspace.id,
                event_id=record.id,
                agent_name=target,
                channel_name=channel_name,
                delivery_kind="attention" if is_attention else "ambient",
                attention_reason=self._attention_reason(payload.get("content", ""), target) if is_attention else None,
                status="pending",
            ))
        db.flush()

    def _attention_reason(self, content: str, agent_name: str) -> str:
        if f"@{agent_name}" in (content or ""):
            return "mention"
        return "routed"
