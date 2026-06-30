# -*- coding: utf-8 -*-
"""
Workspace management endpoints — CRUD for the workspace itself.

These are NOT part of the ONM spec — they manage the product layer
(creating networks, listing user's workspaces, updating settings).

POST   /v1/workspaces              Create a new workspace
GET    /v1/workspaces              List workspaces
GET    /v1/workspaces/{id}         Get workspace details
PATCH  /v1/workspaces/{id}         Update workspace settings
DELETE /v1/workspaces/{id}         Delete workspace
PATCH  /v1/workspaces/{id}/members/{name}  Update agent description/role
"""

import json as _json
import logging
import re
import secrets
import time
import uuid
from datetime import datetime, timezone, timedelta
from typing import Dict, List, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.config import config
from app.agent_status import project_agent_status
from app.database import get_db
from app.models import (
    AgentConfig,
    Channel,
    ChannelMember,
    Workspace,
    WorkspaceCollaborator,
    WorkspaceMember,
)
from app.response import ResponseCode, json_response, success_response
from app.routers.network import _workspace_filter
from app.services.local_agent_control import LocalAgentControlError, control_local_agent
from app.task_activity import (
    AgentTaskActivity,
    active_task_activity_by_agent,
    active_task_activity_for_agent,
    task_activity_payload,
    task_activity_summary,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/workspaces", tags=["Workspaces"])

AGENT_TIMEOUT = timedelta(seconds=config.AGENT_TIMEOUT_SECONDS)
AGENT_NAME_RE = re.compile(r"^(?!.*[\s@:/\\])[^\s@:/\\]{1,64}$")
VALID_AGENT_LIFECYCLE = {"active", "disabled"}
VALID_AGENT_MODES = {"ask", "code", "autonomous", "plan", "execute"}
VALID_AGENT_QUALITY = {"low", "medium", "high", "xhigh", "max"}


def _extract_bearer(authorization: Optional[str]) -> Optional[str]:
    """Extract bearer token from Authorization header."""
    if authorization and authorization.lower().startswith("bearer "):
        return authorization[7:].strip()
    return None


def _verify_workspace_access(workspace, token: Optional[str], authorization: Optional[str]) -> bool:
    """Check if the caller has access to a workspace via token, bearer owner, or collaborator."""
    if not workspace.password_hash:
        return True
    if token and token == workspace.password_hash:
        return True
    bearer = _extract_bearer(authorization)
    if bearer:
        from app.firebase_auth import verify_firebase_token
        email = verify_firebase_token(bearer)
        if email:
            email_lower = email.lower()
            # Owner check
            if workspace.creator_email and email_lower == workspace.creator_email.lower():
                return True
            # Collaborator check (loaded via selectin)
            if any(c.email == email_lower for c in (workspace.collaborators or [])):
                return True
    return False


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------

class WorkspaceCreateRequest(BaseModel):
    name: str
    agent_name: Optional[str] = None   # Optional — if provided, becomes master member
    agent_type: Optional[str] = None   # "claude", "openclaw", etc.
    creator_email: Optional[str] = None

class ChannelUpdateRequest(BaseModel):
    title: Optional[str] = None
    status: Optional[str] = None
    starred: Optional[bool] = None
    master_agent: Optional[str] = None  # Reassign channel master
    visibility: Optional[str] = None
    mention_policy: Optional[str] = None
    auto_title: bool = False  # When True, title update is from auto-titling (don't mark as manually set)

class WorkspaceUpdateRequest(BaseModel):
    name: Optional[str] = None
    settings: Optional[dict] = None
    status: Optional[str] = None
    # Convenience top-level toggle for the Browser Fabric viewer in clients.
    # Stored inside `settings.browser_enabled` so we don't need a schema
    # migration — but exposed as a typed field so clients don't have to
    # round-trip the whole settings dict to flip one bool.
    browser_enabled: Optional[bool] = None
    browserfabric_api_key: Optional[str] = None

class CollaboratorAddRequest(BaseModel):
    email: str
    role: str = Field(default="editor", pattern=r"^(editor|viewer)$")


class PresencePingRequest(BaseModel):
    senderEmail: str
    senderDisplayName: Optional[str] = None


class WorkspaceResolveRequest(BaseModel):
    workspace: str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _mask_bf_key(key: str | None) -> str | None:
    if not key:
        return None
    if len(key) > 12:
        return key[:8] + "..." + key[-4:]
    return key[:4] + "..."


def _member_status(m: WorkspaceMember, now: datetime, cfg: AgentConfig | None = None) -> str:
    return str(project_agent_status(m, now, AGENT_TIMEOUT, cfg)["display_status"])


def _default_avatar(handle: str) -> dict:
    return {"type": "pixel", "value": handle}


def _merge_enabled_skills(member_skills: dict | None, cfg_skills: dict | None) -> dict | None:
    """Merge runtime skill install status with Web-managed skill toggles.

    AgentConfig owns user-visible module toggles, while WorkspaceMember receives
    launcher callbacks (`installed` and `skill_status`). Neither side should
    erase the other when formatting agents for the UI.
    """
    merged: dict = {}
    if isinstance(member_skills, dict):
        merged.update(member_skills)
    if isinstance(cfg_skills, dict):
        for key, value in cfg_skills.items():
            if key in {"installed", "skill_status"}:
                continue
            merged[key] = value

    installed: list[str] = []
    for source in (member_skills, cfg_skills):
        if isinstance(source, dict) and isinstance(source.get("installed"), list):
            for skill_id in source["installed"]:
                if isinstance(skill_id, str) and skill_id not in installed:
                    installed.append(skill_id)
    if installed:
        merged["installed"] = installed

    status_map: dict = {}
    for source in (member_skills, cfg_skills):
        if isinstance(source, dict) and isinstance(source.get("skill_status"), dict):
            status_map.update(source["skill_status"])
    if status_map:
        merged["skill_status"] = status_map

    return merged or None


def _is_data_url(value: object) -> bool:
    return isinstance(value, str) and value.startswith("data:")


def _compact_profile(value: object) -> object:
    if not isinstance(value, dict):
        return value
    compact = dict(value)
    if _is_data_url(compact.get("avatarUrl")):
        compact["avatarUrl"] = None
    return compact


def _compact_settings(settings: dict | None) -> dict:
    compact = dict(settings or {})
    profiles = compact.get("local_user_profiles")
    if isinstance(profiles, dict):
        compact["local_user_profiles"] = {
            key: _compact_profile(value)
            for key, value in profiles.items()
        }
    if "last_local_user_profile" in compact:
        compact["last_local_user_profile"] = _compact_profile(compact["last_local_user_profile"])
    return compact


def _compact_avatar_payload(avatar: dict | None) -> dict | None:
    if not isinstance(avatar, dict):
        return avatar
    compact = dict(avatar)
    if compact.get("type") == "upload" and _is_data_url(compact.get("value")):
        compact["value"] = ""
    return compact


def _format_member_agent(
    m: WorkspaceMember,
    now: datetime,
    cfg: AgentConfig | None = None,
    task_activity: AgentTaskActivity | None = None,
) -> dict:
    display_name = cfg.display_name if cfg else m.agent_name
    avatar = cfg.avatar if cfg else _default_avatar(m.agent_name)
    metadata = (cfg.config_metadata if cfg else None) or {}
    projected = project_agent_status(
        m,
        now,
        AGENT_TIMEOUT,
        cfg,
        active_task=task_activity is not None,
        waiting_on_dependency=task_activity.waiting_on_dependency if task_activity else False,
    )
    metadata_state = str(metadata.get("lifecycle_state") or "").lower()
    activity_summary = metadata.get("activity_summary")
    current_channel = metadata.get("current_channel")
    if task_activity and (not activity_summary or metadata_state in {"", "idle", "online", "offline", "stopped"}):
        activity_summary = task_activity_summary(task_activity)
        current_channel = current_channel or task_activity.task.channel_name
    avatar_url = avatar.get("value") if avatar.get("type") == "upload" else None
    return {
        "id": cfg.id if cfg else f"{m.workspace_id}:{m.agent_name}",
        "handle": m.agent_name,
        "agentName": m.agent_name,
        "displayName": display_name,
        "role": m.role,
        "agentType": cfg.agent_type if cfg else m.agent_type,
        "status": projected["display_status"],
        "lifecycleState": projected["activity_state"],
        "presenceStatus": projected["presence_status"],
        "activityState": projected["activity_state"],
        "workloadState": projected["workload_state"],
        "displayStatus": projected["display_status"],
        "isConnected": projected["is_connected"],
        "hasActiveWork": projected["has_active_work"],
        "description": m.description,
        "avatar": _compact_avatar_payload(avatar),
        "avatarUrl": avatar_url,
        "serverHost": m.server_host,
        "workingDir": cfg.working_dir if cfg and cfg.working_dir is not None else m.working_dir,
        "enabledSkills": _merge_enabled_skills(
            m.enabled_skills,
            cfg.enabled_skills if cfg else None,
        ),
        "modelProvider": cfg.model_provider if cfg else None,
        "model": cfg.model if cfg else None,
        "modelName": cfg.model if cfg else None,
        "mode": cfg.mode if cfg else None,
        "quality": cfg.quality if cfg else None,
        "credentialRef": cfg.credential_ref if cfg else None,
        "activitySummary": activity_summary,
        "currentChannel": current_channel,
        "activeTask": task_activity_payload(task_activity, camel_case=True),
        "managedMetadata": metadata,
        "lastHeartbeatAt": m.last_heartbeat.isoformat() if m.last_heartbeat else None,
        "joinedAt": m.joined_at.isoformat() if m.joined_at else None,
    }


def _format_member_summary(
    m: WorkspaceMember,
    now: datetime,
    cfg: AgentConfig | None = None,
    task_activity: AgentTaskActivity | None = None,
) -> dict:
    projected = project_agent_status(
        m,
        now,
        AGENT_TIMEOUT,
        cfg,
        active_task=task_activity is not None,
        waiting_on_dependency=task_activity.waiting_on_dependency if task_activity else False,
    )
    return {
        "id": cfg.id if cfg else f"{m.workspace_id}:{m.agent_name}",
        "handle": m.agent_name,
        "agentName": m.agent_name,
        "displayName": cfg.display_name if cfg else m.agent_name,
        "role": m.role,
        "agentType": cfg.agent_type if cfg else m.agent_type,
        "status": projected["display_status"],
        "lifecycleState": projected["activity_state"],
        "presenceStatus": projected["presence_status"],
        "activityState": projected["activity_state"],
        "workloadState": projected["workload_state"],
        "displayStatus": projected["display_status"],
        "isConnected": projected["is_connected"],
        "hasActiveWork": projected["has_active_work"],
        "description": m.description,
        "avatar": _default_avatar(cfg.display_name if cfg else m.agent_name),
        "avatarUrl": None,
        "serverHost": m.server_host,
        "workingDir": cfg.working_dir if cfg and cfg.working_dir is not None else m.working_dir,
        "enabledSkills": None,
        "modelProvider": None,
        "model": None,
        "modelName": None,
        "mode": None,
        "quality": None,
        "credentialRef": None,
        "activitySummary": None,
        "currentChannel": None,
        "activeTask": None,
        "managedMetadata": None,
        "lastHeartbeatAt": m.last_heartbeat.isoformat() if m.last_heartbeat else None,
        "joinedAt": m.joined_at.isoformat() if m.joined_at else None,
    }


def _format_workspace(
    ws: Workspace,
    members: list,
    now: datetime,
    task_activity_by_agent: dict[str, AgentTaskActivity] | None = None,
    summary: bool = False,
) -> dict:
    task_activity_by_agent = task_activity_by_agent or {}
    agents = [
        (_format_member_summary if summary else _format_member_agent)(
            m,
            now,
            getattr(m, "_agent_config", None),
            task_activity_by_agent.get(m.agent_name),
        )
        for m in members
    ]

    settings = _compact_settings(ws.settings or {})
    return {
        "workspaceId": str(ws.id),
        "slug": ws.slug,
        "name": ws.name,
        "creatorEmail": ws.creator_email,
        "settings": settings,
        # Surface browser_enabled at the top level for clients that don't
        # want to dig into the settings dict. Mirrors what's inside settings.
        "browserEnabled": bool(settings.get("browser_enabled", False)),
        "browserfabricApiKey": _mask_bf_key(settings.get("browserfabric_api_key")),
        "status": ws.status,
        "createdAt": ws.created_at.isoformat() if ws.created_at else None,
        "lastActivityAt": ws.last_activity_at.isoformat() if ws.last_activity_at else None,
        "agents": agents,
    }


def _attach_agent_configs(db: Session, workspace_id: str, members: list[WorkspaceMember]) -> None:
    configs = db.execute(
        select(AgentConfig).where(AgentConfig.workspace_id == workspace_id)
    ).scalars().all()
    by_handle = {c.handle: c for c in configs}
    for member in members:
        setattr(member, "_agent_config", by_handle.get(member.agent_name))


def _format_channel(ch: Channel) -> dict:
    return {
        "channelId": str(ch.id),
        "workspaceId": str(ch.workspace_id),
        "name": ch.name,
        "title": ch.title,
        "titleManuallySet": bool(ch.title_manually_set),
        "createdBy": ch.created_by,
        "masterAgent": ch.master_agent,
        "resumeFrom": ch.resume_from,
        "visibility": ch.visibility or "public",
        "mentionPolicy": ch.mention_policy or "members_only",
        "status": ch.status,
        "starred": bool(ch.starred),
        "participants": [p.agent_name for p in (ch.participants or [])],
        "createdAt": ch.created_at.isoformat() if ch.created_at else None,
    }


def _normalize_workspace_name(name: str | None) -> str:
    return (name or "").strip()


def _workspace_name_exists(db: Session, name: str, *, exclude_id: UUID | None = None) -> bool:
    query = select(Workspace).where(
        Workspace.status != "deleted",
        Workspace.name == name,
    )
    if exclude_id is not None:
        query = query.where(Workspace.id != exclude_id)
    return db.execute(query).scalar_one_or_none() is not None


def _local_agent_control_endpoint() -> str:
    """Return the local backend URL that on-machine agents should call.

    The request base URL may be the public relay host when the UI is opened via
    oa.yodaze.com. Local agents must still talk to the local control plane
    directly; otherwise redirects or public relay routing can make heartbeats
    silently fail while the local daemon keeps running.
    """
    configured = (config.LOCAL_AGENT_CONTROL_ENDPOINT or "").strip().rstrip("/")
    if configured:
        return configured
    return f"http://127.0.0.1:{config.PORT}"


# ---------------------------------------------------------------------------
# POST /v1/workspaces — Create workspace
# ---------------------------------------------------------------------------

@router.post("")
def create_workspace(
    body: WorkspaceCreateRequest,
    db: Session = Depends(get_db),
):
    """Create a new workspace (= ONM network)."""
    if not config.WORKSPACE_CREATION_ENABLED:
        return json_response(
            ResponseCode.FORBIDDEN,
            "Workspace creation is disabled on this deployment; use an existing workspace slug and token",
        )

    workspace_name = _normalize_workspace_name(body.name)
    if not workspace_name:
        return json_response(ResponseCode.BAD_REQUEST, "Workspace name is required")
    if _workspace_name_exists(db, workspace_name):
        return json_response(ResponseCode.BAD_REQUEST, f"Workspace '{workspace_name}' already exists")

    # Generate slug and token
    slug = secrets.token_hex(4)
    token = secrets.token_urlsafe(32)

    now = datetime.now(timezone.utc)

    workspace = Workspace(
        slug=slug,
        name=workspace_name,
        creator_email=body.creator_email,
        password_hash=token,
        settings={},
        status="active",
    )
    db.add(workspace)
    db.flush()

    # Optionally add the creating agent as master member
    if body.agent_name:
        member = WorkspaceMember(
            workspace_id=workspace.id,
            agent_name=body.agent_name,
            role="master",
            agent_type=body.agent_type,
            status="online",
            last_heartbeat=now,
        )
        db.add(member)

    # Create default channel (Session 1)
    channel = Channel(
        workspace_id=workspace.id,
        name=f"session-{secrets.token_hex(4)}",
        title="Session 1",
        created_by=body.agent_name or body.creator_email,
        master_agent=body.agent_name,  # None if no agent provided
        status="active",
    )
    db.add(channel)
    db.flush()

    # Add creator as channel participant if provided
    if body.agent_name:
        participant = ChannelMember(
            channel_id=channel.id,
            agent_name=body.agent_name,
        )
        db.add(participant)

    db.commit()
    db.refresh(workspace)

    return success_response({
        "workspaceId": str(workspace.id),
        "slug": workspace.slug,
        "name": workspace.name,
        "token": token,
        "channel": _format_channel(channel),
    })


# ---------------------------------------------------------------------------
# GET /v1/workspaces — List workspaces
# ---------------------------------------------------------------------------

@router.get("")
def list_workspaces(
    creator_email: Optional[str] = Query(None),
    agent_name: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    """List workspaces, optionally filtered by creator or agent membership."""
    if not config.WORKSPACE_DIRECTORY_ENABLED:
        return json_response(
            ResponseCode.FORBIDDEN,
            "Workspace directory is disabled on this deployment; open by workspace slug and token",
        )

    query = select(Workspace).where(Workspace.status != "deleted")

    if creator_email:
        query = query.where(Workspace.creator_email == creator_email)

    if agent_name:
        query = query.join(WorkspaceMember).where(
            WorkspaceMember.agent_name == agent_name
        )

    query = query.options(selectinload(Workspace.members))
    workspaces = db.execute(query.order_by(Workspace.last_activity_at.desc())).scalars().all()
    now = datetime.now(timezone.utc)
    for ws in workspaces:
        _attach_agent_configs(db, str(ws.id), ws.members)

    results = [
        _format_workspace(
            ws,
            ws.members,
            now,
            {},
            summary=True,
        )
        for ws in workspaces
    ]

    return success_response(results)


# ---------------------------------------------------------------------------
# GET /v1/workspaces/skill-catalog  (static — no auth required)
# Must be defined before /{workspace_id} to avoid path capture.
# ---------------------------------------------------------------------------

@router.get("/skill-catalog")
async def skill_catalog():
    """Return the full skill catalog (public, static data)."""
    from app.skill_catalog import get_catalog
    return success_response(get_catalog())


# ---------------------------------------------------------------------------
# POST /v1/workspaces/resolve — Resolve entry input to canonical workspace slug
# ---------------------------------------------------------------------------

@router.post("/resolve")
def resolve_workspace(
    body: WorkspaceResolveRequest,
    db: Session = Depends(get_db),
    x_workspace_token: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    """Resolve a user-entered workspace slug/id/name to canonical workspace data.

    The workbench should run on canonical slugs after this point because many
    realtime/event endpoints use the network id as an exact id/slug. Names are
    accepted only here, and only when they uniquely identify one active
    workspace.
    """
    value = body.workspace.strip()
    if not value:
        return json_response(ResponseCode.BAD_REQUEST, "Workspace name or slug is required")

    workspace = db.execute(
        select(Workspace).where(_workspace_filter(value))
    ).scalar_one_or_none()

    if not workspace:
        matches = db.execute(
            select(Workspace).where(
                Workspace.status != "deleted",
                Workspace.name == value,
            )
        ).scalars().all()
        if len(matches) > 1:
            return json_response(ResponseCode.BAD_REQUEST, "Multiple workspaces have this name; use the workspace slug")
        workspace = matches[0] if matches else None

    if not workspace or workspace.status == "deleted":
        return json_response(ResponseCode.NOT_FOUND, "Workspace not found")

    if not _verify_workspace_access(workspace, x_workspace_token, authorization):
        return json_response(ResponseCode.UNAUTHORIZED, "Invalid workspace credentials")

    members = db.execute(
        select(WorkspaceMember).where(WorkspaceMember.workspace_id == workspace.id)
    ).scalars().all()
    _attach_agent_configs(db, str(workspace.id), members)

    now = datetime.now(timezone.utc)
    return success_response(_format_workspace(
        workspace,
        members,
        now,
        {},
        summary=True,
    ))


# ---------------------------------------------------------------------------
# GET /v1/workspaces/{workspace_id} — Get workspace
# ---------------------------------------------------------------------------

@router.get("/{workspace_id}")
def get_workspace(
    workspace_id: str,
    db: Session = Depends(get_db),
    x_workspace_token: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    """Get workspace details by ID or slug."""
    workspace = db.execute(
        select(Workspace).where(_workspace_filter(workspace_id))
    ).scalar_one_or_none()

    if not workspace or workspace.status == "deleted":
        return json_response(ResponseCode.NOT_FOUND, "Workspace not found")

    if not _verify_workspace_access(workspace, x_workspace_token, authorization):
        return json_response(ResponseCode.UNAUTHORIZED, "Invalid workspace credentials")

    members = db.execute(
        select(WorkspaceMember).where(WorkspaceMember.workspace_id == workspace.id)
    ).scalars().all()
    _attach_agent_configs(db, str(workspace.id), members)

    now = datetime.now(timezone.utc)
    return success_response(_format_workspace(
        workspace,
        members,
        now,
        active_task_activity_by_agent(db, str(workspace.id)),
    ))


# ---------------------------------------------------------------------------
# PATCH /v1/workspaces/{workspace_id} — Update workspace
# ---------------------------------------------------------------------------

@router.patch("/{workspace_id}")
def update_workspace(
    workspace_id: str,
    body: WorkspaceUpdateRequest,
    db: Session = Depends(get_db),
    x_workspace_token: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    """Update workspace name, settings, or status."""
    workspace = db.execute(
        select(Workspace).where(_workspace_filter(workspace_id))
    ).scalar_one_or_none()

    if not workspace:
        return json_response(ResponseCode.NOT_FOUND, "Workspace not found")

    if not _verify_workspace_access(workspace, x_workspace_token, authorization):
        return json_response(ResponseCode.UNAUTHORIZED, "Invalid workspace credentials")

    if body.name is not None:
        next_name = _normalize_workspace_name(body.name)
        if not next_name:
            return json_response(ResponseCode.BAD_REQUEST, "Workspace name is required")
        if _workspace_name_exists(db, next_name, exclude_id=workspace.id):
            return json_response(ResponseCode.BAD_REQUEST, f"Workspace '{next_name}' already exists")
        workspace.name = next_name
    if body.settings is not None:
        workspace.settings = body.settings
    if body.browser_enabled is not None:
        current = dict(workspace.settings or {})
        current["browser_enabled"] = body.browser_enabled
        workspace.settings = current
    if body.browserfabric_api_key is not None:
        current = dict(workspace.settings or {})
        if body.browserfabric_api_key == "":
            current.pop("browserfabric_api_key", None)
        else:
            current["browserfabric_api_key"] = body.browserfabric_api_key
        workspace.settings = current
    if body.status is not None:
        workspace.status = body.status

    db.commit()
    db.refresh(workspace)

    members = db.execute(
        select(WorkspaceMember).where(WorkspaceMember.workspace_id == workspace.id)
    ).scalars().all()
    _attach_agent_configs(db, str(workspace.id), members)

    now = datetime.now(timezone.utc)
    return success_response(_format_workspace(
        workspace,
        members,
        now,
        active_task_activity_by_agent(db, str(workspace.id)),
    ))


# ---------------------------------------------------------------------------
# POST /v1/workspaces/{workspace_id}/claim — Claim workspace ownership
# ---------------------------------------------------------------------------

@router.post("/{workspace_id}/claim")
def claim_workspace(
    workspace_id: str,
    db: Session = Depends(get_db),
    authorization: Optional[str] = Header(None),
):
    """
    Claim ownership of a workspace.

    Requires a valid Firebase bearer token. Sets creator_email on the workspace
    so the user can access it without a workspace token.
    """
    bearer = _extract_bearer(authorization)
    if not bearer:
        return json_response(ResponseCode.UNAUTHORIZED, "Bearer token required")

    from app.firebase_auth import verify_firebase_token
    email = verify_firebase_token(bearer)
    if not email:
        return json_response(ResponseCode.UNAUTHORIZED, "Invalid or expired token")

    workspace = db.execute(
        select(Workspace).where(_workspace_filter(workspace_id))
    ).scalar_one_or_none()

    if not workspace:
        return json_response(ResponseCode.NOT_FOUND, "Workspace not found")

    if workspace.creator_email and workspace.creator_email != email:
        return json_response(ResponseCode.FORBIDDEN, "Workspace already claimed by another user")

    workspace.creator_email = email
    db.commit()
    db.refresh(workspace)

    members = db.execute(
        select(WorkspaceMember).where(WorkspaceMember.workspace_id == workspace.id)
    ).scalars().all()
    _attach_agent_configs(db, str(workspace.id), members)

    now = datetime.now(timezone.utc)
    return success_response(_format_workspace(
        workspace,
        members,
        now,
        active_task_activity_by_agent(db, str(workspace.id)),
    ))


# ---------------------------------------------------------------------------
# GET /v1/workspaces/{workspace_id}/local-token
# ---------------------------------------------------------------------------

@router.get("/{workspace_id}/local-token")
def get_local_workspace_token(
    workspace_id: str,
    db: Session = Depends(get_db),
):
    """Return the workspace token for trusted local-control deployments.

    This endpoint is intentionally disabled by the same flags used to hide
    workspace creation/directory on remote public Web deployments.
    """
    if not (config.WORKSPACE_CREATION_ENABLED and config.WORKSPACE_DIRECTORY_ENABLED):
        return json_response(ResponseCode.FORBIDDEN, "Workspace token discovery is disabled on this deployment")

    workspace = db.execute(
        select(Workspace).where(_workspace_filter(workspace_id))
    ).scalar_one_or_none()

    if not workspace or workspace.status == "deleted":
        return json_response(ResponseCode.NOT_FOUND, "Workspace not found")

    return success_response({
        "workspaceId": str(workspace.id),
        "slug": workspace.slug,
        "token": workspace.password_hash,
    })


# ---------------------------------------------------------------------------
# POST /v1/workspaces/{workspace_id}/rotate-token
# ---------------------------------------------------------------------------

@router.post("/{workspace_id}/rotate-token")
def rotate_token(
    workspace_id: str,
    db: Session = Depends(get_db),
    x_workspace_token: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    """Rotate the workspace token. Old token immediately stops working.

    Requires either the current workspace token or Firebase bearer auth
    from the workspace owner.
    """
    workspace = db.execute(
        select(Workspace).where(_workspace_filter(workspace_id))
    ).scalar_one_or_none()

    if not workspace:
        return json_response(ResponseCode.NOT_FOUND, "Workspace not found")

    if not _verify_workspace_access(workspace, x_workspace_token, authorization):
        return json_response(ResponseCode.UNAUTHORIZED, "Invalid credentials")

    new_token = secrets.token_urlsafe(32)
    workspace.password_hash = new_token
    db.commit()

    return success_response({
        "workspace_id": str(workspace.id),
        "token": new_token,
    })


# ---------------------------------------------------------------------------
# POST /v1/workspaces/{workspace_id}/agents — Create a web-managed agent config
# ---------------------------------------------------------------------------

class MemberUpdateRequest(BaseModel):
    description: Optional[str] = None
    role: Optional[str] = None
    enabled_skills: Optional[Dict[str, bool]] = None
    display_name: Optional[str] = None
    avatar_url: Optional[str] = None
    server_host: Optional[str] = None
    working_dir: Optional[str] = None
    agent_type: Optional[str] = None
    model_provider: Optional[str] = None
    model_name: Optional[str] = None
    mode: Optional[str] = None
    quality: Optional[str] = None
    lifecycle_status: Optional[str] = None
    managed_metadata: Optional[dict] = None


class ManagedAgentCreateRequest(BaseModel):
    agent_name: str
    agent_type: str = "local"
    role: str = "member"
    display_name: Optional[str] = None
    avatar_url: Optional[str] = None
    server_host: Optional[str] = None
    working_dir: Optional[str] = None
    description: Optional[str] = None
    enabled_skills: Optional[Dict[str, bool]] = None
    model_provider: Optional[str] = None
    model_name: Optional[str] = None
    mode: Optional[str] = "execute"
    quality: Optional[str] = "medium"
    lifecycle_status: str = "active"
    managed_metadata: Optional[dict] = None


class LocalAgentControlRequest(BaseModel):
    action: str = Field(default="start", pattern=r"^(start|restart|stop)$")


def _validate_agent_config(body) -> Optional[str]:
    if not AGENT_NAME_RE.match(body.agent_name):
        return "Agent name must be 1-64 chars and cannot contain whitespace, @, :, /, or \\"
    if getattr(body, "lifecycle_status", "active") not in VALID_AGENT_LIFECYCLE:
        return f"Invalid lifecycle_status: {body.lifecycle_status}"
    if getattr(body, "mode", None) and body.mode not in VALID_AGENT_MODES:
        return f"Invalid mode: {body.mode}"
    if getattr(body, "quality", None) and body.quality not in VALID_AGENT_QUALITY:
        return f"Invalid quality: {body.quality}"
    return None


@router.post("/{workspace_id}/agents")
def create_managed_agent(
    workspace_id: str,
    body: ManagedAgentCreateRequest,
    db: Session = Depends(get_db),
    x_workspace_token: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    """Create an agent membership/config from the web UI without launching a runtime."""
    workspace = db.execute(
        select(Workspace).where(_workspace_filter(workspace_id))
    ).scalar_one_or_none()

    if not workspace:
        return json_response(ResponseCode.NOT_FOUND, "Workspace not found")

    if not _verify_workspace_access(workspace, x_workspace_token, authorization):
        return json_response(ResponseCode.UNAUTHORIZED, "Invalid credentials")

    validation_error = _validate_agent_config(body)
    if validation_error:
        return json_response(ResponseCode.BAD_REQUEST, validation_error)

    existing = db.execute(
        select(WorkspaceMember).where(
            WorkspaceMember.workspace_id == workspace.id,
            WorkspaceMember.agent_name == body.agent_name,
        )
    ).scalar_one_or_none()
    if existing:
        return json_response(ResponseCode.BAD_REQUEST, f"Agent '{body.agent_name}' already exists")
    existing_cfg = db.execute(
        select(AgentConfig).where(
            AgentConfig.workspace_id == workspace.id,
            AgentConfig.handle == body.agent_name,
        )
    ).scalar_one_or_none()
    if existing_cfg:
        return json_response(ResponseCode.BAD_REQUEST, f"Agent '{body.agent_name}' already exists")

    disabled = body.lifecycle_status == "disabled"
    member = WorkspaceMember(
        workspace_id=workspace.id,
        agent_name=body.agent_name,
        role=body.role or "member",
        agent_type=body.agent_type or "local",
        server_host=body.server_host or None,
        working_dir=body.working_dir or None,
        description=body.description or None,
        enabled_skills=body.enabled_skills or None,
        status="offline" if not disabled else "stopped",
    )
    db.add(member)
    cfg_metadata = dict(body.managed_metadata or {})
    if disabled:
        cfg_metadata["disabled"] = True
    cfg = AgentConfig(
        workspace_id=workspace.id,
        handle=body.agent_name,
        display_name=body.display_name or body.agent_name,
        avatar={"type": "upload", "value": body.avatar_url} if body.avatar_url else _default_avatar(body.agent_name),
        agent_type=body.agent_type or "local",
        model_provider=body.model_provider or None,
        model=body.model_name or None,
        mode=body.mode or "execute",
        quality=body.quality or None,
        working_dir=body.working_dir or None,
        enabled_skills=body.enabled_skills or None,
        config_metadata=cfg_metadata or None,
    )
    db.add(cfg)
    db.commit()

    now = datetime.now(timezone.utc)
    return success_response(_format_member_agent(
        member,
        now,
        cfg,
        active_task_activity_for_agent(db, str(workspace.id), member.agent_name),
    ))


@router.patch("/{workspace_id}/agents/{agent_name}")
def update_managed_agent(
    workspace_id: str,
    agent_name: str,
    body: MemberUpdateRequest,
    db: Session = Depends(get_db),
    x_workspace_token: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    return update_member(workspace_id, agent_name, body, db, x_workspace_token, authorization)


@router.delete("/{workspace_id}/agents/{agent_name}")
def delete_managed_agent(
    workspace_id: str,
    agent_name: str,
    db: Session = Depends(get_db),
    x_workspace_token: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    return remove_member(workspace_id, agent_name, db, x_workspace_token, authorization)


@router.post("/{workspace_id}/agents/{agent_name}/control")
def control_managed_agent(
    workspace_id: str,
    agent_name: str,
    body: LocalAgentControlRequest,
    request: Request,
    db: Session = Depends(get_db),
    x_workspace_token: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    """Start, restart, or stop a Web-managed local agent through agent-connector."""
    workspace = db.execute(
        select(Workspace).where(_workspace_filter(workspace_id))
    ).scalar_one_or_none()

    if not workspace:
        return json_response(ResponseCode.NOT_FOUND, "Workspace not found")

    if not _verify_workspace_access(workspace, x_workspace_token, authorization):
        return json_response(ResponseCode.UNAUTHORIZED, "Invalid credentials")

    member = db.execute(
        select(WorkspaceMember).where(
            WorkspaceMember.workspace_id == workspace.id,
            WorkspaceMember.agent_name == agent_name,
        )
    ).scalar_one_or_none()
    if not member:
        return json_response(ResponseCode.NOT_FOUND, "Member not found")

    cfg = db.execute(
        select(AgentConfig).where(
            AgentConfig.workspace_id == workspace.id,
            AgentConfig.handle == agent_name,
        )
    ).scalar_one_or_none()

    agent_type = (cfg.agent_type if cfg else member.agent_type) or "local"
    if agent_type.startswith("cloud:"):
        return json_response(ResponseCode.BAD_REQUEST, "Cloud agents are not controlled by the local daemon")

    metadata = dict(cfg.config_metadata or {}) if cfg else {}
    if metadata.get("disabled"):
        return json_response(ResponseCode.BAD_REQUEST, "Agent is disabled; enable it before starting")

    endpoint = _local_agent_control_endpoint()
    control_started_at = datetime.now(timezone.utc)
    try:
        result = control_local_agent(
            action=body.action,
            endpoint=endpoint,
            workspace={
                "id": str(workspace.id),
                "slug": workspace.slug,
                "name": workspace.name,
                "token": workspace.password_hash,
            },
            agent={
                "name": member.agent_name,
                "type": agent_type,
                "role": member.role,
                "workingDir": (cfg.working_dir if cfg and cfg.working_dir is not None else member.working_dir),
                "model": cfg.model if cfg else None,
                "quality": cfg.quality if cfg else None,
                "metadata": metadata,
            },
        )
    except LocalAgentControlError as exc:
        return json_response(ResponseCode.BAD_REQUEST, str(exc))

    now = datetime.now(timezone.utc)
    if body.action == "stop":
        member.status = "offline"
    else:
        # Cold-start races with the daemon's first /v1/join: the child process
        # can mark the member online before this control request returns. Do
        # not clobber that fresher online state back to starting.
        db.refresh(member)
        heartbeat = member.last_heartbeat
        if heartbeat and heartbeat.tzinfo is None:
            heartbeat = heartbeat.replace(tzinfo=timezone.utc)
        has_fresh_online_join = (
            member.status == "online"
            and heartbeat is not None
            and heartbeat >= control_started_at
        )
        if not has_fresh_online_join:
            member.status = "starting"
            member.last_heartbeat = now
    db.commit()

    return success_response({
        "agent": _format_member_agent(
            member,
            now,
            cfg,
            active_task_activity_for_agent(db, str(workspace.id), member.agent_name),
        ),
        "control": result,
    })


# ---------------------------------------------------------------------------
# DELETE /v1/workspaces/{workspace_id}/members/{agent_name}
# ---------------------------------------------------------------------------

@router.delete("/{workspace_id}/members/{agent_name}")
def remove_member(
    workspace_id: str,
    agent_name: str,
    db: Session = Depends(get_db),
    x_workspace_token: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    """Remove an agent from a workspace."""
    workspace = db.execute(
        select(Workspace).where(_workspace_filter(workspace_id))
    ).scalar_one_or_none()

    if not workspace:
        return json_response(ResponseCode.NOT_FOUND, "Workspace not found")

    if not _verify_workspace_access(workspace, x_workspace_token, authorization):
        return json_response(ResponseCode.UNAUTHORIZED, "Invalid credentials")

    member = db.execute(
        select(WorkspaceMember).where(
            WorkspaceMember.workspace_id == workspace.id,
            WorkspaceMember.agent_name == agent_name,
        )
    ).scalar_one_or_none()

    if not member:
        return json_response(ResponseCode.NOT_FOUND, "Member not found")

    cfg = db.execute(
        select(AgentConfig).where(
            AgentConfig.workspace_id == workspace.id,
            AgentConfig.handle == agent_name,
        )
    ).scalar_one_or_none()
    if cfg:
        db.delete(cfg)
    db.delete(member)
    db.commit()

    return success_response({"agent_name": agent_name, "removed": True})


# ---------------------------------------------------------------------------
# PATCH /v1/workspaces/{workspace_id}/members/{agent_name}
# ---------------------------------------------------------------------------

@router.patch("/{workspace_id}/members/{agent_name}")
def update_member(
    workspace_id: str,
    agent_name: str,
    body: MemberUpdateRequest,
    db: Session = Depends(get_db),
    x_workspace_token: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    """Update an agent's metadata (description, role)."""
    workspace = db.execute(
        select(Workspace).where(_workspace_filter(workspace_id))
    ).scalar_one_or_none()

    if not workspace:
        return json_response(ResponseCode.NOT_FOUND, "Workspace not found")

    if not _verify_workspace_access(workspace, x_workspace_token, authorization):
        return json_response(ResponseCode.UNAUTHORIZED, "Invalid credentials")

    member = db.execute(
        select(WorkspaceMember).where(
            WorkspaceMember.workspace_id == workspace.id,
            WorkspaceMember.agent_name == agent_name,
        )
    ).scalar_one_or_none()

    if not member:
        return json_response(ResponseCode.NOT_FOUND, "Member not found")

    cfg = db.execute(
        select(AgentConfig).where(
            AgentConfig.workspace_id == workspace.id,
            AgentConfig.handle == agent_name,
        )
    ).scalar_one_or_none()
    needs_config = any([
        body.display_name is not None,
        body.avatar_url is not None,
        body.model_provider is not None,
        body.model_name is not None,
        body.mode is not None,
        body.quality is not None,
        body.lifecycle_status is not None,
        body.managed_metadata is not None,
    ])
    if needs_config and not cfg:
        cfg = AgentConfig(
            workspace_id=workspace.id,
            handle=agent_name,
            display_name=agent_name,
            avatar=_default_avatar(agent_name),
            agent_type=member.agent_type or "local",
            working_dir=member.working_dir,
            enabled_skills=member.enabled_skills,
        )
        db.add(cfg)

    if body.description is not None:
        member.description = body.description
    if body.role is not None:
        member.role = body.role
    if body.display_name is not None:
        cfg.display_name = body.display_name or agent_name
    if body.avatar_url is not None:
        cfg.avatar = {"type": "upload", "value": body.avatar_url} if body.avatar_url else _default_avatar(agent_name)
    if body.server_host is not None:
        member.server_host = body.server_host or None
    if body.working_dir is not None:
        member.working_dir = body.working_dir or None
        if cfg:
            cfg.working_dir = body.working_dir or None
    if body.agent_type is not None:
        member.agent_type = body.agent_type or None
        if cfg:
            cfg.agent_type = body.agent_type or "local"
    if body.model_provider is not None:
        cfg.model_provider = body.model_provider or None
    if body.model_name is not None:
        cfg.model = body.model_name or None
    if body.mode is not None:
        if body.mode and body.mode not in VALID_AGENT_MODES:
            return json_response(ResponseCode.BAD_REQUEST, f"Invalid mode: {body.mode}")
        cfg.mode = body.mode or "execute"
    if body.quality is not None:
        if body.quality and body.quality not in VALID_AGENT_QUALITY:
            return json_response(ResponseCode.BAD_REQUEST, f"Invalid quality: {body.quality}")
        cfg.quality = body.quality or None
    if body.lifecycle_status is not None:
        if body.lifecycle_status not in VALID_AGENT_LIFECYCLE:
            return json_response(ResponseCode.BAD_REQUEST, f"Invalid lifecycle_status: {body.lifecycle_status}")
        metadata = dict(cfg.config_metadata or {})
        if body.lifecycle_status == "disabled":
            metadata["disabled"] = True
            member.status = "stopped"
        else:
            metadata.pop("disabled", None)
            member.status = "offline"
        cfg.config_metadata = metadata or None
    if body.managed_metadata is not None:
        metadata = dict(body.managed_metadata or {})
        if cfg and cfg.config_metadata and cfg.config_metadata.get("disabled"):
            metadata["disabled"] = True
        cfg.config_metadata = metadata or None
    if body.enabled_skills is not None:
        from app.skill_catalog import get_skill_defaults
        defaults = get_skill_defaults()
        valid = {k: v for k, v in body.enabled_skills.items() if k in defaults}
        member.enabled_skills = valid or None
        if cfg:
            cfg.enabled_skills = member.enabled_skills

    db.commit()

    now = datetime.now(timezone.utc)
    return success_response(_format_member_agent(
        member,
        now,
        cfg,
        active_task_activity_for_agent(db, str(workspace.id), member.agent_name),
    ))


# ---------------------------------------------------------------------------
# POST /v1/workspaces/{workspace_id}/members/{agent_name}/skills/install
# DELETE /v1/workspaces/{workspace_id}/members/{agent_name}/skills/uninstall
# ---------------------------------------------------------------------------

class SkillInstallRequest(BaseModel):
    skill_id: str


class SkillStatusRequest(BaseModel):
    skill_id: str
    state: str  # "installing" | "installed" | "failed" | "uninstalled"
    path: Optional[str] = None
    error: Optional[str] = None
    partial: Optional[bool] = None  # SKILL.md fetched but bundled files missing


_VALID_SKILL_STATES = {"installing", "installed", "failed", "uninstalled"}


def _emit_agent_control_event(db, workspace, agent_name: str, action: str, payload: dict) -> None:
    """Persist a ``workspace.agent.control`` event targeted at one agent and
    publish it to the workspace's Redis pub/sub channel.

    The launcher's per-agent control poller
    (``GET /v1/events?type=workspace.agent.control&target=openagents:<name>``)
    picks this up and dispatches the action to the adapter. We write the
    EventRecord directly — mirroring mod/persistence — rather than running the
    full event pipeline, because the caller has already verified workspace
    access and there is no human/agent source to authenticate.
    """
    from app import cache
    from app.models import EventRecord

    event_id = str(uuid.uuid4())
    timestamp = int(time.time() * 1000)
    full_payload = {"action": action, **(payload or {})}
    record = EventRecord(
        id=event_id,
        network_id=workspace.id,
        type="workspace.agent.control",
        source="human:system",
        target=f"openagents:{agent_name}",
        payload=full_payload,
        metadata_={},
        timestamp=timestamp,
        visibility="direct",
    )
    db.add(record)
    db.flush()

    try:
        snapshot = {
            "id": event_id,
            "type": "workspace.agent.control",
            "source": "human:system",
            "target": f"openagents:{agent_name}",
            "payload": full_payload,
            "metadata": {},
            "timestamp": timestamp,
        }
        cache.publish_event(
            f"ws:{workspace.id}:events",
            _json.dumps(snapshot, default=str, separators=(",", ":")).encode(),
        )
    except Exception:
        # Pub/sub is a fast-path optimization; the poller still finds the
        # persisted event. Never fail the request on a cache hiccup.
        logger.warning("install_skill: failed to publish control event to cache", exc_info=True)


def _set_skill_status(skills_data: dict, skill_id: str, state: str,
                      path: Optional[str] = None, error: Optional[str] = None,
                      partial: Optional[bool] = None) -> dict:
    """Update the per-skill status map inside an ``enabled_skills`` dict.

    Keeps the legacy ``installed`` list in sync (only successfully-installed
    skills appear there, so existing readers keep working) and stores richer
    state under ``skill_status`` for the UI.
    """
    status_map = dict(skills_data.get("skill_status", {}))
    entry = {"state": state, "updated_at": int(time.time() * 1000)}
    if path:
        entry["path"] = path
    if error:
        entry["error"] = error[:2000]
    if partial:
        entry["partial"] = True
    status_map[skill_id] = entry
    skills_data["skill_status"] = status_map

    installed = [s for s in skills_data.get("installed", []) if s != skill_id]
    if state == "installed":
        installed.append(skill_id)
    skills_data["installed"] = installed
    return skills_data


@router.post("/{workspace_id}/members/{agent_name}/skills/install")
async def install_skill(
    workspace_id: str,
    agent_name: str,
    body: SkillInstallRequest,
    db: Session = Depends(get_db),
    x_workspace_token: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    """Request installation of a third-party skill for an agent.

    Marks the skill ``installing`` and emits a ``skill.install`` control event
    so the launcher actually installs it into the agent's skills directory.
    The agent reports back via ``/skills/status`` to flip the state to
    ``installed`` or ``failed`` — the skill is NOT marked installed here.
    """
    from app.skill_catalog import find_skill

    workspace = db.execute(
        select(Workspace).where(_workspace_filter(workspace_id))
    ).scalar_one_or_none()
    if not workspace:
        return json_response(ResponseCode.NOT_FOUND, "Workspace not found")
    if not _verify_workspace_access(workspace, x_workspace_token, authorization):
        return json_response(ResponseCode.UNAUTHORIZED, "Invalid credentials")

    member = db.execute(
        select(WorkspaceMember).where(
            WorkspaceMember.workspace_id == workspace.id,
            WorkspaceMember.agent_name == agent_name,
        )
    ).scalar_one_or_none()
    if not member:
        return json_response(ResponseCode.NOT_FOUND, "Member not found")

    skill = find_skill(body.skill_id)
    if not skill:
        return json_response(ResponseCode.NOT_FOUND, f"Unknown skill: {body.skill_id}")

    skills_data = dict(member.enabled_skills or {})
    skills_data = _set_skill_status(skills_data, body.skill_id, "installing")
    member.enabled_skills = skills_data

    # Carry the catalog metadata the launcher needs to fetch the skill.
    _emit_agent_control_event(db, workspace, agent_name, "skill.install", {
        "skill": {
            "id": skill["id"],
            "name": skill.get("name", skill["id"]),
            "description": skill.get("description", ""),
            "source_repo": skill.get("source_repo", ""),
            "source_path": skill.get("source_path", ""),
        },
    })
    db.commit()

    logger.info(
        "install_skill: queued install of '%s' for agent '%s' in workspace %s",
        body.skill_id, agent_name, workspace.id,
    )
    return success_response({
        "agentName": agent_name,
        "skillId": body.skill_id,
        "action": "installing",
        "state": "installing",
        "installedSkills": list(skills_data.get("installed", [])),
        "skillStatus": skills_data.get("skill_status", {}),
    })


@router.post("/{workspace_id}/members/{agent_name}/skills/status")
async def report_skill_status(
    workspace_id: str,
    agent_name: str,
    body: SkillStatusRequest,
    db: Session = Depends(get_db),
    x_workspace_token: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    """Launcher → workspace callback reporting skill install progress/result.

    Updates ``enabled_skills.skill_status`` so the Skill Hub UI can render
    installing → installed / failed, and keeps the legacy ``installed`` list
    in sync. Also re-publishes to the SSE channel for instant UI updates.
    """
    if body.state not in _VALID_SKILL_STATES:
        return json_response(ResponseCode.BAD_REQUEST, f"Invalid state: {body.state}")

    workspace = db.execute(
        select(Workspace).where(_workspace_filter(workspace_id))
    ).scalar_one_or_none()
    if not workspace:
        return json_response(ResponseCode.NOT_FOUND, "Workspace not found")
    if not _verify_workspace_access(workspace, x_workspace_token, authorization):
        return json_response(ResponseCode.UNAUTHORIZED, "Invalid credentials")

    member = db.execute(
        select(WorkspaceMember).where(
            WorkspaceMember.workspace_id == workspace.id,
            WorkspaceMember.agent_name == agent_name,
        )
    ).scalar_one_or_none()
    if not member:
        return json_response(ResponseCode.NOT_FOUND, "Member not found")

    skills_data = dict(member.enabled_skills or {})
    if body.state == "uninstalled":
        # Drop the status entry entirely on uninstall.
        status_map = dict(skills_data.get("skill_status", {}))
        status_map.pop(body.skill_id, None)
        skills_data["skill_status"] = status_map
        skills_data["installed"] = [
            s for s in skills_data.get("installed", []) if s != body.skill_id
        ]
    else:
        skills_data = _set_skill_status(
            skills_data, body.skill_id, body.state, body.path, body.error, body.partial
        )
    member.enabled_skills = skills_data

    cfg = db.execute(
        select(AgentConfig).where(
            AgentConfig.workspace_id == workspace.id,
            AgentConfig.handle == agent_name,
        )
    ).scalar_one_or_none()
    if cfg:
        cfg_skills = dict(cfg.enabled_skills or {})
        if body.state == "uninstalled":
            status_map = dict(cfg_skills.get("skill_status", {}))
            status_map.pop(body.skill_id, None)
            cfg_skills["skill_status"] = status_map
            cfg_skills["installed"] = [
                s for s in cfg_skills.get("installed", []) if s != body.skill_id
            ]
        else:
            cfg_skills = _set_skill_status(
                cfg_skills, body.skill_id, body.state, body.path, body.error, body.partial
            )
        cfg.enabled_skills = cfg_skills
    db.commit()

    if body.state == "failed":
        logger.error(
            "skill install FAILED: skill='%s' agent='%s' workspace=%s error=%s",
            body.skill_id, agent_name, workspace.id, body.error,
        )
    elif body.state == "installed" and body.partial:
        logger.warning(
            "skill installed PARTIALLY (SKILL.md only, bundled files missing): "
            "skill='%s' agent='%s'", body.skill_id, agent_name,
        )
    else:
        logger.info(
            "skill status: skill='%s' agent='%s' state='%s'",
            body.skill_id, agent_name, body.state,
        )

    # Push a lightweight status event so SSE-connected UIs update instantly.
    try:
        from app import cache
        snapshot = {
            "id": str(uuid.uuid4()),
            "type": "workspace.skill.status",
            "source": f"openagents:{agent_name}",
            "target": f"openagents:{agent_name}",
            "payload": {
                "skill_id": body.skill_id,
                "state": body.state,
                "error": body.error,
            },
            "metadata": {},
            "timestamp": int(time.time() * 1000),
        }
        cache.publish_event(
            f"ws:{workspace.id}:events",
            _json.dumps(snapshot, default=str, separators=(",", ":")).encode(),
        )
    except Exception:
        pass

    return success_response({
        "agentName": agent_name,
        "skillId": body.skill_id,
        "state": body.state,
        "installedSkills": list(skills_data.get("installed", [])),
        "skillStatus": skills_data.get("skill_status", {}),
    })


@router.post("/{workspace_id}/members/{agent_name}/skills/uninstall")
async def uninstall_skill(
    workspace_id: str,
    agent_name: str,
    body: SkillInstallRequest,
    db: Session = Depends(get_db),
    x_workspace_token: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    """Uninstall a third-party skill from an agent.

    Removes it from the DB immediately (optimistic) and emits a
    ``skill.uninstall`` control event so the launcher deletes the on-disk
    skill directory.
    """
    from app.skill_catalog import find_skill

    workspace = db.execute(
        select(Workspace).where(_workspace_filter(workspace_id))
    ).scalar_one_or_none()
    if not workspace:
        return json_response(ResponseCode.NOT_FOUND, "Workspace not found")
    if not _verify_workspace_access(workspace, x_workspace_token, authorization):
        return json_response(ResponseCode.UNAUTHORIZED, "Invalid credentials")

    member = db.execute(
        select(WorkspaceMember).where(
            WorkspaceMember.workspace_id == workspace.id,
            WorkspaceMember.agent_name == agent_name,
        )
    ).scalar_one_or_none()
    if not member:
        return json_response(ResponseCode.NOT_FOUND, "Member not found")

    skills_data = dict(member.enabled_skills or {})
    installed = [s for s in skills_data.get("installed", []) if s != body.skill_id]
    skills_data["installed"] = installed
    status_map = dict(skills_data.get("skill_status", {}))
    status_map.pop(body.skill_id, None)
    skills_data["skill_status"] = status_map
    member.enabled_skills = skills_data

    skill = find_skill(body.skill_id) or {"id": body.skill_id}
    _emit_agent_control_event(db, workspace, agent_name, "skill.uninstall", {
        "skill": {
            "id": skill["id"],
            "name": skill.get("name", skill["id"]),
            "source_repo": skill.get("source_repo", ""),
            "source_path": skill.get("source_path", ""),
        },
    })
    db.commit()

    return success_response({
        "agentName": agent_name,
        "skillId": body.skill_id,
        "action": "uninstalled",
        "installedSkills": installed,
    })


# ---------------------------------------------------------------------------
# GET /v1/workspaces/{workspace_id}/channels/{channel_name}
# ---------------------------------------------------------------------------

@router.get("/{workspace_id}/channels/{channel_name}")
def get_channel(
    workspace_id: str,
    channel_name: str,
    db: Session = Depends(get_db),
    x_workspace_token: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    """Get channel details."""
    workspace = db.execute(
        select(Workspace).where(_workspace_filter(workspace_id))
    ).scalar_one_or_none()
    if not workspace:
        return json_response(ResponseCode.NOT_FOUND, "Workspace not found")
    if not _verify_workspace_access(workspace, x_workspace_token, authorization):
        return json_response(ResponseCode.UNAUTHORIZED, "Invalid credentials")

    channel = db.execute(
        select(Channel).where(
            Channel.workspace_id == workspace.id,
            Channel.name == channel_name,
        )
    ).scalar_one_or_none()
    if not channel:
        return json_response(ResponseCode.NOT_FOUND, "Channel not found")

    return success_response(_format_channel(channel))


# ---------------------------------------------------------------------------
# PATCH /v1/workspaces/{workspace_id}/channels/{channel_name}
# ---------------------------------------------------------------------------

@router.patch("/{workspace_id}/channels/{channel_name}")
def update_channel(
    workspace_id: str,
    channel_name: str,
    body: ChannelUpdateRequest,
    db: Session = Depends(get_db),
    x_workspace_token: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    """Update channel title or status."""
    workspace = db.execute(
        select(Workspace).where(_workspace_filter(workspace_id))
    ).scalar_one_or_none()
    if not workspace:
        return json_response(ResponseCode.NOT_FOUND, "Workspace not found")
    if not _verify_workspace_access(workspace, x_workspace_token, authorization):
        return json_response(ResponseCode.UNAUTHORIZED, "Invalid credentials")

    channel = db.execute(
        select(Channel).where(
            Channel.workspace_id == workspace.id,
            Channel.name == channel_name,
        )
    ).scalar_one_or_none()
    if not channel:
        return json_response(ResponseCode.NOT_FOUND, "Channel not found")

    if body.title is not None:
        channel.title = body.title
        if not body.auto_title:
            channel.title_manually_set = True
    if body.status is not None:
        channel.status = body.status
    if body.starred is not None:
        channel.starred = body.starred
    if body.master_agent is not None:
        channel.master_agent = body.master_agent
    if body.visibility is not None:
        if body.visibility not in {"public", "private", "system"}:
            return json_response(ResponseCode.BAD_REQUEST, f"Invalid visibility: {body.visibility}")
        channel.visibility = body.visibility
    if body.mention_policy is not None:
        if body.mention_policy not in {"members_only", "workspace_members", "disabled"}:
            return json_response(ResponseCode.BAD_REQUEST, f"Invalid mention_policy: {body.mention_policy}")
        channel.mention_policy = body.mention_policy

    db.commit()
    db.refresh(channel)
    return success_response(_format_channel(channel))


# ---------------------------------------------------------------------------
# DELETE /v1/workspaces/{workspace_id} — Delete workspace
# ---------------------------------------------------------------------------

@router.delete("/{workspace_id}")
def delete_workspace(
    workspace_id: str,
    db: Session = Depends(get_db),
    x_workspace_token: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    """Soft-delete a workspace (set status to 'deleted'). Requires workspace token or Firebase owner auth."""
    workspace = db.execute(
        select(Workspace).where(_workspace_filter(workspace_id))
    ).scalar_one_or_none()

    if not workspace or workspace.status == "deleted":
        return json_response(ResponseCode.NOT_FOUND, "Workspace not found")

    if not _verify_workspace_access(workspace, x_workspace_token, authorization):
        return json_response(ResponseCode.UNAUTHORIZED, "Invalid credentials")

    workspace.status = "deleted"
    db.commit()

    return success_response({"workspaceId": str(workspace.id), "status": "deleted"})


# ---------------------------------------------------------------------------
# Collaborator management (email-based sharing)
# ---------------------------------------------------------------------------

def _format_collaborator(c: WorkspaceCollaborator) -> dict:
    return {
        "email": c.email,
        "displayName": c.display_name,
        "role": c.role,
        "addedBy": c.added_by,
        "addedAt": c.added_at.isoformat() if c.added_at else None,
    }


@router.get("/{workspace_id}/collaborators")
def list_collaborators(
    workspace_id: str,
    db: Session = Depends(get_db),
    x_workspace_token: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    """List email-based collaborators for a workspace."""
    workspace = db.execute(
        select(Workspace).where(_workspace_filter(workspace_id))
    ).scalar_one_or_none()
    if not workspace:
        return json_response(ResponseCode.NOT_FOUND, "Workspace not found")
    if not _verify_workspace_access(workspace, x_workspace_token, authorization):
        return json_response(ResponseCode.UNAUTHORIZED, "Invalid credentials")

    collabs = [_format_collaborator(c) for c in (workspace.collaborators or [])]
    return success_response({
        "collaborators": collabs,
        "owner": workspace.creator_email,
    })


@router.post("/{workspace_id}/presence")
async def record_presence(
    workspace_id: str,
    body: PresencePingRequest,
    db: Session = Depends(get_db),
    x_workspace_token: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    """Self-register the calling human as a workspace collaborator.

    Called by the web/Swift clients on workspace open once the user is
    signed in. The mention picker reads from `workspace_collaborators`,
    so this is what makes a freshly-logged-in human show up in @-picker
    rows without having to post a message first.
    """
    workspace = db.execute(
        select(Workspace).where(_workspace_filter(workspace_id))
    ).scalar_one_or_none()
    if not workspace:
        return json_response(ResponseCode.NOT_FOUND, "Workspace not found")
    if not _verify_workspace_access(workspace, x_workspace_token, authorization):
        return json_response(ResponseCode.UNAUTHORIZED, "Invalid credentials")

    email = (body.senderEmail or "").strip().lower()
    if not email or "@" not in email:
        return json_response(ResponseCode.BAD_REQUEST, "Invalid email address")

    from app.mods.workspace_mod import _upsert_human_collaborator
    _upsert_human_collaborator(
        workspace,
        {"sender_email": email, "sender_display_name": body.senderDisplayName},
        db,
    )
    db.commit()

    existing = db.execute(
        select(WorkspaceCollaborator).where(
            WorkspaceCollaborator.workspace_id == str(workspace.id),
            WorkspaceCollaborator.email == email,
        )
    ).scalar_one_or_none()
    return success_response(_format_collaborator(existing) if existing else {"email": email})


@router.post("/{workspace_id}/collaborators")
def add_collaborator(
    workspace_id: str,
    body: CollaboratorAddRequest,
    db: Session = Depends(get_db),
    x_workspace_token: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    """Add an email-based collaborator to a workspace."""
    workspace = db.execute(
        select(Workspace).where(_workspace_filter(workspace_id))
    ).scalar_one_or_none()
    if not workspace:
        return json_response(ResponseCode.NOT_FOUND, "Workspace not found")
    if not _verify_workspace_access(workspace, x_workspace_token, authorization):
        return json_response(ResponseCode.UNAUTHORIZED, "Invalid credentials")

    email = body.email.strip().lower()
    if not email or "@" not in email:
        return json_response(ResponseCode.BAD_REQUEST, "Invalid email address")

    # Can't add the owner as a collaborator
    if workspace.creator_email and email == workspace.creator_email.lower():
        return json_response(ResponseCode.CONFLICT, "This email is already the workspace owner")

    # Determine who is adding (from bearer token if available)
    added_by = None
    bearer = _extract_bearer(authorization)
    if bearer:
        from app.firebase_auth import verify_firebase_token
        added_by = verify_firebase_token(bearer)

    # Upsert: update role if already exists
    existing = db.execute(
        select(WorkspaceCollaborator).where(
            WorkspaceCollaborator.workspace_id == workspace.id,
            WorkspaceCollaborator.email == email,
        )
    ).scalar_one_or_none()

    if existing:
        existing.role = body.role
        db.commit()
        db.refresh(existing)
        return success_response(_format_collaborator(existing))

    collab = WorkspaceCollaborator(
        workspace_id=workspace.id,
        email=email,
        role=body.role,
        added_by=added_by,
    )
    db.add(collab)
    db.commit()
    db.refresh(collab)
    return success_response(_format_collaborator(collab))


@router.delete("/{workspace_id}/collaborators/{email}")
def remove_collaborator(
    workspace_id: str,
    email: str,
    db: Session = Depends(get_db),
    x_workspace_token: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    """Remove an email-based collaborator from a workspace."""
    workspace = db.execute(
        select(Workspace).where(_workspace_filter(workspace_id))
    ).scalar_one_or_none()
    if not workspace:
        return json_response(ResponseCode.NOT_FOUND, "Workspace not found")
    if not _verify_workspace_access(workspace, x_workspace_token, authorization):
        return json_response(ResponseCode.UNAUTHORIZED, "Invalid credentials")

    email_lower = email.strip().lower()
    collab = db.execute(
        select(WorkspaceCollaborator).where(
            WorkspaceCollaborator.workspace_id == workspace.id,
            WorkspaceCollaborator.email == email_lower,
        )
    ).scalar_one_or_none()

    if not collab:
        return json_response(ResponseCode.NOT_FOUND, "Collaborator not found")

    db.delete(collab)
    db.commit()
    return success_response({"email": email_lower, "removed": True})
