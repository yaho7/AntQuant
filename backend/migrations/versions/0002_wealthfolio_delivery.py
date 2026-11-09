"""Durable delivery queue for Wealthfolio."""

import sqlalchemy as sa
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "wealthfolio_delivery",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("destination", sa.String(64), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("next_attempt", sa.Float(), nullable=False),
        sa.Column("sent_at", sa.Float(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
    )
    op.create_index("ix_wealthfolio_delivery_destination", "wealthfolio_delivery", ["destination"])


def downgrade() -> None:
    op.drop_table("wealthfolio_delivery")
