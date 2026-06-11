# -*- coding: utf-8 -*-
"""Add channel visibility and mention policy.

Revision ID: 026
Revises: 025
Create Date: 2026-06-12
"""

import sqlalchemy as sa
from alembic import op


revision = "026"
down_revision = "025"
branch_labels = None
depends_on = None


def _has_column(inspector, table, column):
    return any(c["name"] == column for c in inspector.get_columns(table))


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not _has_column(inspector, "channels", "visibility"):
        op.add_column(
            "channels",
            sa.Column(
                "visibility",
                sa.Text(),
                nullable=False,
                server_default=sa.text("'public'"),
            ),
        )

    if not _has_column(inspector, "channels", "mention_policy"):
        op.add_column(
            "channels",
            sa.Column(
                "mention_policy",
                sa.Text(),
                nullable=False,
                server_default=sa.text("'members_only'"),
            ),
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if _has_column(inspector, "channels", "mention_policy"):
        op.drop_column("channels", "mention_policy")
    if _has_column(inspector, "channels", "visibility"):
        op.drop_column("channels", "visibility")
