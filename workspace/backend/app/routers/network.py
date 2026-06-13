# -*- coding: utf-8 -*-
"""
ONM Network endpoints — agent lifecycle and discovery.

These endpoints are convenience wrappers that translate REST calls into
ONM events and push them through the mod pipeline.

POST /v1/join         → network.agent.join event
POST /v1/leave        → network.agent.leave event
POST /v1/heartbeat    → network.ping event
GET  /v1/discover     Discover agents, channels, resources
GET  /v1/profile      Network profile metadata
"""

import json
import logging
import os
import re
import shutil
import subprocess
import tomllib
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, Header, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import config
from app.agent_status import project_agent_status
from app.channel_visibility import human_email_from_authorization, visible_channel_names
from app.database import get_db
from app.models import AgentConfig, Channel, Workspace, WorkspaceMember
from app.pipeline_factory import pipeline
from app.response import ResponseCode, json_response, success_response
from openagents.core.onm_events import Event
from openagents.core.onm_mods import EventRejected, PipelineContext

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1", tags=["Network"])

AGENT_TIMEOUT = timedelta(seconds=config.AGENT_TIMEOUT_SECONDS)


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------

class JoinRequest(BaseModel):
    agent_name: str
    token: str                         # workspace token
    network: Optional[str] = None      # workspace ID or slug
    agent_type: Optional[str] = None   # "claude", "openclaw", etc.
    server_host: Optional[str] = None  # hostname/IP where agent runs
    working_dir: Optional[str] = None  # working directory on the server

class LeaveRequest(BaseModel):
    agent_name: str
    network: str
    session_id: Optional[str] = None  # issued by /v1/join; stale leave must not offline a newer session

class RemoveRequest(BaseModel):
    agent_name: str
    network: str

class HeartbeatRequest(BaseModel):
    agent_name: str
    network: str
    session_id: Optional[str] = None  # issued by /v1/join; mismatch → session_revoked

class ComposingRequest(BaseModel):
    network: str
    channel: str

class TokenResolveRequest(BaseModel):
    token: str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_UUID_RE = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', re.I)


def _workspace_filter(identifier: str):
    """Build a SQLAlchemy filter for Workspace by ID (UUID) or slug.

    Non-UUID strings are only matched against slug to avoid PostgreSQL
    cast errors on the UUID id column.
    """
    if _UUID_RE.match(identifier):
        return (Workspace.id == identifier) | (Workspace.slug == identifier)
    return Workspace.slug == identifier


def _resolve_workspace(db: Session, network: str) -> Optional[Workspace]:
    """Resolve workspace by ID or slug."""
    return db.execute(
        select(Workspace).where(_workspace_filter(network))
    ).scalar_one_or_none()


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


async def _emit_event(event: Event, workspace, db: Session, token: str = None):
    """Push an event through the mod pipeline. Returns None on rejection."""
    context = PipelineContext(
        network_id=str(workspace.id),
        agent_address=event.source,
        db=db,
        workspace=workspace,
        token=token,
    )
    try:
        result = await pipeline.process(event, context)
    except EventRejected:
        return None
    db.commit()
    return result


# ---------------------------------------------------------------------------
# POST /v1/join
# ---------------------------------------------------------------------------

@router.post("/join")
async def join_network(
    body: JoinRequest,
    db: Session = Depends(get_db),
):
    """Agent requests to join a network (workspace)."""
    if body.network:
        workspace = _resolve_workspace(db, body.network)
    else:
        # Token-only join: resolve workspace from token
        workspace = db.execute(
            select(Workspace).where(
                Workspace.password_hash == body.token,
                Workspace.status != "deleted",
            )
        ).scalar_one_or_none()
    if not workspace:
        return json_response(ResponseCode.NOT_FOUND, "Network not found")

    payload = {"agent_name": body.agent_name}
    if body.agent_type:
        payload["agent_type"] = body.agent_type
    if body.server_host:
        payload["server_host"] = body.server_host
    if body.working_dir:
        payload["working_dir"] = body.working_dir

    event = Event(
        type="network.agent.join",
        source=f"openagents:{body.agent_name}",
        target="core",
        payload=payload,
    )

    result = await _emit_event(event, workspace, db, token=body.token)
    if result is None:
        return json_response(ResponseCode.UNAUTHORIZED, "Invalid network token")

    return success_response({
        "network_id": str(workspace.id),
        "agent_name": body.agent_name,
        "role": result.metadata.get("role", "member"),
        "status": "online",
        "session_id": result.metadata.get("session_id"),
    })


# ---------------------------------------------------------------------------
# POST /v1/leave
# ---------------------------------------------------------------------------

@router.post("/leave")
async def leave_network(
    body: LeaveRequest,
    db: Session = Depends(get_db),
):
    """Agent announces departure from a network."""
    workspace = _resolve_workspace(db, body.network)
    if not workspace:
        return json_response(ResponseCode.NOT_FOUND, "Network not found")

    event = Event(
        type="network.agent.leave",
        source=f"openagents:{body.agent_name}",
        target="core",
        payload={
            "agent_name": body.agent_name,
            "session_id": body.session_id,
        },
    )

    # Pass workspace token since leave doesn't carry one — already authenticated by knowing the network
    result = await _emit_event(event, workspace, db, token=workspace.password_hash)
    if result is None:
        return json_response(ResponseCode.NOT_FOUND, "Agent not in network")

    if result.metadata.get("session_error") == "session_revoked":
        return success_response({"agent_name": body.agent_name, "status": "online", "ignored": True})

    return success_response({"agent_name": body.agent_name, "status": "offline"})


# ---------------------------------------------------------------------------
# POST /v1/remove — Remove agent from network
# ---------------------------------------------------------------------------

@router.post("/remove")
async def remove_agent(
    body: RemoveRequest,
    db: Session = Depends(get_db),
    x_workspace_token: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    """Remove an agent from a network (workspace). Reassigns master if needed."""
    workspace = _resolve_workspace(db, body.network)
    if not workspace:
        return json_response(ResponseCode.NOT_FOUND, "Network not found")

    if not _verify_workspace_access(workspace, x_workspace_token, authorization):
        return json_response(ResponseCode.UNAUTHORIZED, "Invalid credentials")

    event = Event(
        type="network.agent.remove",
        source="human:user",
        target="core",
        payload={
            "agent_name": body.agent_name,
        },
    )

    result = await _emit_event(event, workspace, db, token=workspace.password_hash)
    if result is None:
        return json_response(ResponseCode.NOT_FOUND, "Agent not in network")

    resp = {"agent_name": body.agent_name, "status": "removed"}
    if result.metadata.get("new_master"):
        resp["new_master"] = result.metadata["new_master"]
    return success_response(resp)


# ---------------------------------------------------------------------------
# POST /v1/heartbeat
# ---------------------------------------------------------------------------

@router.post("/heartbeat")
async def heartbeat(
    body: HeartbeatRequest,
    db: Session = Depends(get_db),
):
    """Agent presence heartbeat."""
    workspace = _resolve_workspace(db, body.network)
    if not workspace:
        return json_response(ResponseCode.NOT_FOUND, "Network not found")

    event = Event(
        type="network.ping",
        source=f"openagents:{body.agent_name}",
        target="core",
        payload={
            "agent_name": body.agent_name,
            "session_id": body.session_id,
        },
    )

    result = await _emit_event(event, workspace, db, token=workspace.password_hash)
    if result is None:
        return json_response(ResponseCode.NOT_FOUND, "Agent not in network")

    if result.metadata.get("session_error") == "session_revoked":
        # Another client has since joined as this agent; tell the caller
        # to stop its adapter for this agent.
        return json_response(
            ResponseCode.UNAUTHORIZED,
            "session_revoked: another client is now running as this agent",
        )

    return success_response({"agent_name": body.agent_name, "status": "online"})


# ---------------------------------------------------------------------------
# POST /v1/composing
# ---------------------------------------------------------------------------

@router.post("/composing")
async def composing_signal(
    body: ComposingRequest,
    db: Session = Depends(get_db),
    x_workspace_token: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    """Record that a user is actively typing in a channel."""
    workspace = _resolve_workspace(db, body.network)
    if not workspace:
        return json_response(ResponseCode.NOT_FOUND, "Network not found")

    if not _verify_workspace_access(workspace, x_workspace_token, authorization):
        return json_response(ResponseCode.UNAUTHORIZED, "Invalid credentials")

    from app.composing import set_composing
    set_composing(str(workspace.id), body.channel)
    return success_response({"status": "ok"})


# ---------------------------------------------------------------------------
# POST /v1/token/resolve
# ---------------------------------------------------------------------------

@router.post("/token/resolve")
def resolve_token(
    body: TokenResolveRequest,
    db: Session = Depends(get_db),
):
    """Resolve a workspace token to workspace info."""
    workspace = db.execute(
        select(Workspace).where(
            Workspace.password_hash == body.token,
            Workspace.status != "deleted",
        )
    ).scalar_one_or_none()
    if not workspace:
        return json_response(ResponseCode.NOT_FOUND, "Invalid or expired token")

    return success_response({
        "workspace_id": str(workspace.id),
        "slug": workspace.slug,
        "name": workspace.name,
        "endpoint": config.WORKSPACE_ENDPOINT if hasattr(config, 'WORKSPACE_ENDPOINT') else None,
    })


# ---------------------------------------------------------------------------
# GET /v1/discover — discovery doesn't go through the pipeline
# ---------------------------------------------------------------------------

@router.get("/discover")
def discover(
    network: str = Query(..., description="Network (workspace) ID"),
    member: Optional[str] = Query(None, description="Optional agent-name scope for private channel visibility"),
    session_id: Optional[str] = Query(None, description="Session id proving the member agent identity"),
    db: Session = Depends(get_db),
    x_workspace_token: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    """Discover agents, channels, and resources in a network."""
    workspace = _resolve_workspace(db, network)
    if not workspace:
        return json_response(ResponseCode.NOT_FOUND, "Network not found")

    if not _verify_workspace_access(workspace, x_workspace_token, authorization):
        return json_response(ResponseCode.UNAUTHORIZED, "Invalid workspace credentials")

    now = datetime.now(timezone.utc)

    members = db.execute(
        select(WorkspaceMember).where(WorkspaceMember.workspace_id == workspace.id)
    ).scalars().all()
    configs = db.execute(
        select(AgentConfig).where(AgentConfig.workspace_id == str(workspace.id))
    ).scalars().all()
    configs_by_handle = {c.handle: c for c in configs}

    agents = []
    for m in members:
        cfg = configs_by_handle.get(m.agent_name)
        metadata = (cfg.config_metadata if cfg else None) or {}
        projected = project_agent_status(m, now, AGENT_TIMEOUT, cfg)
        agents.append({
            "id": cfg.id if cfg else f"{workspace.id}:{m.agent_name}",
            "address": f"openagents:{m.agent_name}",
            "handle": m.agent_name,
            "display_name": cfg.display_name if cfg else m.agent_name,
            "role": m.role,
            "status": projected["display_status"],
            "lifecycle_state": projected["activity_state"],
            "presence_status": projected["presence_status"],
            "activity_state": projected["activity_state"],
            "workload_state": projected["workload_state"],
            "display_status": projected["display_status"],
            "is_connected": projected["is_connected"],
            "has_active_work": projected["has_active_work"],
            "agent_type": cfg.agent_type if cfg else m.agent_type,
            "avatar": cfg.avatar if cfg else {"type": "pixel", "value": m.agent_name},
            "avatar_url": (cfg.avatar or {}).get("value") if cfg and (cfg.avatar or {}).get("type") == "upload" else None,
            "server_host": m.server_host,
            "working_dir": cfg.working_dir if cfg and cfg.working_dir is not None else m.working_dir,
            "description": m.description,
            "enabled_skills": cfg.enabled_skills if cfg and cfg.enabled_skills is not None else m.enabled_skills,
            "model_provider": cfg.model_provider if cfg else None,
            "model": cfg.model if cfg else None,
            "model_name": cfg.model if cfg else None,
            "mode": cfg.mode if cfg else None,
            "quality": cfg.quality if cfg else None,
            "credential_ref": cfg.credential_ref if cfg else None,
            "activity_summary": metadata.get("activity_summary"),
            "current_channel": metadata.get("current_channel"),
            "managed_metadata": metadata,
            "last_heartbeat_at": m.last_heartbeat.isoformat() if m.last_heartbeat else None,
            "joined_at": m.joined_at.isoformat() if m.joined_at else None,
        })

    human_email = human_email_from_authorization(authorization)
    visible_names = visible_channel_names(
        db,
        workspace,
        member=member,
        session_id=session_id,
        human_email=human_email,
        include_public=True,
    )
    channels_query = select(Channel).where(
        Channel.workspace_id == workspace.id,
        Channel.status != "deleted",
        Channel.name.in_(visible_names),
    )
    channels_rows = db.execute(channels_query).scalars().all()

    channels = []
    for c in channels_rows:
        target_key = f"channel/{c.name}"
        created_at_ts = int(c.created_at.timestamp() * 1000) if c.created_at else None
        channels.append({
            "address": target_key,
            "title": c.title,
            "master": c.master_agent,
            "participants": [p.agent_name for p in (c.participants or [])],
            "visibility": c.visibility or "public",
            "mention_policy": c.mention_policy or "members_only",
            "created_at": created_at_ts,
            "last_event_at": c.last_event_at,
            "status": c.status or "active",
            "starred": bool(c.starred) if c.starred is not None else False,
        })

    return success_response({
        "agents": agents,
        "channels": channels,
        "mods": ["mod/auth", "mod/workspace", "mod/persistence"],
        "resources": [],
    })


# ---------------------------------------------------------------------------
# GET /v1/profile
# ---------------------------------------------------------------------------

@router.get("/profile")
def network_profile(
    network: str = Query(..., description="Network (workspace) ID"),
    db: Session = Depends(get_db),
    x_workspace_token: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    """Return the network profile (metadata, transports, capabilities)."""
    workspace = _resolve_workspace(db, network)
    if not workspace:
        return json_response(ResponseCode.NOT_FOUND, "Network not found")

    if not _verify_workspace_access(workspace, x_workspace_token, authorization):
        return json_response(ResponseCode.UNAUTHORIZED, "Invalid workspace credentials")

    online_count = len(db.execute(
        select(WorkspaceMember).where(
            WorkspaceMember.workspace_id == workspace.id,
            WorkspaceMember.status == "online",
        )
    ).scalars().all())

    return success_response({
        "id": str(workspace.id),
        "slug": workspace.slug,
        "name": workspace.name,
        "access": {
            "policy": "token",
            "min_verification": 0,
        },
        "status": workspace.status,
        "capabilities": [
            "workspace.message",
            "network.channel",
            "network.agent",
        ],
        "agents_online": online_count,
    })


# ── Agent catalog (supported client types) ──────────────────────────────

_AGENT_CATALOG = [
    {
        "name": "claude",
        "label": "Claude Code",
        "description": "Use the local Claude Code CLI and its local configuration",
        "install_command": "curl -fsSL https://claude.ai/install.sh | bash",
        "homepage": "https://claude.ai",
        "tags": ["coding", "anthropic", "cli"],
        "builtin": True,
        "featured": True,
        "order": 1,
    },
    {
        "name": "codex",
        "label": "OpenAI Codex CLI",
        "description": "Use the local Codex CLI and its local configuration",
        "install_command": "npm install -g @openai/codex",
        "homepage": "https://github.com/openai/codex",
        "tags": ["coding", "openai", "cli"],
        "builtin": True,
        "featured": True,
        "order": 2,
    },
]


@router.get("/agent-catalog")
def agent_catalog():
    """Return the catalog of supported agent client types."""
    return success_response(_AGENT_CATALOG)


def _codex_home() -> Path:
    configured = os.environ.get("CODEX_HOME")
    return Path(configured).expanduser() if configured else Path.home() / ".codex"


def _read_codex_config(codex_home: Path) -> dict:
    config_path = codex_home / "config.toml"
    if not config_path.exists():
        return {"path": str(config_path), "exists": False}

    with config_path.open("rb") as f:
        data = tomllib.load(f)

    allowed = {
        "model": data.get("model"),
        "model_reasoning_effort": data.get("model_reasoning_effort"),
        "model_provider": data.get("model_provider"),
        "approval_policy": data.get("approval_policy"),
        "sandbox_mode": data.get("sandbox_mode"),
    }
    return {
        "path": str(config_path),
        "exists": True,
        **{k: v for k, v in allowed.items() if v is not None},
    }


def _read_codex_models(codex_home: Path) -> list[dict]:
    cache_path = codex_home / "models_cache.json"
    if not cache_path.exists():
        return []

    with cache_path.open("r", encoding="utf-8") as f:
        payload = json.load(f)

    models = payload.get("models") or []
    result = []
    for item in models:
        slug = item.get("slug")
        if not slug:
            continue
        result.append({
            "slug": slug,
            "display_name": item.get("display_name") or slug,
            "description": item.get("description") or "",
            "default_reasoning_level": item.get("default_reasoning_level"),
            "supported_reasoning_levels": item.get("supported_reasoning_levels") or [],
            "additional_speed_tiers": item.get("additional_speed_tiers") or [],
            "service_tiers": item.get("service_tiers") or [],
            "priority": item.get("priority") or 0,
        })
    return result


def _codex_version(codex_binary: str | None) -> str | None:
    if not codex_binary:
        return None
    try:
        completed = subprocess.run(
            [codex_binary, "--version"],
            check=False,
            capture_output=True,
            text=True,
            timeout=3,
        )
    except Exception:
        return None
    text = (completed.stdout or completed.stderr or "").strip()
    return text or None


@router.get("/agent-catalog/codex-local")
def codex_local_catalog():
    """Return non-secret local Codex CLI config and model metadata."""
    codex_home = _codex_home()
    codex_binary = shutil.which("codex")
    try:
        config_info = _read_codex_config(codex_home)
    except Exception as exc:
        logger.warning("Failed to read Codex config metadata: %s", exc)
        config_info = {"path": str(codex_home / "config.toml"), "exists": False, "error": "unreadable"}

    try:
        models = _read_codex_models(codex_home)
    except Exception as exc:
        logger.warning("Failed to read Codex model cache metadata: %s", exc)
        models = []

    return success_response({
        "installed": bool(codex_binary),
        "binary": codex_binary,
        "version": _codex_version(codex_binary),
        "codex_home": str(codex_home),
        "config": config_info,
        "models": models,
    })
