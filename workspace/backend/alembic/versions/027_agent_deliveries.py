# -*- coding: utf-8 -*-
"""Add durable agent deliveries.

Revision ID: 027
Revises: 026
Create Date: 2026-06-13
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID


revision = "027"
down_revision = "026"
branch_labels = None
depends_on = None


def _has_table(inspector, table):
    return table in inspector.get_table_names()


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not _has_table(inspector, "agent_deliveries"):
        op.create_table(
            "agent_deliveries",
            sa.Column("id", sa.Text(), nullable=False),
            sa.Column("workspace_id", UUID(as_uuid=False), nullable=False),
            sa.Column("event_id", sa.Text(), nullable=False),
            sa.Column("agent_name", sa.Text(), nullable=False),
            sa.Column("channel_name", sa.Text(), nullable=True),
            sa.Column("status", sa.Text(), nullable=False, server_default=sa.text("'pending'")),
            sa.Column("attempts", sa.Integer(), nullable=False, server_default=sa.text("0")),
            sa.Column("lease_owner_session_id", sa.Text(), nullable=True),
            sa.Column("lease_until", sa.DateTime(timezone=True), nullable=True),
            sa.Column("last_delivered_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("acked_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("last_error", sa.Text(), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("NOW()"), nullable=True),
            sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("NOW()"), nullable=True),
            sa.ForeignKeyConstraint(["event_id"], ["events.id"], ondelete="CASCADE"),
            sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"], ondelete="CASCADE"),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("event_id", "agent_name", name="uq_agent_delivery_event_agent"),
        )
    op.create_index(
        "idx_agent_deliveries_workspace_agent_status",
        "agent_deliveries",
        ["workspace_id", "agent_name", "status"],
        unique=False,
    )
    op.create_index(
        "idx_agent_deliveries_lease_until",
        "agent_deliveries",
        ["lease_until"],
        unique=False,
    )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not _has_table(inspector, "agent_deliveries"):
        return
    op.drop_index("idx_agent_deliveries_lease_until", table_name="agent_deliveries")
    op.drop_index("idx_agent_deliveries_workspace_agent_status", table_name="agent_deliveries")
    op.drop_table("agent_deliveries")
