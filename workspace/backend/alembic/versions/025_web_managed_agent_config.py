# -*- coding: utf-8 -*-
"""Add web-managed agent configuration table.

Revision ID: 025
Revises: 024
Create Date: 2026-06-12
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "025"
down_revision = "024"
branch_labels = None
depends_on = None


def _has_column(inspector, table, column):
    return any(c["name"] == column for c in inspector.get_columns(table))


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not inspector.has_table("agent_configs"):
        op.create_table(
            "agent_configs",
            sa.Column("id", sa.Text(), nullable=False),
            sa.Column("workspace_id", UUID(as_uuid=False), nullable=False),
            sa.Column("handle", sa.Text(), nullable=False),
            sa.Column("display_name", sa.Text(), nullable=False),
            sa.Column("avatar", sa.JSON(), nullable=False),
            sa.Column("agent_type", sa.Text(), nullable=False),
            sa.Column("model_provider", sa.Text(), nullable=True),
            sa.Column("model", sa.Text(), nullable=True),
            sa.Column("mode", sa.Text(), nullable=True),
            sa.Column("quality", sa.Text(), nullable=True),
            sa.Column("credential_ref", sa.Text(), nullable=True),
            sa.Column("working_dir", sa.Text(), nullable=True),
            sa.Column("enabled_skills", sa.JSON(), nullable=True),
            sa.Column("config_metadata", sa.JSON(), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("NOW()"), nullable=True),
            sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("NOW()"), nullable=True),
            sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"], ondelete="CASCADE"),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("workspace_id", "handle", name="uq_agent_config_workspace_handle"),
        )
        op.create_index("idx_agent_configs_workspace", "agent_configs", ["workspace_id"])

    if _has_column(inspector, "cloud_agent_configs", "api_key"):
        op.alter_column("cloud_agent_configs", "api_key", nullable=True)


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if _has_column(inspector, "cloud_agent_configs", "api_key"):
        op.alter_column("cloud_agent_configs", "api_key", nullable=False)

    if inspector.has_table("agent_configs"):
        op.drop_index("idx_agent_configs_workspace", table_name="agent_configs")
        op.drop_table("agent_configs")
