"""Persist broker account profiles."""

import sqlalchemy as sa
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "broker_profile",
        sa.Column("id", sa.String(80), primary_key=True),
        sa.Column("provider", sa.String(16), nullable=False),
        sa.Column("name", sa.String(80), nullable=False),
        sa.Column("identity", sa.String(64), unique=True),
        sa.Column("account_hint", sa.String(32)),
        sa.Column("legacy", sa.Boolean(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("broker_profile")
