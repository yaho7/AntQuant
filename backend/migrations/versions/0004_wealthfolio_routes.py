"""Keep a Wealthfolio route per broker profile and pin each order to its route."""

import sqlalchemy as sa
from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "wealthfolio_route",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("broker_key", sa.String(80), nullable=False),
        sa.Column("selected", sa.Boolean(), nullable=False),
        sa.Column("paused", sa.Boolean(), nullable=False),
    )
    op.create_index("ix_wealthfolio_route_broker_key", "wealthfolio_route", ["broker_key"])
    op.create_table(
        "wealthfolio_order_route",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("destination", sa.String(64), sa.ForeignKey("wealthfolio_route.id"), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("wealthfolio_order_route")
    op.drop_table("wealthfolio_route")
