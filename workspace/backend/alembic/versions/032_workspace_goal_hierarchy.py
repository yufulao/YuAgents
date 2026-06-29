# -*- coding: utf-8 -*-
"""Add hierarchical workspace plan fields.

Revision ID: 032
Revises: 031
Create Date: 2026-06-30
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB


revision = "032"
down_revision = "031"
branch_labels = None
depends_on = None


def _has_column(inspector, table: str, column: str) -> bool:
    return any(col["name"] == column for col in inspector.get_columns(table))


def _has_index(inspector, table: str, name: str) -> bool:
    return any(idx["name"] == name for idx in inspector.get_indexes(table))


def _has_fk(inspector, table: str, name: str) -> bool:
    return any(fk.get("name") == name for fk in inspector.get_foreign_keys(table))


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "workspace_goals" not in inspector.get_table_names():
        return
    dialect = bind.dialect.name

    if not _has_column(inspector, "workspace_goals", "parent_goal_id"):
        op.add_column("workspace_goals", sa.Column("parent_goal_id", sa.Text(), nullable=True))
    if not _has_column(inspector, "workspace_goals", "root_goal_id"):
        op.add_column("workspace_goals", sa.Column("root_goal_id", sa.Text(), nullable=True))
    if not _has_column(inspector, "workspace_goals", "plan_level"):
        op.add_column(
            "workspace_goals",
            sa.Column("plan_level", sa.Text(), nullable=False, server_default=sa.text("'root_plan'")),
        )
    if not _has_column(inspector, "workspace_goals", "continuation_policy"):
        op.add_column(
            "workspace_goals",
            sa.Column("continuation_policy", sa.Text(), nullable=False, server_default=sa.text("'long_horizon'")),
        )
    if not _has_column(inspector, "workspace_goals", "plan_refs"):
        op.add_column(
            "workspace_goals",
            sa.Column("plan_refs", JSONB(), nullable=True, server_default=sa.text("'[]'::jsonb")),
        )

    if not _has_index(inspector, "workspace_goals", "idx_workspace_goals_parent_status"):
        op.create_index("idx_workspace_goals_parent_status", "workspace_goals", ["parent_goal_id", "status"], unique=False)
    if not _has_index(inspector, "workspace_goals", "idx_workspace_goals_root_status"):
        op.create_index("idx_workspace_goals_root_status", "workspace_goals", ["root_goal_id", "status"], unique=False)
    if dialect != "sqlite" and not _has_fk(inspector, "workspace_goals", "fk_workspace_goals_parent_goal_id"):
        op.create_foreign_key(
            "fk_workspace_goals_parent_goal_id",
            "workspace_goals",
            "workspace_goals",
            ["parent_goal_id"],
            ["id"],
            ondelete="SET NULL",
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "workspace_goals" not in inspector.get_table_names():
        return
    if bind.dialect.name != "sqlite":
        for fk in inspector.get_foreign_keys("workspace_goals"):
            if fk.get("name") == "fk_workspace_goals_parent_goal_id":
                op.drop_constraint("fk_workspace_goals_parent_goal_id", "workspace_goals", type_="foreignkey")
                break
    for name in ("idx_workspace_goals_root_status", "idx_workspace_goals_parent_status"):
        if _has_index(inspector, "workspace_goals", name):
            op.drop_index(name, table_name="workspace_goals")
    for column in ("plan_refs", "continuation_policy", "plan_level", "root_goal_id", "parent_goal_id"):
        if _has_column(inspector, "workspace_goals", column):
            op.drop_column("workspace_goals", column)
