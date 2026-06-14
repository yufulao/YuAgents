# -*- coding: utf-8 -*-
"""Shared channel visibility helpers for workspace read/write boundaries."""

from typing import Optional

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.models import Channel, ChannelHumanMember, ChannelMember, EventRecord, Workspace, WorkspaceMember


CLOSED_CHANNEL_VISIBILITIES = {"private", "system"}


def is_closed_channel(channel: Channel) -> bool:
    return (channel.visibility or "public") in CLOSED_CHANNEL_VISIBILITIES


def human_email_from_authorization(authorization: Optional[str]) -> Optional[str]:
    if not authorization or not authorization.lower().startswith("bearer "):
        return None
    bearer = authorization[7:].strip()
    if not bearer:
        return None
    from app.firebase_auth import verify_firebase_token

    email = verify_firebase_token(bearer)
    return email.lower() if email else None


def agent_session_is_current(
    db: Session,
    workspace: Workspace,
    member: Optional[str],
    session_id: Optional[str],
) -> bool:
    if not member or not session_id:
        return False
    return db.execute(
        select(WorkspaceMember).where(
            WorkspaceMember.workspace_id == workspace.id,
            WorkspaceMember.agent_name == member,
            WorkspaceMember.session_id == session_id,
        )
    ).scalar_one_or_none() is not None


def is_workspace_owner(workspace: Workspace, email: Optional[str]) -> bool:
    return bool(email and workspace.creator_email and email == workspace.creator_email.lower())


def human_is_channel_member(db: Session, channel: Channel, email: Optional[str]) -> bool:
    if not email:
        return False
    return db.execute(
        select(ChannelHumanMember).where(
            ChannelHumanMember.channel_id == channel.id,
            ChannelHumanMember.user_email == email.lower(),
        )
    ).scalar_one_or_none() is not None


def visible_channel_names(
    db: Session,
    workspace: Workspace,
    *,
    member: Optional[str] = None,
    session_id: Optional[str] = None,
    human_email: Optional[str] = None,
    include_public: bool = True,
) -> list[str]:
    """Return channel names visible to the scoped reader.

    Unscoped token-only readers only see public channels. Closed channels
    require explicit agent channel membership, explicit human channel
    membership, or workspace ownership via bearer identity.
    """
    query = select(Channel).where(
        Channel.workspace_id == workspace.id,
        Channel.status != "deleted",
    )
    channels = db.execute(query).scalars().all()

    if is_workspace_owner(workspace, human_email):
        return [c.name for c in channels]

    trusted_member = member if agent_session_is_current(db, workspace, member, session_id) else None
    include_public = include_public or trusted_member is None

    agent_channel_ids = set()
    if trusted_member:
        agent_channel_ids = set(db.execute(
            select(ChannelMember.channel_id)
            .join(Channel, Channel.id == ChannelMember.channel_id)
            .where(
                Channel.workspace_id == workspace.id,
                ChannelMember.agent_name == trusted_member,
            )
        ).scalars().all())

    human_channel_ids = set()
    if human_email:
        human_channel_ids = set(db.execute(
            select(ChannelHumanMember.channel_id).where(
                ChannelHumanMember.user_email == human_email.lower()
            )
        ).scalars().all())

    visible = []
    for channel in channels:
        if include_public and not is_closed_channel(channel):
            visible.append(channel.name)
        elif channel.id in agent_channel_ids or channel.id in human_channel_ids:
            visible.append(channel.name)
    return visible


def apply_event_channel_visibility(
    query,
    db: Session,
    workspace: Workspace,
    *,
    member: Optional[str] = None,
    session_id: Optional[str] = None,
    human_email: Optional[str] = None,
    include_public: bool = True,
):
    """Constrain an EventRecord query so closed channel events cannot leak."""
    channel_targets = [
        f"channel/{name}"
        for name in visible_channel_names(
            db,
            workspace,
            member=member,
            session_id=session_id,
            human_email=human_email,
            include_public=include_public,
        )
    ]
    non_channel = ~EventRecord.target.startswith("channel/")
    if not channel_targets:
        return query.where(non_channel)
    return query.where(or_(non_channel, EventRecord.target.in_(channel_targets)))
