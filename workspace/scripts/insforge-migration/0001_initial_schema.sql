-- OpenAgents workspace schema, mirrored 1:1 from
-- workspace/backend/app/models.py so the backend can be repointed at this
-- database with no code changes.
--
-- Apply with:
--   npx @insforge/cli db import workspace/scripts/insforge-migration/0001_initial_schema.sql
--
-- Idempotent: every CREATE uses IF NOT EXISTS so repeated runs are safe.
-- Do NOT include BEGIN/COMMIT — InsForge wraps imports in its own transaction.

-- ===========================================================================
-- Workspaces (an ONM network)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS workspaces (
    id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    slug             text        UNIQUE,
    name             text        NOT NULL,
    creator_email    text,
    password_hash    text,
    settings         jsonb       DEFAULT '{}'::jsonb,
    status           text        DEFAULT 'active',
    created_at       timestamptz NOT NULL DEFAULT now(),
    last_activity_at timestamptz NOT NULL DEFAULT now()
);

-- ===========================================================================
-- Workspace members (agent membership in a workspace)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS workspace_members (
    workspace_id        uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    agent_name          text        NOT NULL,
    role                text        DEFAULT 'member',
    agent_type          text,
    server_host         text,
    working_dir         text,
    description         text,
    enabled_skills      jsonb,
    status              text        DEFAULT 'offline',
    last_heartbeat      timestamptz,
    joined_at           timestamptz NOT NULL DEFAULT now(),
    session_id          text,
    session_started_at  timestamptz,
    PRIMARY KEY (workspace_id, agent_name)
);

-- ===========================================================================
-- Channels (named event streams / threads)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS channels (
    id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id        uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name                text        NOT NULL,
    title               text,
    title_manually_set  boolean     NOT NULL DEFAULT false,
    created_by          text,
    master_agent        text,
    resume_from         text,
    visibility          text        NOT NULL DEFAULT 'public',
    mention_policy      text        NOT NULL DEFAULT 'members_only',
    status              text        DEFAULT 'active',
    starred             boolean     NOT NULL DEFAULT false,
    last_event_at       bigint,
    created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_channels_ws_name ON channels (workspace_id, name);
CREATE INDEX IF NOT EXISTS idx_channels_workspace_status ON channels (workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_channels_status_last_event ON channels (status, last_event_at);

-- ===========================================================================
-- Channel members (per-thread participants)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS channel_members (
    channel_id  uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    agent_name  text NOT NULL,
    PRIMARY KEY (channel_id, agent_name)
);

-- ===========================================================================
-- Channel human members (per-thread human participants)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS channel_human_members (
    channel_id  uuid        NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_email  text        NOT NULL,
    joined_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (channel_id, user_email)
);
CREATE INDEX IF NOT EXISTS idx_channel_human_members_email ON channel_human_members (user_email);

-- ===========================================================================
-- Workspace collaborators (email-based human access list)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS workspace_collaborators (
    id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    email        text        NOT NULL,
    role         text        DEFAULT 'editor',
    added_by     text,
    added_at     timestamptz NOT NULL DEFAULT now(),
    display_name text,
    CONSTRAINT uq_collaborator_workspace_email UNIQUE (workspace_id, email)
);
CREATE INDEX IF NOT EXISTS idx_collaborators_workspace ON workspace_collaborators (workspace_id);
CREATE INDEX IF NOT EXISTS idx_collaborators_email     ON workspace_collaborators (email);

-- ===========================================================================
-- Invitations (workspace invites)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS invitations (
    id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    target_agent text        NOT NULL,
    invite_token text        NOT NULL UNIQUE,
    status       text        DEFAULT 'pending',
    created_at   timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL
);

-- ===========================================================================
-- Events (the ONM event log, source of truth)
-- network_id has no FK so events can be inserted without a workspace row
-- (matches source behavior; workspace row is created separately).
-- ===========================================================================
CREATE TABLE IF NOT EXISTS events (
    id          text        PRIMARY KEY,
    network_id  uuid        NOT NULL,
    type        text        NOT NULL,
    source      text        NOT NULL,
    target      text        NOT NULL,
    payload     jsonb,
    metadata    jsonb       DEFAULT '{}'::jsonb,
    timestamp   bigint      NOT NULL,
    visibility  text        DEFAULT 'channel',
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_events_network_type      ON events (network_id, type);
CREATE INDEX IF NOT EXISTS idx_events_network_target    ON events (network_id, target);
CREATE INDEX IF NOT EXISTS idx_events_network_timestamp ON events (network_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_events_network_type_target_ts ON events (network_id, type, target, timestamp);

-- ===========================================================================
-- Agent deliveries (durable per-agent inbox rows)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS agent_deliveries (
    id                      text        PRIMARY KEY,
    workspace_id            uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    event_id                text        NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    agent_name              text        NOT NULL,
    channel_name            text,
    delivery_kind           text        NOT NULL DEFAULT 'attention',
    attention_reason        text,
    status                  text        NOT NULL DEFAULT 'pending',
    attempts                integer     NOT NULL DEFAULT 0,
    lease_owner_session_id  text,
    lease_until             timestamptz,
    last_delivered_at       timestamptz,
    acked_at                timestamptz,
    last_error              text,
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_agent_delivery_event_agent UNIQUE (event_id, agent_name)
);
CREATE INDEX IF NOT EXISTS idx_agent_deliveries_workspace_agent_status ON agent_deliveries (workspace_id, agent_name, status);
CREATE INDEX IF NOT EXISTS idx_agent_deliveries_lease_until ON agent_deliveries (lease_until);

-- ===========================================================================
-- Files (metadata; blobs in S3 keyed by storage_key)
-- storage_key shape: '{workspace_id}/{file_id}/{filename}'
-- ===========================================================================
CREATE TABLE IF NOT EXISTS files (
    id            text        PRIMARY KEY,
    workspace_id  uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    filename      text        NOT NULL,
    content_type  text        NOT NULL DEFAULT 'application/octet-stream',
    size          integer     NOT NULL,
    storage_key   text        NOT NULL,
    uploaded_by   text        NOT NULL,
    channel_name  text,
    status        text        NOT NULL DEFAULT 'active',
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_files_workspace_status ON files (workspace_id, status);

-- ===========================================================================
-- Agent configs (web-managed local agent configuration)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS agent_configs (
    id               text        PRIMARY KEY,
    workspace_id     uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    handle           text        NOT NULL,
    display_name     text        NOT NULL,
    avatar           jsonb       NOT NULL DEFAULT '{}'::jsonb,
    agent_type       text        NOT NULL,
    model_provider   text,
    model            text,
    mode             text,
    quality          text,
    credential_ref   text,
    working_dir      text,
    enabled_skills   jsonb,
    config_metadata  jsonb,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_agent_config_workspace_handle UNIQUE (workspace_id, handle)
);
CREATE INDEX IF NOT EXISTS idx_agent_configs_workspace ON agent_configs (workspace_id);

-- ===========================================================================
-- Knowledge entries (workspace-global markdown documents)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS knowledge_entries (
    id            text        PRIMARY KEY,
    workspace_id  uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    slug          text        NOT NULL,
    title         text        NOT NULL,
    description   text,
    storage_key   text,
    content_size  integer,
    created_by    text        NOT NULL,
    updated_by    text,
    status        text        NOT NULL DEFAULT 'active',
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_knowledge_workspace_slug UNIQUE (workspace_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_knowledge_workspace_status ON knowledge_entries (workspace_id, status);

-- ===========================================================================
-- Browser contexts (persistent BrowserBase contexts)
-- Defined BEFORE browser_tabs since browser_tabs.context_id references it.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS browser_contexts (
    id            text        PRIMARY KEY,
    workspace_id  uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name          text        NOT NULL,
    bb_context_id text,
    domain        text,
    status        text        NOT NULL DEFAULT 'active',
    created_by    text        NOT NULL,
    shared_with   jsonb       DEFAULT '[]'::jsonb,
    created_at    timestamptz NOT NULL DEFAULT now(),
    last_used_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_browser_context_workspace_name UNIQUE (workspace_id, name)
);
CREATE INDEX IF NOT EXISTS idx_browser_contexts_workspace_status ON browser_contexts (workspace_id, status);

-- ===========================================================================
-- Browser tabs (shared tabs)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS browser_tabs (
    id              text        PRIMARY KEY,
    workspace_id    uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    url             text        NOT NULL DEFAULT 'about:blank',
    title           text,
    status          text        NOT NULL DEFAULT 'active',
    created_by      text        NOT NULL,
    shared_with     jsonb       DEFAULT '[]'::jsonb,
    context_id      text        REFERENCES browser_contexts(id) ON DELETE SET NULL,
    session_id      text,
    live_url        text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    last_active_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_browser_tabs_workspace_status ON browser_tabs (workspace_id, status);

-- ===========================================================================
-- Browser usage (session duration tracking)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS browser_usage (
    id                text        PRIMARY KEY,
    workspace_id      uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    tab_id            text        NOT NULL,
    session_id        text,
    opened_by         text        NOT NULL,
    started_at        timestamptz NOT NULL DEFAULT now(),
    ended_at          timestamptz,
    duration_seconds  integer
);
CREATE INDEX IF NOT EXISTS idx_browser_usage_workspace ON browser_usage (workspace_id);
CREATE INDEX IF NOT EXISTS idx_browser_usage_opened_by ON browser_usage (opened_by);
CREATE INDEX IF NOT EXISTS idx_browser_usage_started   ON browser_usage (started_at);

-- ===========================================================================
-- Push notification device tokens
-- ===========================================================================
CREATE TABLE IF NOT EXISTS device_tokens (
    id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id  uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    fcm_token     text        NOT NULL,
    device_type   text        NOT NULL,
    bundle_id     text,
    user_email    text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    last_seen_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_device_token_workspace_fcm UNIQUE (workspace_id, fcm_token)
);
CREATE INDEX IF NOT EXISTS idx_device_tokens_workspace ON device_tokens (workspace_id);
CREATE INDEX IF NOT EXISTS idx_device_tokens_workspace_user ON device_tokens (workspace_id, user_email);

-- ===========================================================================
-- To-dos (agent planning state)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS todos (
    id            text        PRIMARY KEY,
    workspace_id  uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    channel_name  text        NOT NULL,
    thread_id     text,
    created_by    text        NOT NULL,
    assignee      text        NOT NULL,
    content       text        NOT NULL,
    status        text        NOT NULL DEFAULT 'pending',
    position      integer     NOT NULL DEFAULT 0,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_todos_workspace_channel    ON todos (workspace_id, channel_name);
CREATE INDEX IF NOT EXISTS idx_todos_workspace_created_by ON todos (workspace_id, created_by);

-- ===========================================================================
-- Workspace tasks (shared multi-agent task graph)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS workspace_tasks (
    id              text        PRIMARY KEY,
    workspace_id    uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    channel_name    text,
    parent_task_id  text        REFERENCES workspace_tasks(id) ON DELETE SET NULL,
    title           text        NOT NULL,
    description     text,
    status          text        NOT NULL DEFAULT 'todo',
    priority        text        NOT NULL DEFAULT 'normal',
    assignee        text,
    claimed_by      text,
    created_by      text        NOT NULL,
    result          text,
    depends_on      jsonb       DEFAULT '[]'::jsonb,
    accepted_by     text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    claimed_at      timestamptz,
    completed_at    timestamptz
);
CREATE INDEX IF NOT EXISTS idx_workspace_tasks_workspace_channel_status  ON workspace_tasks (workspace_id, channel_name, status);
CREATE INDEX IF NOT EXISTS idx_workspace_tasks_workspace_assignee_status ON workspace_tasks (workspace_id, assignee, status);
CREATE INDEX IF NOT EXISTS idx_workspace_tasks_workspace_status          ON workspace_tasks (workspace_id, status);

-- ===========================================================================
-- Timers (scheduled prompt messages)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS timers (
    id             text        PRIMARY KEY,
    workspace_id   uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    channel_name   text        NOT NULL,
    thread_id      text,
    created_by     text        NOT NULL,
    creator_type   text        NOT NULL DEFAULT 'agent',
    target_agent   text,
    message        text        NOT NULL,
    delay_seconds  integer     NOT NULL,
    repeat_interval_seconds integer,
    fire_count     integer     NOT NULL DEFAULT 0,
    fires_at       timestamptz NOT NULL,
    status         text        NOT NULL DEFAULT 'active',
    created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_timers_fires_at_status   ON timers (fires_at, status);
CREATE INDEX IF NOT EXISTS idx_timers_workspace_channel ON timers (workspace_id, channel_name);

-- ===========================================================================
-- Routines (recurring scheduled tasks)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS routines (
    id                         text        PRIMARY KEY,
    workspace_id               uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    channel_name               text        NOT NULL,
    thread_id                  text,
    created_by                 text        NOT NULL,
    name                       text        NOT NULL,
    message                    text        NOT NULL,
    context                    text,
    schedule_hour              integer,
    schedule_minute            integer,
    schedule_days              jsonb,
    schedule_interval_minutes  integer,
    timezone                   text        DEFAULT 'UTC',
    next_fires_at              timestamptz NOT NULL,
    last_fired_at              timestamptz,
    status                     text        NOT NULL DEFAULT 'active',
    created_at                 timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_routines_workspace_channel ON routines (workspace_id, channel_name);
CREATE INDEX IF NOT EXISTS idx_routines_next_fires_status ON routines (next_fires_at, status);

-- ===========================================================================
-- Notifications (workspace inbox)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS notifications (
    id            text        PRIMARY KEY,
    workspace_id  uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    created_by    text        NOT NULL,
    title         text        NOT NULL,
    message       text        NOT NULL,
    priority      text        NOT NULL DEFAULT 'normal',
    is_read       boolean     NOT NULL DEFAULT false,
    channel_name  text,
    thread_id     text,
    link_url      text,
    status        text        NOT NULL DEFAULT 'active',
    created_at    timestamptz NOT NULL DEFAULT now(),
    read_at       timestamptz
);
CREATE INDEX IF NOT EXISTS idx_notifications_workspace_status ON notifications (workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_notifications_workspace_read ON notifications (workspace_id, is_read);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications (created_at);

-- ===========================================================================
-- Cloud agent configs
-- ===========================================================================
CREATE TABLE IF NOT EXISTS cloud_agent_configs (
    id             text        PRIMARY KEY,
    workspace_id   uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    agent_name     text        NOT NULL,
    provider       text        NOT NULL,
    model          text        NOT NULL,
    category       text        NOT NULL DEFAULT 'chat',
    api_key        text,
    base_url       text,
    system_prompt  text,
    max_tokens     integer,
    status         text        NOT NULL DEFAULT 'active',
    created_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_cloud_agent_workspace_name UNIQUE (workspace_id, agent_name)
);
CREATE INDEX IF NOT EXISTS idx_cloud_agent_workspace ON cloud_agent_configs (workspace_id);

-- ===========================================================================
-- Share snapshots
-- ===========================================================================
CREATE TABLE IF NOT EXISTS share_snapshots (
    id              text        PRIMARY KEY,
    workspace_id    uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    channel_name    text        NOT NULL,
    title           text,
    created_by      text        NOT NULL,
    snapshot_data   jsonb       NOT NULL,
    share_token     text        NOT NULL UNIQUE,
    message_count   integer     NOT NULL DEFAULT 0,
    status          text        NOT NULL DEFAULT 'active',
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_share_snapshots_workspace ON share_snapshots (workspace_id);
CREATE INDEX IF NOT EXISTS idx_share_snapshots_token ON share_snapshots (share_token);

-- ===========================================================================
-- Standalone agents (only used in IDENTITY_MODE=standalone, kept for compat)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS agents (
    agent_name   text        PRIMARY KEY,
    display_name text,
    agent_type   text,
    created_at   timestamptz NOT NULL DEFAULT now()
);

-- ===========================================================================
-- Alembic stamp — schema is at head; backend's `alembic upgrade head` no-ops.
-- Update '029' to match the latest revision in
-- workspace/backend/alembic/versions/ when the source schema changes.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS alembic_version (
    version_num varchar(32) NOT NULL,
    CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num)
);
INSERT INTO alembic_version (version_num)
SELECT '029' WHERE NOT EXISTS (SELECT 1 FROM alembic_version);
