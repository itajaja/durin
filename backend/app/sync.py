"""Sync engine: pulls accounts + transactions from SimpleFin into SQLite.

An in-process asyncio scheduler re-syncs every connection when its last
successful sync is older than SYNC_INTERVAL_HOURS. Force refresh runs the
same path immediately. A per-process "in progress" set prevents concurrent
syncs of the same connection (the app runs as a single uvicorn worker).
"""

import asyncio
import logging
import re
import threading
import time
from datetime import datetime

from sqlalchemy import func
from sqlalchemy.orm import Session

from . import categorize
from .config import settings
from .db import SessionLocal
from .models import (
    Account,
    BalanceSnapshot,
    Connection,
    SyncLog,
    Transaction,
    now_ts,
)
from .simplefin import SimpleFinError, fetch_accounts

log = logging.getLogger("durin.sync")

_in_progress: set[int] = set()
_in_progress_lock = threading.Lock()

# The server's asyncio loop, captured at startup. Request handlers run in a
# worker threadpool (they're sync defs), so background syncs must be
# scheduled onto this loop thread-safely.
_main_loop: asyncio.AbstractEventLoop | None = None

# Strong references to in-flight background tasks: the event loop itself only
# keeps weak refs, so an unreferenced task can be garbage-collected mid-run.
_bg_tasks: set = set()

SCHEDULER_TICK_SECONDS = 300

# SimpleFin reports errors as human-readable strings (the protocol has no
# error codes). Range-cap messages mean the *old* end of the requested window
# was withheld — recent data is complete, so the incremental cursor may
# advance. Anything else is treated as an institution problem: data may be
# missing, so the cursor holds and pending-row cleanup is skipped.
_BENIGN_ERROR_RE = re.compile(r"date range|capped|limit of \d+ days", re.IGNORECASE)


def set_main_loop(loop: asyncio.AbstractEventLoop) -> None:
    global _main_loop
    _main_loop = loop


def _retain(task) -> None:
    _bg_tasks.add(task)
    task.add_done_callback(_bg_tasks.discard)


def is_syncing(connection_id: int) -> bool:
    with _in_progress_lock:
        return connection_id in _in_progress


def _try_begin(connection_id: int) -> bool:
    with _in_progress_lock:
        if connection_id in _in_progress:
            return False
        _in_progress.add(connection_id)
        return True


def _end(connection_id: int) -> None:
    with _in_progress_lock:
        _in_progress.discard(connection_id)


def _parse_amount(raw) -> tuple[float, str]:
    s = str(raw if raw is not None else "0").strip()
    try:
        return float(s), s
    except ValueError:
        return 0.0, s


def _sync_start_date(db: Session, conn: Connection) -> int:
    horizon = now_ts() - settings.history_days * 86400
    if not conn.last_success_at:
        return horizon
    start = conn.last_success_at - settings.sync_overlap_days * 86400
    # Widen the window to cover the oldest still-pending row, so long-lived
    # pending transactions are seen posting (or vanishing) even when that
    # happens outside the normal overlap window.
    oldest_pending = (
        db.query(func.min(Transaction.posted))
        .join(Account, Transaction.account_id == Account.id)
        .filter(
            Account.connection_id == conn.id,
            Transaction.pending.is_(True),
            Transaction.deleted.is_(False),
        )
        .scalar()
    )
    if oldest_pending:
        start = min(start, int(oldest_pending) - 86400)
    return max(start, horizon)


def _upsert_account(db: Session, conn: Connection, payload: dict) -> tuple[Account, bool]:
    sfid = str(payload.get("id"))
    created = False
    account = (
        db.query(Account)
        .filter(Account.connection_id == conn.id, Account.simplefin_id == sfid)
        .one_or_none()
    )
    if account is None:
        account = Account(user_id=conn.user_id, connection_id=conn.id, simplefin_id=sfid)
        db.add(account)
        created = True
    org = payload.get("org") or {}
    # Every fallback chain ends in a concrete value: assigning None would
    # override the column defaults and violate NOT NULL on insert (the
    # protocol allows orgs identified only by sfin-url).
    account.name = payload.get("name") or account.name or sfid
    account.org_name = org.get("name") or org.get("domain") or account.org_name or ""
    account.org_domain = org.get("domain") or account.org_domain or ""
    account.currency = payload.get("currency") or account.currency or "USD"
    if payload.get("balance") is not None:
        account.balance = str(payload["balance"])
    elif account.balance is None:
        account.balance = "0"
    if payload.get("available-balance") is not None:
        account.available_balance = str(payload["available-balance"])
    if payload.get("balance-date") is not None:
        try:
            account.balance_date = int(payload["balance-date"])
        except (TypeError, ValueError):
            pass
    db.flush()
    _record_balance_snapshot(db, account)
    return account, created


def _record_balance_snapshot(db: Session, account: Account) -> None:
    """Upsert today's balance reading for the Assets page. The day comes
    from the bank's balance-date stamp (falling back to now), so a stale
    stamp lands on the day it was actually accurate for."""
    ts = account.balance_date or now_ts()
    day = datetime.fromtimestamp(ts).date().isoformat()
    row = (
        db.query(BalanceSnapshot)
        .filter(
            BalanceSnapshot.account_id == account.id, BalanceSnapshot.day == day
        )
        .one_or_none()
    )
    if row is None:
        db.add(
            BalanceSnapshot(
                user_id=account.user_id,
                account_id=account.id,
                day=day,
                balance=account.balance,
            )
        )
    elif row.balance != account.balance:
        row.balance = account.balance
        row.recorded_at = now_ts()


def _upsert_transactions(
    db: Session,
    account: Account,
    txns: list[dict],
    window_start: int,
    allow_pending_cleanup: bool,
) -> tuple[int, int]:
    added = updated = 0
    seen_ids: set[str] = set()
    existing = {
        t.simplefin_id: t
        for t in db.query(Transaction).filter(Transaction.account_id == account.id)
    }
    for t in txns:
        raw_id = t.get("id")
        if raw_id is None or str(raw_id) == "":
            continue
        sfid = str(raw_id)
        if sfid in seen_ids:
            continue
        seen_ids.add(sfid)
        try:
            posted = int(t.get("posted") or 0)
        except (TypeError, ValueError):
            posted = 0
        transacted_at = None
        if t.get("transacted_at") is not None:
            try:
                transacted_at = int(t["transacted_at"])
            except (TypeError, ValueError):
                pass
        if posted == 0:
            # Pending transactions may not have a posted date yet; fall back
            # to transacted_at, then to "now" so they sort sensibly.
            posted = transacted_at or now_ts()
        amount, amount_str = _parse_amount(t.get("amount"))
        new_vals = {
            "posted": posted,
            "transacted_at": transacted_at,
            "amount": amount,
            "amount_str": amount_str,
            "description": str(t.get("description") or ""),
            "payee": str(t.get("payee") or ""),
            "memo": str(t.get("memo") or ""),
            "pending": bool(t.get("pending", False)),
        }
        row = existing.get(sfid)
        if row is None:
            db.add(
                Transaction(
                    user_id=account.user_id,
                    account_id=account.id,
                    simplefin_id=sfid,
                    **new_vals,
                )
            )
            added += 1
        elif row.deleted:
            # User deleted this transaction; the bank still reports it, but
            # it must stay gone.
            continue
        else:
            if row.edited:
                # Keep the user's amended text; bank facts still update.
                for k in ("description", "payee", "memo"):
                    new_vals[k] = getattr(row, k)
            changed = any(getattr(row, k) != v for k, v in new_vals.items())
            for k, v in new_vals.items():
                setattr(row, k, v)
            if changed:
                updated += 1

    # Drop stale *pending* rows in the fetched window that the bank no longer
    # reports — they either posted under a new id or were cancelled. Skipped
    # when the response carried serious errors: the data may be incomplete
    # and absence then proves nothing.
    if allow_pending_cleanup:
        stale = (
            db.query(Transaction)
            .filter(
                Transaction.account_id == account.id,
                Transaction.pending.is_(True),
                Transaction.deleted.is_(False),
                Transaction.posted >= window_start,
            )
            .all()
        )
        for row in stale:
            if row.simplefin_id not in seen_ids:
                db.delete(row)
    return added, updated


def _ingest(
    db: Session,
    conn: Connection,
    data: dict,
    window_start: int,
    allow_pending_cleanup: bool,
) -> tuple[int, int, bool]:
    """Upsert one /accounts payload. Returns (added, updated, new_accounts)."""
    added = updated = 0
    new_accounts = False
    for acct_payload in data.get("accounts", []):
        account, created = _upsert_account(db, conn, acct_payload)
        new_accounts = new_accounts or created
        a, u = _upsert_transactions(
            db,
            account,
            acct_payload.get("transactions") or [],
            window_start,
            allow_pending_cleanup,
        )
        added += a
        updated += u
    return added, updated, new_accounts


def _do_sync(connection_id: int) -> None:
    """Blocking sync of one connection. Runs in a worker thread."""
    db = SessionLocal()
    try:
        conn = db.get(Connection, connection_id)
        if conn is None:
            return
        if conn.access_url.startswith("import:"):
            # CSV-imported history has no upstream to sync against. Bump the
            # sync stamp so the scheduler doesn't re-queue it every tick.
            conn.last_sync_at = now_ts()
            db.commit()
            return
        entry = SyncLog(connection_id=conn.id)
        db.add(entry)
        conn.last_sync_at = now_ts()
        db.commit()

        start_date = _sync_start_date(db, conn)
        horizon = now_ts() - settings.history_days * 86400
        try:
            data = fetch_accounts(conn.access_url, start_date=start_date)
        except SimpleFinError as exc:
            conn.last_sync_status = "error"
            conn.last_sync_error = str(exc)
            entry.status = "error"
            entry.message = str(exc)
            entry.finished_at = now_ts()
            db.commit()
            log.warning("sync %s failed: %s", connection_id, exc)
            return

        errors = [str(e) for e in (data.get("errors") or [])]
        serious = [e for e in errors if not _BENIGN_ERROR_RE.search(e)]

        added, updated, new_accounts = _ingest(
            db, conn, data, start_date, allow_pending_cleanup=not serious
        )

        # If the bank added a new account since the last sync, the incremental
        # window would leave it with only a few days of history — do one
        # full-history pass (upserts are idempotent).
        if new_accounts and start_date > horizon:
            try:
                full = fetch_accounts(conn.access_url, start_date=horizon)
                a, u, _more = _ingest(
                    db, conn, full, horizon, allow_pending_cleanup=not serious
                )
                added += a
                updated += u
            except SimpleFinError as exc:
                log.warning("sync %s history backfill failed: %s", connection_id, exc)

        # Give the connection a friendly default name from its orgs.
        if not conn.name:
            orgs = sorted({a.org_name for a in conn.accounts if a.org_name})
            if orgs:
                conn.name = ", ".join(orgs)

        if serious:
            # Institution problem: keep whatever synced, but don't advance the
            # incremental cursor past data we may not have received.
            conn.last_sync_status = "partial"
            conn.last_sync_error = "; ".join(errors)
            entry.status = "partial"
        else:
            conn.last_success_at = now_ts()
            conn.last_sync_status = "ok"
            conn.last_sync_error = "; ".join(errors)
            entry.status = "ok"
        entry.message = "; ".join(errors)
        entry.accounts_synced = len(data.get("accounts", []))
        entry.txns_added = added
        entry.txns_updated = updated
        entry.finished_at = now_ts()
        db.commit()
        # Newly-synced transactions arrive uncategorized; match them against
        # the user's rules right away so they show up categorized in the UI.
        if added or updated:
            try:
                categorize.categorize_uncategorized(db, conn.user_id)
            except Exception:
                log.exception("post-sync categorization failed for %s", connection_id)
        log.info(
            "sync %s %s: %d accounts, +%d/%d txns",
            connection_id,
            entry.status,
            entry.accounts_synced,
            added,
            updated,
        )
    except Exception:
        db.rollback()
        log.exception("sync %s crashed", connection_id)
        try:
            conn = db.get(Connection, connection_id)
            if conn is not None:
                conn.last_sync_status = "error"
                conn.last_sync_error = "Internal error during sync (see server logs)"
            stuck = db.query(SyncLog).filter(
                SyncLog.connection_id == connection_id, SyncLog.status == "running"
            )
            for row in stuck:
                row.status = "error"
                row.message = "Internal error during sync"
                row.finished_at = now_ts()
            db.commit()
        except Exception:
            pass
    finally:
        db.close()


async def sync_connection(connection_id: int) -> bool:
    """Sync one connection unless it is already being synced."""
    if not _try_begin(connection_id):
        return False
    try:
        await asyncio.to_thread(_do_sync, connection_id)
    finally:
        _end(connection_id)
    return True


def sync_connection_in_background(connection_id: int) -> bool:
    """Fire-and-forget sync from a request handler (worker thread)."""
    if _main_loop is None or is_syncing(connection_id):
        return False
    _retain(asyncio.run_coroutine_threadsafe(sync_connection(connection_id), _main_loop))
    return True


async def scheduler_loop() -> None:
    log.info(
        "scheduler started: interval %.1fh, tick %ds",
        settings.sync_interval_hours,
        SCHEDULER_TICK_SECONDS,
    )
    while True:
        try:
            due_ids: list[int] = []
            cutoff = time.time() - settings.sync_interval_hours * 3600
            db = SessionLocal()
            try:
                for conn in db.query(Connection).all():
                    last = conn.last_sync_at or 0
                    if last <= cutoff and not is_syncing(conn.id):
                        due_ids.append(conn.id)
            finally:
                db.close()
            for cid in due_ids:
                _retain(asyncio.get_running_loop().create_task(sync_connection(cid)))
        except Exception:
            log.exception("scheduler tick failed")
        await asyncio.sleep(SCHEDULER_TICK_SECONDS)
