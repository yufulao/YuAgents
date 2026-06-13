# -*- coding: utf-8 -*-
"""Add shared workspace tasks.

Revision ID: 029
Revises: 028
Create Date: 2026-06-13
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID


revision = "029"
down_revision = "028"
branch_labels = None
depends_on = None


def _has_table(inspector, table):
    return table in inspector.get_table_names()


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not _has_table(inspector, "workspace_tasks"):
        op.create_table(
            "workspace_tasks",
            sa.Column("id", sa.Text(), nullable=False),
            sa.Column("workspace_id", UUID(as_uuid=False), nullable=False),
            sa.Column("channel_name", sa.Text(), nullable=True),
            sa.Column("parent_task_id", sa.Text(), nullable=True),
            sa.Column("title", sa.Text(), nullable=False),
            sa.Column("description", sa.Text(), nullable=True),
            sa.Column("status", sa.Text(), nullable=False, server_default=sa.text("'todo'")),
            sa.Column("priority", sa.Text(), nullable=False, server_default=sa.text("'normal'")),
            sa.Column("assignee", sa.Text(), nullable=True),
            sa.Column("claimed_by", sa.Text(), nullable=True),
            sa.Column("created_by", sa.Text(), nullable=False),
            sa.Column("result", sa.Text(), nullable=True),
            sa.Column("depends_on", JSONB(), nullable=True, server_default=sa.text("'[]'::jsonb")),
            sa.Column("accepted_by", sa.Text(), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("NOW()"), nullable=True),
            sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("NOW()"), nullable=True),
            sa.Column("claimed_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
            sa.ForeignKeyConstraint(["parent_task_id"], ["workspace_tasks.id"], ondelete="SET NULL"),
            sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"], ondelete="CASCADE"),
            sa.PrimaryKeyConstraint("id"),
        )
    op.create_index(
        "idx_workspace_tasks_workspace_channel_status",
        "workspace_tasks",
        ["workspace_id", "channel_name", "status"],
        unique=False,
    )
    op.create_index(
        "idx_workspace_tasks_workspace_assignee_status",
        "workspace_tasks",
        ["workspace_id", "assignee", "status"],
        unique=False,
    )
    op.create_index(
        "idx_workspace_tasks_workspace_status",
        "workspace_tasks",
        ["workspace_id", "status"],
        unique=False,
    )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not _has_table(inspector, "workspace_tasks"):
        return
    op.drop_index("idx_workspace_tasks_workspace_status", table_name="workspace_tasks")
    op.drop_index("idx_workspace_tasks_workspace_assignee_status", table_name="workspace_tasks")
    op.drop_index("idx_workspace_tasks_workspace_channel_status", table_name="workspace_tasks")
    op.drop_table("workspace_tasks")
