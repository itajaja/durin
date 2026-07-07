import time

from sqlalchemy import (
    Boolean,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def now_ts() -> int:
    return int(time.time())


class Base(DeclarativeBase):
    pass


class Category(Base):
    """A per-user budget category, managed from the Categories page.

    is_transaction=True marks money movements that aren't real spending
    (transfers, credit-card payments): they are excluded from the Spending
    page's numbers.
    """

    __tablename__ = "categories"
    __table_args__ = (UniqueConstraint("user_id", "name"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String, index=True)
    emoji: Mapped[str] = mapped_column(String, default="")
    color: Mapped[str] = mapped_column(String, default="#8a8984")
    is_transaction: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[int] = mapped_column(Integer, default=now_ts)

    rules: Mapped[list["CategoryRule"]] = relationship(
        back_populates="category", passive_deletes=True, order_by="CategoryRule.id"
    )


class CategoryRule(Base):
    """A matching rule. match_type "substring" matches description/payee/memo
    containing the text (case-insensitive); "payee" matches the payee field
    exactly (case-insensitive). Rules match in creation order across both
    types; first match wins."""

    __tablename__ = "category_rules"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    category_id: Mapped[int] = mapped_column(
        ForeignKey("categories.id", ondelete="CASCADE"), index=True
    )
    substring: Mapped[str] = mapped_column(String)
    match_type: Mapped[str] = mapped_column(String, default="substring")
    created_at: Mapped[int] = mapped_column(Integer, default=now_ts)

    category: Mapped[Category] = relationship(back_populates="rules")


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    email: Mapped[str] = mapped_column(String, unique=True, index=True)
    name: Mapped[str] = mapped_column(String, default="")
    picture: Mapped[str] = mapped_column(String, default="")
    google_sub: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    created_at: Mapped[int] = mapped_column(Integer, default=now_ts)

    connections: Mapped[list["Connection"]] = relationship(back_populates="user")


class Connection(Base):
    """A claimed SimpleFin access URL belonging to one user."""

    __tablename__ = "connections"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String, default="")
    access_url: Mapped[str] = mapped_column(Text)
    created_at: Mapped[int] = mapped_column(Integer, default=now_ts)

    # Sync bookkeeping. last_success_at drives the incremental start-date;
    # last_sync_at is the last attempt of any outcome.
    last_sync_at: Mapped[int | None] = mapped_column(Integer, nullable=True)
    last_success_at: Mapped[int | None] = mapped_column(Integer, nullable=True)
    last_sync_status: Mapped[str] = mapped_column(String, default="never")  # never|ok|error
    last_sync_error: Mapped[str] = mapped_column(Text, default="")

    user: Mapped[User] = relationship(back_populates="connections")
    accounts: Mapped[list["Account"]] = relationship(
        back_populates="connection", passive_deletes=True
    )


class Account(Base):
    __tablename__ = "accounts"
    __table_args__ = (UniqueConstraint("connection_id", "simplefin_id"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    connection_id: Mapped[int] = mapped_column(
        ForeignKey("connections.id", ondelete="CASCADE"), index=True
    )
    simplefin_id: Mapped[str] = mapped_column(String)

    name: Mapped[str] = mapped_column(String, default="")
    # User-chosen display name. When set it replaces `name` everywhere in the
    # app except the Settings page (which must show the bank's own name).
    # Sync never touches it.
    alias: Mapped[str] = mapped_column(String, default="")
    org_name: Mapped[str] = mapped_column(String, default="")
    org_domain: Mapped[str] = mapped_column(String, default="")
    currency: Mapped[str] = mapped_column(String, default="USD")
    balance: Mapped[str] = mapped_column(String, default="0")
    available_balance: Mapped[str | None] = mapped_column(String, nullable=True)
    balance_date: Mapped[int | None] = mapped_column(Integer, nullable=True)

    connection: Mapped[Connection] = relationship(back_populates="accounts")
    transactions: Mapped[list["Transaction"]] = relationship(
        back_populates="account", passive_deletes=True
    )


class BalanceSnapshot(Base):
    """One balance reading per account per (local) day, recorded on every
    sync. SimpleFin only reports the *current* balance — there is no
    historical-balance API — so this history accumulates from the first
    sync after the table exists and cannot be backfilled. A same-day
    re-sync overwrites: each day keeps its latest reading."""

    __tablename__ = "balance_snapshots"
    __table_args__ = (
        UniqueConstraint("account_id", "day"),
        Index("ix_balance_snapshots_user_day", "user_id", "day"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    account_id: Mapped[int] = mapped_column(
        ForeignKey("accounts.id", ondelete="CASCADE"), index=True
    )
    day: Mapped[str] = mapped_column(String)  # YYYY-MM-DD, server-local time
    # Exact decimal string as SimpleFin sent it (same convention as
    # Account.balance); converted to float only for the JSON the chart eats.
    balance: Mapped[str] = mapped_column(String)
    recorded_at: Mapped[int] = mapped_column(Integer, default=now_ts)


class Transaction(Base):
    __tablename__ = "transactions"
    __table_args__ = (
        UniqueConstraint("account_id", "simplefin_id"),
        Index("ix_transactions_user_posted", "user_id", "posted"),
        Index("ix_transactions_user_amount", "user_id", "amount"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    account_id: Mapped[int] = mapped_column(
        ForeignKey("accounts.id", ondelete="CASCADE"), index=True
    )
    simplefin_id: Mapped[str] = mapped_column(String)

    posted: Mapped[int] = mapped_column(Integer, index=True)  # unix seconds
    transacted_at: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # amount: float for sorting/filtering in SQL; amount_str preserves the
    # exact decimal string SimpleFin sent, used for display.
    amount: Mapped[float] = mapped_column(Float)
    amount_str: Mapped[str] = mapped_column(String)
    description: Mapped[str] = mapped_column(Text, default="")
    payee: Mapped[str] = mapped_column(Text, default="")
    memo: Mapped[str] = mapped_column(Text, default="")
    pending: Mapped[bool] = mapped_column(Boolean, default=False)
    # NULL = uncategorized. A transaction belongs to at most one category.
    category_id: Mapped[int | None] = mapped_column(
        ForeignKey("categories.id", ondelete="SET NULL"), nullable=True, index=True
    )
    # Set when the user assigned the category by hand (single or batch):
    # rule-based recategorization never touches manual assignments.
    category_manual: Mapped[bool] = mapped_column(Boolean, default=False)
    # Soft delete: the bank will keep reporting this transaction on every
    # sync, so a hard delete would just resurrect it.
    deleted: Mapped[bool] = mapped_column(Boolean, default=False)
    # Set when the user amended description/payee/memo: sync upserts keep
    # updating bank facts (amount, posted, pending) but leave edited text.
    edited: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[int] = mapped_column(Integer, default=now_ts)

    account: Mapped[Account] = relationship(back_populates="transactions")


class SyncLog(Base):
    __tablename__ = "sync_log"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    connection_id: Mapped[int] = mapped_column(
        ForeignKey("connections.id", ondelete="CASCADE"), index=True
    )
    started_at: Mapped[int] = mapped_column(Integer, default=now_ts)
    finished_at: Mapped[int | None] = mapped_column(Integer, nullable=True)
    status: Mapped[str] = mapped_column(String, default="running")  # running|ok|error
    message: Mapped[str] = mapped_column(Text, default="")
    accounts_synced: Mapped[int] = mapped_column(Integer, default=0)
    txns_added: Mapped[int] = mapped_column(Integer, default=0)
    txns_updated: Mapped[int] = mapped_column(Integer, default=0)
