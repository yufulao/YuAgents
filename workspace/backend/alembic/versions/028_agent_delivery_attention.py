# -*- coding: utf-8 -*-
"""Split ambient and attention agent deliveries.

Revision ID: 028
Revises: 027
Create Date: 2026-06-13
"""

import sqlalchemy as sa
from alembic import op


revision = "028"
down_revision = "027"
branch_labels = None
depends_on = None


def _has_column(inspector, table, column):
    return any(c["name"] == column for c in inspector.get_columns(table))


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not _has_column(inspector, "agent_deliveries", "delivery_kind"):
        op.add_column(
            "agent_deliveries",
            sa.Column("delivery_kind", sa.Text(), nullable=False, server_default=sa.text("'attention'")),
        )
    if not _has_column(inspector, "agent_deliveries", "attention_reason"):
        op.add_column(
            "agent_deliveries",
            sa.Column("attention_reason", sa.Text(), nullable=True),
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if _has_column(inspector, "agent_deliveries", "attention_reason"):
        op.drop_column("agent_deliveries", "attention_reason")
    if _has_column(inspector, "agent_deliveries", "delivery_kind"):
        op.drop_column("agent_deliveries", "delivery_kind")
