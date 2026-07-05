from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from . import sync
from .db import get_db
from .auth import get_current_user
from .models import Account, Connection, Transaction, User, now_ts
from .simplefin import SimpleFinError, claim_setup_token, fetch_accounts

router = APIRouter(prefix="/api", tags=["api"])


def _connection_json(conn: Connection, account_count: int) -> dict:
    return {
        "id": conn.id,
        "name": conn.name or "SimpleFin connection",
        "created_at": conn.created_at,
        "last_sync_at": conn.last_sync_at,
        "last_success_at": conn.last_success_at,
        "last_sync_status": conn.last_sync_status,
        "last_sync_error": conn.last_sync_error,
        "syncing": sync.is_syncing(conn.id),
        "account_count": account_count,
    }


def _get_own_connection(db: Session, user: User, connection_id: int) -> Connection:
    conn = db.get(Connection, connection_id)
    if conn is None or conn.user_id != user.id:
        raise HTTPException(status_code=404, detail="Connection not found")
    return conn


@router.get("/connections")
def list_connections(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    conns = (
        db.query(Connection)
        .filter(Connection.user_id == user.id)
        .order_by(Connection.created_at)
        .all()
    )
    counts = dict(
        db.query(Account.connection_id, func.count(Account.id))
        .filter(Account.user_id == user.id)
        .group_by(Account.connection_id)
        .all()
    )
    return [_connection_json(c, counts.get(c.id, 0)) for c in conns]


class CreateConnectionRequest(BaseModel):
    token: str
    name: str = ""


@router.post("/connections")
def create_connection(
    body: CreateConnectionRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    token = body.token.strip()
    if not token:
        raise HTTPException(status_code=400, detail="Paste a SimpleFin setup token")
    claimed = not token.startswith(("http://", "https://"))
    try:
        if claimed:
            access_url = claim_setup_token(token)
        else:
            # Power-user path: a raw access URL (e.g. the SimpleFin demo).
            access_url = token
    except SimpleFinError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    dup = (
        db.query(Connection)
        .filter(Connection.user_id == user.id, Connection.access_url == access_url)
        .one_or_none()
    )
    if dup is not None:
        raise HTTPException(status_code=409, detail="This SimpleFin connection is already added")

    # Probe the credentials (balances only: cheap). Setup tokens are one-time,
    # so once a token has been claimed the credential must be persisted even
    # if this probe fails transiently — the user can just hit "Sync now".
    probe_error = ""
    try:
        fetch_accounts(access_url, include_pending=False, balances_only=True)
    except SimpleFinError as exc:
        if not claimed:
            raise HTTPException(
                status_code=400, detail=f"SimpleFin rejected that access URL: {exc}"
            )
        probe_error = str(exc)

    conn = Connection(user_id=user.id, name=body.name.strip(), access_url=access_url)
    if probe_error:
        conn.last_sync_at = now_ts()
        conn.last_sync_status = "error"
        conn.last_sync_error = f"Connected, but the first check failed: {probe_error}"
    db.add(conn)
    db.commit()
    if not probe_error:
        sync.sync_connection_in_background(conn.id)
    return _connection_json(conn, 0)


@router.delete("/connections/{connection_id}")
def delete_connection(
    connection_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    conn = _get_own_connection(db, user, connection_id)
    if sync.is_syncing(conn.id):
        raise HTTPException(status_code=409, detail="Connection is currently syncing; try again shortly")
    # ON DELETE CASCADE (with PRAGMA foreign_keys=ON) removes the accounts,
    # transactions, and sync log rows. Bulk delete so the ORM doesn't try to
    # manage the already-loaded relationship.
    db.query(Connection).filter(Connection.id == conn.id).delete(synchronize_session=False)
    db.commit()
    return {"ok": True}


@router.post("/connections/{connection_id}/sync")
def force_sync_connection(
    connection_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    conn = _get_own_connection(db, user, connection_id)
    started = sync.sync_connection_in_background(conn.id)
    return {"ok": True, "started": started, "already_syncing": not started}


@router.post("/sync")
def force_sync_all(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    conns = db.query(Connection).filter(Connection.user_id == user.id).all()
    started = [c.id for c in conns if sync.sync_connection_in_background(c.id)]
    return {"ok": True, "started": started, "total": len(conns)}


@router.get("/sync/status")
def sync_status(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    conns = db.query(Connection).filter(Connection.user_id == user.id).all()
    return {
        "syncing": any(sync.is_syncing(c.id) for c in conns),
        "connections": {c.id: sync.is_syncing(c.id) for c in conns},
    }


@router.get("/accounts")
def list_accounts(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    accounts = (
        db.query(Account)
        .filter(Account.user_id == user.id)
        .order_by(Account.org_name, Account.name)
        .all()
    )
    return [
        {
            "id": a.id,
            "connection_id": a.connection_id,
            "name": a.name,
            "org_name": a.org_name,
            "currency": a.currency,
            "balance": a.balance,
            "available_balance": a.available_balance,
            "balance_date": a.balance_date,
        }
        for a in accounts
    ]


def _parse_date(value: str, end_of_day: bool) -> int:
    try:
        dt = datetime.strptime(value, "%Y-%m-%d")
        if end_of_day:
            dt = dt + timedelta(days=1)
        # Naive datetime -> local timezone, matching how dates are shown in the UI.
        ts = int(dt.timestamp())
    except (ValueError, OverflowError, OSError):
        raise HTTPException(status_code=400, detail=f"Invalid date: {value} (expected YYYY-MM-DD)")
    return ts - 1 if end_of_day else ts


@router.get("/transactions")
def list_transactions(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    account_id: int | None = Query(default=None),
    start: str = Query(default=""),
    end: str = Query(default=""),
    q: str = Query(default=""),
    sort: str = Query(default="posted", pattern="^(posted|amount)$"),
    dir: str = Query(default="desc", pattern="^(asc|desc)$"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=500),
):
    query = db.query(Transaction).filter(Transaction.user_id == user.id)
    if account_id is not None:
        query = query.filter(Transaction.account_id == account_id)
    if start:
        query = query.filter(Transaction.posted >= _parse_date(start, end_of_day=False))
    if end:
        query = query.filter(Transaction.posted <= _parse_date(end, end_of_day=True))
    if q.strip():
        # Escape LIKE wildcards so searching for "50%" or "_" works literally.
        escaped = q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        needle = f"%{escaped}%"
        query = query.filter(
            or_(
                Transaction.description.ilike(needle, escape="\\"),
                Transaction.payee.ilike(needle, escape="\\"),
                Transaction.memo.ilike(needle, escape="\\"),
            )
        )

    total, total_amount = query.with_entities(
        func.count(), func.coalesce(func.sum(Transaction.amount), 0.0)
    ).one()

    sort_col = Transaction.posted if sort == "posted" else Transaction.amount
    sort_col = sort_col.asc() if dir == "asc" else sort_col.desc()
    rows = (
        query.order_by(sort_col, Transaction.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )

    page_account_ids = {t.account_id for t in rows}
    accounts_by_id = (
        {a.id: a for a in db.query(Account).filter(Account.id.in_(page_account_ids))}
        if page_account_ids
        else {}
    )
    items = []
    for t in rows:
        acct = accounts_by_id.get(t.account_id)
        items.append(
            {
                "id": t.id,
                "account_id": t.account_id,
                "account_name": acct.name if acct else "",
                "org_name": acct.org_name if acct else "",
                "currency": acct.currency if acct else "USD",
                "posted": t.posted,
                "amount": t.amount,
                "amount_str": t.amount_str,
                "description": t.description,
                "payee": t.payee,
                "memo": t.memo,
                "pending": t.pending,
            }
        )
    return {
        "items": items,
        "total": total,
        "total_amount": float(total_amount or 0.0),
        "page": page,
        "page_size": page_size,
    }
