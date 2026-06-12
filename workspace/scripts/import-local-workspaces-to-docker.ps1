param(
  [string]$SqlitePath = "",
  [string]$ProjectName = "workspace",
  [switch]$IncludeDeleted
)

$ErrorActionPreference = "Stop"

$WorkspaceRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$ComposeFile = Join-Path $WorkspaceRoot "docker-compose.prod.yml"
if ([string]::IsNullOrWhiteSpace($SqlitePath)) {
  $SqlitePath = Join-Path $WorkspaceRoot "backend\workspace_dev.db"
}

if (!(Test-Path $SqlitePath)) {
  throw "SQLite workspace database was not found: $SqlitePath"
}

& cmd /d /c "docker compose version >nul 2>nul"
if ($LASTEXITCODE -ne 0) {
  throw "Docker Compose was not found. Start Docker Desktop and make sure docker compose works."
}

$tempSql = Join-Path ([System.IO.Path]::GetTempPath()) ("openagents-workspace-import-" + [guid]::NewGuid().ToString("N") + ".sql")
$env:OPENAGENTS_IMPORT_SQLITE = (Resolve-Path $SqlitePath)
$env:OPENAGENTS_IMPORT_SQL = $tempSql
$env:OPENAGENTS_IMPORT_INCLUDE_DELETED = if ($IncludeDeleted) { "1" } else { "0" }

$python = @'
import json
import os
import sqlite3

sqlite_path = os.environ["OPENAGENTS_IMPORT_SQLITE"]
sql_path = os.environ["OPENAGENTS_IMPORT_SQL"]
include_deleted = os.environ.get("OPENAGENTS_IMPORT_INCLUDE_DELETED") == "1"

def q(value):
    if value is None:
        return "NULL"
    return "'" + str(value).replace("'", "''") + "'"

def uuid(value):
    return q(value) + "::uuid"

def ts(value):
    return q(value) + "::timestamptz" if value is not None else "NULL"

def js(value, default="{}"):
    if value is None or value == "":
        value = default
    return q(value) + "::jsonb"

def nullable_json(value):
    if value is None or value == "" or value == "null":
        return "NULL"
    return q(value) + "::jsonb"

default_avatar = '{"type":"pixel","value":""}'

def b(value):
    return "TRUE" if bool(value) else "FALSE"

def table_exists(db, name):
    row = db.execute("select 1 from sqlite_master where type='table' and name=?", (name,)).fetchone()
    return row is not None

def rows_for(db, table, workspace_ids):
    if not table_exists(db, table) or not workspace_ids:
        return []
    placeholders = ",".join("?" for _ in workspace_ids)
    return db.execute(f"select * from {table} where workspace_id in ({placeholders})", workspace_ids).fetchall()

db = sqlite3.connect(sqlite_path)
db.row_factory = sqlite3.Row

where = "" if include_deleted else "where status != 'deleted'"
workspaces = db.execute(f"select * from workspaces {where} order by last_activity_at desc").fetchall()
workspace_ids = [row["id"] for row in workspaces]
channels = rows_for(db, "channels", workspace_ids)
channel_ids = [row["id"] for row in channels]

workspace_members = rows_for(db, "workspace_members", workspace_ids)
agent_configs = rows_for(db, "agent_configs", workspace_ids)

if table_exists(db, "channel_members") and channel_ids:
    placeholders = ",".join("?" for _ in channel_ids)
    channel_members = db.execute(f"select * from channel_members where channel_id in ({placeholders})", channel_ids).fetchall()
else:
    channel_members = []

if table_exists(db, "channel_human_members") and channel_ids:
    placeholders = ",".join("?" for _ in channel_ids)
    channel_human_members = db.execute(f"select * from channel_human_members where channel_id in ({placeholders})", channel_ids).fetchall()
else:
    channel_human_members = []

with open(sql_path, "w", encoding="utf-8") as out:
    out.write("BEGIN;\n")
    for row in workspaces:
        out.write(
            "INSERT INTO workspaces (id, slug, name, creator_email, password_hash, settings, status, created_at, last_activity_at) VALUES "
            f"({uuid(row['id'])}, {q(row['slug'])}, {q(row['name'])}, {q(row['creator_email'])}, {q(row['password_hash'])}, {js(row['settings'])}, {q(row['status'])}, {ts(row['created_at'])}, {ts(row['last_activity_at'])}) "
            "ON CONFLICT (id) DO UPDATE SET slug=EXCLUDED.slug, name=EXCLUDED.name, creator_email=EXCLUDED.creator_email, "
            "password_hash=EXCLUDED.password_hash, settings=EXCLUDED.settings, status=EXCLUDED.status, "
            "last_activity_at=EXCLUDED.last_activity_at;\n"
        )

    for row in channels:
        out.write(
            "INSERT INTO channels (id, workspace_id, name, title, title_manually_set, created_by, master_agent, resume_from, visibility, mention_policy, status, starred, last_event_at, created_at) VALUES "
            f"({uuid(row['id'])}, {uuid(row['workspace_id'])}, {q(row['name'])}, {q(row['title'])}, {b(row['title_manually_set'])}, {q(row['created_by'])}, {q(row['master_agent'])}, {q(row['resume_from'])}, {q(row['visibility'])}, {q(row['mention_policy'])}, {q(row['status'])}, {b(row['starred'])}, {row['last_event_at'] if row['last_event_at'] is not None else 'NULL'}, {ts(row['created_at'])}) "
            "ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, title_manually_set=EXCLUDED.title_manually_set, created_by=EXCLUDED.created_by, "
            "master_agent=EXCLUDED.master_agent, resume_from=EXCLUDED.resume_from, visibility=EXCLUDED.visibility, mention_policy=EXCLUDED.mention_policy, "
            "status=EXCLUDED.status, starred=EXCLUDED.starred, last_event_at=EXCLUDED.last_event_at;\n"
        )

    for row in workspace_members:
        out.write(
            "INSERT INTO workspace_members (workspace_id, agent_name, role, agent_type, server_host, working_dir, description, enabled_skills, status, last_heartbeat, joined_at, session_id, session_started_at) VALUES "
            f"({uuid(row['workspace_id'])}, {q(row['agent_name'])}, {q(row['role'])}, {q(row['agent_type'])}, {q(row['server_host'])}, {q(row['working_dir'])}, {q(row['description'])}, {nullable_json(row['enabled_skills'])}, 'offline', NULL, {ts(row['joined_at'])}, NULL, NULL) "
            "ON CONFLICT (workspace_id, agent_name) DO UPDATE SET role=EXCLUDED.role, agent_type=EXCLUDED.agent_type, server_host=EXCLUDED.server_host, "
            "working_dir=EXCLUDED.working_dir, description=EXCLUDED.description, enabled_skills=EXCLUDED.enabled_skills, status='offline', "
            "last_heartbeat=NULL, session_id=NULL, session_started_at=NULL;\n"
        )

    for row in agent_configs:
        out.write(
            "INSERT INTO agent_configs (id, workspace_id, handle, display_name, avatar, agent_type, model_provider, model, mode, quality, credential_ref, working_dir, enabled_skills, config_metadata, created_at, updated_at) VALUES "
            f"({q(row['id'])}, {uuid(row['workspace_id'])}, {q(row['handle'])}, {q(row['display_name'])}, {js(row['avatar'], default_avatar)}, {q(row['agent_type'])}, {q(row['model_provider'])}, {q(row['model'])}, {q(row['mode'])}, {q(row['quality'])}, {q(row['credential_ref'])}, {q(row['working_dir'])}, {nullable_json(row['enabled_skills'])}, {nullable_json(row['config_metadata'])}, {ts(row['created_at'])}, {ts(row['updated_at'])}) "
            "ON CONFLICT (id) DO UPDATE SET handle=EXCLUDED.handle, display_name=EXCLUDED.display_name, avatar=EXCLUDED.avatar, "
            "agent_type=EXCLUDED.agent_type, model_provider=EXCLUDED.model_provider, model=EXCLUDED.model, mode=EXCLUDED.mode, quality=EXCLUDED.quality, "
            "credential_ref=EXCLUDED.credential_ref, working_dir=EXCLUDED.working_dir, enabled_skills=EXCLUDED.enabled_skills, config_metadata=EXCLUDED.config_metadata, updated_at=EXCLUDED.updated_at;\n"
        )

    for row in channel_members:
        out.write(
            "INSERT INTO channel_members (channel_id, agent_name) VALUES "
            f"({uuid(row['channel_id'])}, {q(row['agent_name'])}) ON CONFLICT (channel_id, agent_name) DO NOTHING;\n"
        )

    for row in channel_human_members:
        out.write(
            "INSERT INTO channel_human_members (channel_id, user_email, joined_at) VALUES "
            f"({uuid(row['channel_id'])}, {q(row['user_email'])}, {ts(row['joined_at'])}) ON CONFLICT (channel_id, user_email) DO NOTHING;\n"
        )

    out.write("COMMIT;\n")

print(json.dumps({
    "workspaces": len(workspaces),
    "channels": len(channels),
    "workspaceMembers": len(workspace_members),
    "agentConfigs": len(agent_configs),
    "channelMembers": len(channel_members),
    "channelHumanMembers": len(channel_human_members),
}, ensure_ascii=False))
'@

try {
  $summary = $python | python -
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to generate workspace import SQL"
  }

  $command = 'docker compose -p "' + $ProjectName + '" -f "' + $ComposeFile + '" exec -T db psql -v ON_ERROR_STOP=1 -U postgres -d openagents_workspace < "' + $tempSql + '"'
  & cmd /d /c $command
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to import local workspaces into Docker Postgres"
  }

  Write-Host "Imported existing local workspaces into Docker Postgres."
  Write-Host $summary
  Write-Host "No new workspace or token was generated."
} finally {
  Remove-Item -LiteralPath $tempSql -Force -ErrorAction SilentlyContinue
}
