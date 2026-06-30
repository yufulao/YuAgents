"""Extend timers for user-owned prompt loops.

Revision ID: 030_user_prompt_timers
Revises: 029_workspace_tasks
Create Date: 2026-06-30
"""

from alembic import op
import sqlalchemy as sa


revision = "030_user_prompt_timers"
down_revision = "029_workspace_tasks"
branch_labels = None
depends_on = None


def _has_column(inspector, table: str, column: str) -> bool:
    return any(col["name"] == column for col in inspector.get_columns(table))


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not inspector.has_table("timers"):
        return

    additions = [
        ("creator_type", sa.Column("creator_type", sa.Text(), nullable=False, server_default="agent")),
        ("target_agent", sa.Column("target_agent", sa.Text(), nullable=True)),
        ("repeat_interval_seconds", sa.Column("repeat_interval_seconds", sa.Integer(), nullable=True)),
        ("fire_count", sa.Column("fire_count", sa.Integer(), nullable=False, server_default="0")),
    ]
    for name, column in additions:
        if not _has_column(inspector, "timers", name):
            op.add_column("timers", column)


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not inspector.has_table("timers"):
        return
    for name in ["fire_count", "repeat_interval_seconds", "target_agent", "creator_type"]:
        if _has_column(inspector, "timers", name):
            op.drop_column("timers", name)
