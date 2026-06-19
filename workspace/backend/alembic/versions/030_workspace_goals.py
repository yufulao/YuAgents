# -*- coding: utf-8 -*-
"""Add durable workspace coordinator goals.

Revision ID: 030
Revises: 029
Create Date: 2026-06-19
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID


revision = "030"
down_revision = "029"
branch_labels = None
depends_on = None


def _has_table(inspector, table):
    return table in inspector.get_table_names()


def _has_index(inspector, table, name):
    return any(idx.get("name") == name for idx in inspector.get_indexes(table))


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not _has_table(inspector, "workspace_goals"):
        op.create_table(
            "workspace_goals",
            sa.Column("id", sa.Text(), nullable=False),
            sa.Column("workspace_id", UUID(as_uuid=False), nullable=False),
            sa.Column("channel_name", sa.Text(), nullable=False),
            sa.Column("coordinator", sa.Text(), nullable=False),
            sa.Column("objective", sa.Text(), nullable=False),
            sa.Column("stop_condition", sa.Text(), nullable=False),
            sa.Column("status", sa.Text(), nullable=False, server_default=sa.text("'active'")),
            sa.Column("checkpoint", sa.Text(), nullable=True),
            sa.Column("progress_log", sa.Text(), nullable=True),
            sa.Column("created_by", sa.Text(), nullable=False),
            sa.Column("cadence_seconds", sa.Integer(), nullable=False, server_default=sa.text("300")),
            sa.Column("run_count", sa.Integer(), nullable=False, server_default=sa.text("0")),
            sa.Column("last_run_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("next_run_at", sa.DateTime(timezone=True), server_default=sa.text("NOW()"), nullable=True),
            sa.Column("lease_owner_session_id", sa.Text(), nullable=True),
            sa.Column("lease_until", sa.DateTime(timezone=True), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("NOW()"), nullable=True),
            sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("NOW()"), nullable=True),
            sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
            sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"], ondelete="CASCADE"),
            sa.PrimaryKeyConstraint("id"),
        )
        inspector = sa.inspect(bind)

    indexes = [
        ("idx_workspace_goals_workspace_status_next", ["workspace_id", "status", "next_run_at"]),
        ("idx_workspace_goals_workspace_coordinator_status", ["workspace_id", "coordinator", "status"]),
        ("idx_workspace_goals_workspace_channel_status", ["workspace_id", "channel_name", "status"]),
    ]
    for name, columns in indexes:
        if not _has_index(inspector, "workspace_goals", name):
            op.create_index(name, "workspace_goals", columns, unique=False)


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not _has_table(inspector, "workspace_goals"):
        return
    for name in [
        "idx_workspace_goals_workspace_channel_status",
        "idx_workspace_goals_workspace_coordinator_status",
        "idx_workspace_goals_workspace_status_next",
    ]:
        if _has_index(inspector, "workspace_goals", name):
            op.drop_index(name, table_name="workspace_goals")
    op.drop_table("workspace_goals")
