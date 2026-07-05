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
