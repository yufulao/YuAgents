# -*- coding: utf-8 -*-
"""Add scope-aware workspace task scheduling fields.

Revision ID: 031
Revises: 030
Create Date: 2026-06-30
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB


revision = "031"
down_revision = "030"
branch_labels = None
depends_on = None


def _has_column(inspector, table: str, column: str) -> bool:
    return any(col["name"] == column for col in inspector.get_columns(table))


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "workspace_tasks" not in inspector.get_table_names():
        return

    if not _has_column(inspector, "workspace_tasks", "lane_type"):
        op.add_column(
            "workspace_tasks",
            sa.Column("lane_type", sa.Text(), nullable=False, server_default=sa.text("'unspecified'")),
        )
    if not _has_column(inspector, "workspace_tasks", "write_scope"):
        op.add_column(
            "workspace_tasks",
            sa.Column("write_scope", JSONB(), nullable=True, server_default=sa.text("'[]'::jsonb")),
        )
    if not _has_column(inspector, "workspace_tasks", "resource_locks"):
        op.add_column(
            "workspace_tasks",
            sa.Column("resource_locks", JSONB(), nullable=True, server_default=sa.text("'[]'::jsonb")),
        )
    if not _has_column(inspector, "workspace_tasks", "conflicts_with"):
        op.add_column(
            "workspace_tasks",
            sa.Column("conflicts_with", JSONB(), nullable=True, server_default=sa.text("'[]'::jsonb")),
        )
    if not _has_column(inspector, "workspace_tasks", "commit_policy"):
        op.add_column(
            "workspace_tasks",
            sa.Column("commit_policy", JSONB(), nullable=True, server_default=sa.text("'{}'::jsonb")),
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "workspace_tasks" not in inspector.get_table_names():
        return
    for column in ("commit_policy", "conflicts_with", "resource_locks", "write_scope", "lane_type"):
        if _has_column(inspector, "workspace_tasks", column):
            op.drop_column("workspace_tasks", column)
