import re
from collections import Counter
from datetime import date, datetime, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import case, func, or_
from sqlalchemy.orm import Session, selectinload

from . import categorize, sync
from .db import get_db
from .auth import get_current_user
from .models import (
    Account,
    BalanceSnapshot,
    Category,
    CategoryRule,
    Connection,
    Transaction,
    User,
    now_ts,
)
from .simplefin import SimpleFinError, claim_setup_token, fetch_accounts

UNCATEGORIZED_COLOR = "#9b998e"
_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


def _clean_color(raw: str, fallback: str) -> str:
    color = raw.strip()
    if not color:
        return fallback
    if not _COLOR_RE.match(color):
        raise HTTPException(
            status_code=400, detail="Color must be a #rrggbb hex value"
        )
    return color

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
def list_accounts(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    include_disabled: bool = Query(default=False),
):
    q = db.query(Account).filter(Account.user_id == user.id)
    if not include_disabled:
        # Turned-off accounts are invisible everywhere except Settings,
        # which is the only caller passing include_disabled.
        q = q.filter(Account.enabled.is_(True))
    accounts = q.order_by(Account.org_name, Account.name).all()
    return [_account_json(a) for a in accounts]


def _account_json(a: Account) -> dict:
    # `name` stays the bank's own name (Settings shows it); every other page
    # displays `alias` when set.
    return {
        "id": a.id,
        "connection_id": a.connection_id,
        "name": a.name,
        "alias": a.alias or "",
        "org_name": a.org_name,
        "currency": a.currency,
        "balance": a.balance,
        "available_balance": a.available_balance,
        "balance_date": a.balance_date,
        "enabled": a.enabled,
    }


class AccountPatch(BaseModel):
    alias: str | None = None
    enabled: bool | None = None


@router.patch("/accounts/{account_id}")
def update_account(
    account_id: int,
    body: AccountPatch,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    acct = db.get(Account, account_id)
    if acct is None or acct.user_id != user.id:
        raise HTTPException(status_code=404, detail="Account not found")
    if body.alias is not None:
        acct.alias = body.alias.strip()
    resync = False
    if body.enabled is not None and body.enabled != acct.enabled:
        if not body.enabled:
            # A concurrent sync could re-insert rows between our delete and
            # the enabled flip landing; refuse rather than race it.
            if sync.is_syncing(acct.connection_id):
                raise HTTPException(
                    status_code=409,
                    detail="This account's connection is syncing; try again shortly",
                )
            db.query(Transaction).filter(Transaction.account_id == acct.id).delete(
                synchronize_session=False
            )
            db.query(BalanceSnapshot).filter(
                BalanceSnapshot.account_id == acct.id
            ).delete(synchronize_session=False)
        else:
            resync = True
        acct.enabled = body.enabled
    db.commit()
    if resync:
        # The wipe on turn-off means an incremental sync would restore only
        # a few days — refetch the connection's full history (idempotent for
        # its other accounts).
        sync.sync_connection_in_background(acct.connection_id, full_history=True)
    return _account_json(acct)


@router.get("/assets")
def assets(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    start: str = Query(default=""),
    end: str = Query(default=""),
    accounts: str = Query(default=""),  # comma-separated account ids; empty = all
):
    """Per-account balance history for the Assets page. Snapshots are sparse
    (one per day an account synced); the frontend forward-fills between
    them. Every account is returned even with zero points in range, so the
    picker and the current-balances table always have the full list."""
    account_ids: list[int] = []
    if accounts.strip():
        try:
            account_ids = [int(p) for p in accounts.split(",") if p.strip()]
        except ValueError:
            raise HTTPException(status_code=400, detail="accounts must be a list of ids")
    # Validate format; days are ISO strings so range filters compare lexically.
    if start:
        _parse_iso_date(start)
    if end:
        _parse_iso_date(end)

    q = db.query(BalanceSnapshot).filter(BalanceSnapshot.user_id == user.id)
    if account_ids:
        q = q.filter(BalanceSnapshot.account_id.in_(account_ids))
    if start:
        q = q.filter(BalanceSnapshot.day >= start)
    if end:
        q = q.filter(BalanceSnapshot.day <= end)

    def _value(raw: str) -> float:
        try:
            return float(raw)
        except (TypeError, ValueError):
            return 0.0

    points: dict[int, list[dict]] = {}
    if start:
        # Seed each account with its latest reading from before the range,
        # clamped to the start day, so a window opened mid-history still
        # carries the balance in from the left edge.
        latest = (
            db.query(
                BalanceSnapshot.account_id,
                func.max(BalanceSnapshot.day).label("day"),
            )
            .filter(BalanceSnapshot.user_id == user.id, BalanceSnapshot.day < start)
            .group_by(BalanceSnapshot.account_id)
            .subquery()
        )
        seed_q = db.query(BalanceSnapshot).join(
            latest,
            (BalanceSnapshot.account_id == latest.c.account_id)
            & (BalanceSnapshot.day == latest.c.day),
        )
        if account_ids:
            seed_q = seed_q.filter(BalanceSnapshot.account_id.in_(account_ids))
        for snap in seed_q:
            points[snap.account_id] = [{"day": start, "balance": _value(snap.balance)}]

    for snap in q.order_by(BalanceSnapshot.day):
        acct_points = points.setdefault(snap.account_id, [])
        if acct_points and acct_points[-1]["day"] == snap.day:
            acct_points[-1]["balance"] = _value(snap.balance)
            continue
        acct_points.append({"day": snap.day, "balance": _value(snap.balance)})

    accts = (
        db.query(Account)
        .filter(Account.user_id == user.id, Account.enabled.is_(True))
        .order_by(Account.org_name, Account.name)
        .all()
    )
    return {
        "accounts": [
            {
                "id": a.id,
                "name": a.alias or a.name,
                "org_name": a.org_name,
                "currency": a.currency,
                "balance": a.balance,
                "balance_date": a.balance_date,
                "points": points.get(a.id, []),
            }
            for a in accts
        ]
    }


def _category_json(c: Category, txn_count: int) -> dict:
    return {
        "id": c.id,
        "name": c.name,
        "emoji": c.emoji,
        "color": c.color,
        "is_transaction": c.is_transaction,
        "is_income": c.is_income,
        "txn_count": txn_count,
        "rules": [
            {"id": r.id, "substring": r.substring, "match_type": r.match_type}
            for r in c.rules
        ],
    }


def _get_own_category(db: Session, user: User, category_id: int) -> Category:
    cat = db.get(Category, category_id)
    if cat is None or cat.user_id != user.id:
        raise HTTPException(status_code=404, detail="Category not found")
    return cat


@router.get("/categories")
def list_categories(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    counts = dict(
        db.query(Transaction.category_id, func.count(Transaction.id))
        .filter(Transaction.user_id == user.id, Transaction.deleted.is_(False))
        .group_by(Transaction.category_id)
        .all()
    )
    cats = (
        db.query(Category)
        .options(selectinload(Category.rules))
        .filter(Category.user_id == user.id)
        .order_by(func.lower(Category.name))
        .all()
    )
    return {
        "categories": [_category_json(c, counts.get(c.id, 0)) for c in cats],
        "uncategorized_count": counts.get(None, 0),
    }


class CategoryBody(BaseModel):
    name: str
    emoji: str = ""
    color: str = "#8a8984"
    is_transaction: bool = False
    is_income: bool = False


@router.post("/categories")
def create_category(
    body: CategoryBody,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Category name is required")
    dup = (
        db.query(Category)
        .filter(Category.user_id == user.id, func.lower(Category.name) == name.lower())
        .one_or_none()
    )
    if dup is not None:
        raise HTTPException(status_code=409, detail=f"Category {name!r} already exists")
    cat = Category(
        user_id=user.id,
        name=name,
        emoji=body.emoji.strip()[:16],
        color=_clean_color(body.color, "#8a8984"),
        is_transaction=body.is_transaction,
        is_income=body.is_income,
    )
    db.add(cat)
    db.commit()
    return _category_json(cat, 0)


class CategoryPatch(BaseModel):
    name: str | None = None
    emoji: str | None = None
    color: str | None = None
    is_transaction: bool | None = None
    is_income: bool | None = None


@router.patch("/categories/{category_id}")
def update_category(
    category_id: int,
    body: CategoryPatch,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    cat = _get_own_category(db, user, category_id)
    if body.name is not None:
        name = body.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="Category name cannot be empty")
        dup = (
            db.query(Category)
            .filter(
                Category.user_id == user.id,
                func.lower(Category.name) == name.lower(),
                Category.id != cat.id,
            )
            .one_or_none()
        )
        if dup is not None:
            raise HTTPException(status_code=409, detail=f"Category {name!r} already exists")
        cat.name = name
    if body.emoji is not None:
        cat.emoji = body.emoji.strip()[:16]
    if body.color is not None:
        cat.color = _clean_color(body.color, cat.color)
    if body.is_transaction is not None:
        cat.is_transaction = body.is_transaction
    if body.is_income is not None:
        cat.is_income = body.is_income
    db.commit()
    count = (
        db.query(func.count(Transaction.id))
        .filter(Transaction.category_id == cat.id, Transaction.deleted.is_(False))
        .scalar()
    )
    return _category_json(cat, count or 0)


@router.delete("/categories/{category_id}")
def delete_category(
    category_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    cat = _get_own_category(db, user, category_id)
    # Rows manually assigned here must go back to full automatic handling —
    # a lingering category_manual flag would silently exempt them from every
    # future rule pass with no visible reason.
    db.query(Transaction).filter(Transaction.category_id == cat.id).update(
        {Transaction.category_manual: False}, synchronize_session=False
    )
    # ON DELETE SET NULL frees this category's transactions back to
    # uncategorized; ON DELETE CASCADE removes its rules.
    db.query(Category).filter(Category.id == cat.id).delete(synchronize_session=False)
    db.commit()
    return {"ok": True}


class RuleBody(BaseModel):
    substring: str
    match_type: Literal["substring", "payee", "description"] = "substring"


@router.post("/categories/{category_id}/rules")
def add_rule(
    category_id: int,
    body: RuleBody,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    cat = _get_own_category(db, user, category_id)
    substring = body.substring.strip()
    if not substring:
        raise HTTPException(status_code=400, detail="Substring cannot be empty")
    dup = any(
        r.substring.lower() == substring.lower() and r.match_type == body.match_type
        for r in cat.rules
    )
    if dup:
        raise HTTPException(status_code=409, detail=f"{substring!r} is already a rule here")
    rule = CategoryRule(category_id=cat.id, substring=substring, match_type=body.match_type)
    db.add(rule)
    db.commit()
    # Adding a substring applies to uncategorized transactions only. Report
    # how many landed in THIS category (the sweep can also file rows under
    # other categories whose rules match rows freed by past removals).
    def _count() -> int:
        return (
            db.query(func.count(Transaction.id))
            .filter(Transaction.category_id == cat.id, Transaction.deleted.is_(False))
            .scalar()
            or 0
        )

    before = _count()
    categorize.categorize_uncategorized(db, user.id)
    return {
        "rule": {"id": rule.id, "substring": rule.substring, "match_type": rule.match_type},
        "categorized": _count() - before,
    }


@router.delete("/categories/{category_id}/rules/{rule_id}")
def delete_rule(
    category_id: int,
    rule_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    cat = _get_own_category(db, user, category_id)
    rule = db.get(CategoryRule, rule_id)
    if rule is None or rule.category_id != cat.id:
        raise HTTPException(status_code=404, detail="Rule not found")
    # Removing a substring deliberately recategorizes nothing.
    db.delete(rule)
    db.commit()
    return {"ok": True}


@router.get("/categories/{category_id}/preview")
def preview_rule(
    category_id: int,
    substring: str = Query(default=""),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    cat = _get_own_category(db, user, category_id)
    count, sample = categorize.preview_rule(db, user.id, cat.id, substring)
    accounts_by_id = {
        a.id: a for a in db.query(Account).filter(Account.user_id == user.id)
    }
    return {
        "count": count,
        "sample": [
            {
                "id": t.id,
                "posted": t.posted,
                "description": t.description or t.payee or "(no description)",
                "amount_str": t.amount_str,
                "currency": (
                    accounts_by_id[t.account_id].currency
                    if t.account_id in accounts_by_id
                    else "USD"
                ),
            }
            for t in sample
        ],
    }


@router.post("/categories/{category_id}/recategorize")
def recategorize_category(
    category_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    cat = _get_own_category(db, user, category_id)
    result = categorize.recategorize_category(db, user.id, cat)
    return {"ok": True, **result}


@router.post("/categorize/uncategorized")
def categorize_uncategorized(
    user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    """Run the rules over uncategorized transactions only — nothing that
    already has a category is touched."""
    changed = categorize.categorize_uncategorized(db, user.id)
    return {"ok": True, "changed": changed}


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


def _apply_txn_filters(query, accounts: str, categories: str, start: str, end: str):
    """The account/category/date filters shared by /transactions and
    /vendors — both must interpret the same query params identically."""
    if accounts.strip():
        try:
            account_ids = [int(p) for p in accounts.split(",") if p.strip()]
        except ValueError:
            raise HTTPException(status_code=400, detail="accounts must be a list of ids")
        query = query.filter(Transaction.account_id.in_(account_ids))
    if categories.strip():
        include_none = False
        cat_ids: list[int] = []
        for part in categories.split(","):
            part = part.strip()
            if not part:
                continue
            if part == "none":
                include_none = True
            else:
                try:
                    cat_ids.append(int(part))
                except ValueError:
                    raise HTTPException(
                        status_code=400, detail="categories must be ids or 'none'"
                    )
        conds = []
        if cat_ids:
            conds.append(Transaction.category_id.in_(cat_ids))
        if include_none:
            conds.append(Transaction.category_id.is_(None))
        if conds:
            query = query.filter(or_(*conds))
    if start:
        query = query.filter(Transaction.posted >= _parse_date(start, end_of_day=False))
    if end:
        query = query.filter(Transaction.posted <= _parse_date(end, end_of_day=True))
    return query


@router.get("/transactions")
def list_transactions(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    accounts: str = Query(default=""),  # comma-separated account ids; empty = all
    categories: str = Query(default=""),  # comma-separated category ids and/or "none"
    start: str = Query(default=""),
    end: str = Query(default=""),
    q: str = Query(default=""),
    sort: str = Query(default="posted", pattern="^(posted|amount)$"),
    dir: str = Query(default="desc", pattern="^(asc|desc)$"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=500),
):
    query = db.query(Transaction).filter(
        Transaction.user_id == user.id, Transaction.deleted.is_(False)
    )
    query = _apply_txn_filters(query, accounts, categories, start, end)
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

    total = query.with_entities(func.count()).scalar() or 0

    # The money summary ignores not-spending categories (transfers, card
    # payments…) — unless the category filter explicitly selects them, in
    # which case the user is asking about exactly those rows.
    money_query = query
    if not categories.strip():
        money_query = query.outerjoin(
            Category, Transaction.category_id == Category.id
        ).filter(
            or_(Transaction.category_id.is_(None), Category.is_transaction.is_(False))
        )
    total_amount, total_spend, total_income = money_query.with_entities(
        func.coalesce(func.sum(Transaction.amount), 0.0),
        func.coalesce(
            func.sum(case((Transaction.amount < 0, -Transaction.amount), else_=0.0)), 0.0
        ),
        func.coalesce(
            func.sum(case((Transaction.amount > 0, Transaction.amount), else_=0.0)), 0.0
        ),
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
    items = [_txn_json(t, accounts_by_id.get(t.account_id)) for t in rows]
    return {
        "items": items,
        "total": total,
        "total_amount": float(total_amount or 0.0),
        "total_spend": float(total_spend or 0.0),
        "total_income": float(total_income or 0.0),
        "page": page,
        "page_size": page_size,
    }


def _txn_json(t: Transaction, acct: Account | None) -> dict:
    return {
        "id": t.id,
        "account_id": t.account_id,
        "account_name": (acct.alias or acct.name) if acct else "",
        "org_name": acct.org_name if acct else "",
        "currency": acct.currency if acct else "USD",
        "posted": t.posted,
        "amount": t.amount,
        "amount_str": t.amount_str,
        "description": t.description,
        "payee": t.payee,
        "memo": t.memo,
        "pending": t.pending,
        "category_id": t.category_id,
        "category_manual": t.category_manual,
        "edited": t.edited,
    }


class TxnPatch(BaseModel):
    description: str | None = None
    payee: str | None = None
    memo: str | None = None
    category_id: int | None = None


@router.patch("/transactions/{txn_id}")
def update_transaction(
    txn_id: int,
    body: TxnPatch,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    txn = db.get(Transaction, txn_id)
    if txn is None or txn.user_id != user.id or txn.deleted:
        raise HTTPException(status_code=404, detail="Transaction not found")
    provided = body.model_fields_set
    if "description" in provided and body.description is not None:
        txn.description = body.description.strip()
        txn.edited = True
    if "payee" in provided and body.payee is not None:
        txn.payee = body.payee.strip()
        txn.edited = True
    if "memo" in provided and body.memo is not None:
        txn.memo = body.memo.strip()
        txn.edited = True
    if "category_id" in provided:
        if body.category_id is not None:
            _get_own_category(db, user, body.category_id)
        txn.category_id = body.category_id
        # Hand-picked (including hand-picked "uncategorized"): rule passes
        # must leave it alone from now on.
        txn.category_manual = True
    db.commit()
    acct = db.get(Account, txn.account_id)
    return _txn_json(txn, acct)


class TxnBatch(BaseModel):
    ids: list[int]
    action: Literal["delete", "categorize"]
    category_id: int | None = None


@router.post("/transactions/batch")
def batch_transactions(
    body: TxnBatch,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if not body.ids:
        raise HTTPException(status_code=400, detail="No transactions selected")
    if len(body.ids) > 10000:
        raise HTTPException(status_code=400, detail="Too many transactions in one batch")
    query = db.query(Transaction).filter(
        Transaction.user_id == user.id,
        Transaction.id.in_(body.ids),
        Transaction.deleted.is_(False),
    )
    if body.action == "delete":
        affected = query.update({Transaction.deleted: True}, synchronize_session=False)
    else:
        if body.category_id is not None:
            _get_own_category(db, user, body.category_id)
        affected = query.update(
            {Transaction.category_id: body.category_id, Transaction.category_manual: True},
            synchronize_session=False,
        )
    db.commit()
    return {"ok": True, "affected": affected}


def _vendor_of(t: Transaction) -> tuple[str, str]:
    """A transaction's vendor: the payee, falling back to the description.
    Returns (source, name); source "none" groups the leftovers."""
    payee = t.payee.strip()
    if payee:
        return "payee", payee
    description = t.description.strip()
    if description:
        return "description", description
    return "none", ""


@router.get("/vendors")
def list_vendors(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    accounts: str = Query(default=""),  # comma-separated account ids; empty = all
    categories: str = Query(default=""),  # comma-separated category ids and/or "none"
    start: str = Query(default=""),
    end: str = Query(default=""),
):
    """Transactions grouped by vendor. Each vendor carries its totals for
    the filtered range plus its automatic category: the vendor's own exact
    rule when one exists — the rule PUT /vendors/rule manages. Categories
    that merely fall out of substring rules are not reported."""
    query = db.query(Transaction).filter(
        Transaction.user_id == user.id, Transaction.deleted.is_(False)
    )
    txns = _apply_txn_filters(query, accounts, categories, start, end).all()

    groups: dict[tuple[str, str], dict] = {}
    min_posted: int | None = None
    max_posted: int | None = None
    for t in txns:
        source, raw = _vendor_of(t)
        g = groups.setdefault(
            (source, raw.lower()),
            {"names": Counter(), "count": 0, "total": 0.0,
             "spend": 0.0, "income": 0.0},
        )
        g["names"][raw] += 1
        g["count"] += 1
        g["total"] += t.amount
        if t.amount < 0:
            g["spend"] += -t.amount
        else:
            g["income"] += t.amount
        if min_posted is None or t.posted < min_posted:
            min_posted = t.posted
        if max_posted is None or t.posted > max_posted:
            max_posted = t.posted

    # Average per month, mirroring /spending: over the requested range when
    # both ends are given, else over the span the data actually covers.
    if start and end:
        span_days = (_parse_iso_date(end) - _parse_iso_date(start)).days + 1
    elif min_posted is not None and max_posted is not None:
        span_days = (
            datetime.fromtimestamp(max_posted).date()
            - datetime.fromtimestamp(min_posted).date()
        ).days + 1
    else:
        span_days = 0
    months_span = max(span_days / 30.4375, 1.0)

    # A vendor's own rule: the exact rule whose text is the vendor name.
    exact_rules = (
        db.query(CategoryRule)
        .join(Category, CategoryRule.category_id == Category.id)
        .filter(
            Category.user_id == user.id,
            CategoryRule.match_type.in_(("payee", "description")),
        )
        .order_by(CategoryRule.id)
        .all()
    )
    rule_by_key: dict[tuple[str, str], CategoryRule] = {}
    for r in exact_rules:
        rule_by_key.setdefault((r.match_type, r.substring.lower()), r)

    vendors = []
    for (source, key), g in groups.items():
        rule = rule_by_key.get((source, key)) if source != "none" else None
        vendors.append(
            {
                "key": f"{source}:{key}",
                "name": g["names"].most_common(1)[0][0] or "(no description)",
                "source": source,
                "count": g["count"],
                "total": round(g["total"], 2),
                "spend": round(g["spend"], 2),
                "income": round(g["income"], 2),
                "avg_month": round(g["total"] / months_span, 2),
                "rule_id": rule.id if rule else None,
                "rule_category_id": rule.category_id if rule else None,
            }
        )
    vendors.sort(key=lambda v: abs(v["total"]), reverse=True)
    return {"vendors": vendors, "months_span": round(months_span, 2)}


class VendorRuleBody(BaseModel):
    source: Literal["payee", "description"]
    name: str
    category_id: int | None = None


@router.put("/vendors/rule")
def set_vendor_rule(
    body: VendorRuleBody,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Set (or, with category_id null, remove) a vendor's automatic
    category and re-derive that vendor's non-manual transactions."""
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Vendor name is required")
    if body.category_id is not None:
        _get_own_category(db, user, body.category_id)
    result = categorize.set_vendor_category(
        db, user.id, body.source, name, body.category_id
    )
    return {"ok": True, **result}


def _bucket_key(d: date, granularity: str) -> str:
    if granularity == "year":
        return str(d.year)
    if granularity == "month":
        return d.strftime("%Y-%m")
    if granularity == "week":
        return (d - timedelta(days=d.weekday())).isoformat()  # Monday of the week
    return d.isoformat()


def _bucket_range(start: date, end: date, granularity: str) -> list[str]:
    buckets: list[str] = []
    if granularity == "year":
        return [str(y) for y in range(start.year, end.year + 1)]
    if granularity == "month":
        cur = start.replace(day=1)
        while cur <= end:
            buckets.append(cur.strftime("%Y-%m"))
            cur = (cur.replace(day=28) + timedelta(days=4)).replace(day=1)
    else:
        step = 7 if granularity == "week" else 1
        cur = start - timedelta(days=start.weekday()) if granularity == "week" else start
        while cur <= end:
            buckets.append(cur.isoformat())
            cur += timedelta(days=step)
    return buckets


def _parse_iso_date(value: str) -> date:
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Invalid date: {value} (expected YYYY-MM-DD)")


@router.get("/spending")
def spending(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    start: str = Query(default=""),
    end: str = Query(default=""),
    granularity: str = Query(default="month", pattern="^(day|week|month|year)$"),
    categories: str = Query(default=""),  # comma-separated ids and/or "none"
):
    """Spending (expenses only, as positive magnitudes) bucketed over time,
    one series per selected category. Categories marked is_transaction or
    is_income are never counted, regardless of the request."""
    today = datetime.now().date()
    end_date = _parse_iso_date(end) if end else today
    if start:
        start_date = _parse_iso_date(start)
    else:
        # Default: the last 6 calendar months.
        start_date = (end_date.replace(day=1) - timedelta(days=150)).replace(day=1)
    if start_date > end_date:
        raise HTTPException(status_code=400, detail="start must be before end")

    buckets = _bucket_range(start_date, end_date, granularity)
    if len(buckets) > 400:
        raise HTTPException(
            status_code=400,
            detail="Too many buckets for that range — pick a coarser granularity",
        )

    spendable = {
        c.id: c
        for c in db.query(Category).filter(
            Category.user_id == user.id,
            Category.is_transaction.is_(False),
            Category.is_income.is_(False),
        )
    }
    include_uncategorized = False
    selected_ids: set[int] = set()
    if categories.strip():
        for part in categories.split(","):
            part = part.strip()
            if not part:
                continue
            if part == "none":
                include_uncategorized = True
            else:
                try:
                    cid = int(part)
                except ValueError:
                    raise HTTPException(status_code=400, detail=f"Bad category id: {part}")
                if cid in spendable:
                    selected_ids.add(cid)
    else:
        selected_ids = set(spendable)
        include_uncategorized = True

    start_ts = _parse_date(start_date.isoformat(), end_of_day=False)
    end_ts = _parse_date(end_date.isoformat(), end_of_day=True)
    cat_filter = []
    if selected_ids:
        cat_filter.append(Transaction.category_id.in_(selected_ids))
    if include_uncategorized:
        cat_filter.append(Transaction.category_id.is_(None))
    if not cat_filter:
        return {"granularity": granularity, "buckets": buckets, "series": [], "grand_total": 0.0}

    # Both signs: credits (refunds) offset a bucket's spending, clamped at
    # zero below — a column can reach 0 but never goes negative.
    rows = (
        db.query(Transaction.posted, Transaction.amount, Transaction.category_id)
        .filter(
            Transaction.user_id == user.id,
            Transaction.deleted.is_(False),
            Transaction.posted >= start_ts,
            Transaction.posted <= end_ts,
            or_(*cat_filter),
        )
        .all()
    )

    bucket_index = {b: i for i, b in enumerate(buckets)}
    sums: dict[int | None, list[float]] = {}
    for posted, amount, category_id in rows:
        key = _bucket_key(datetime.fromtimestamp(posted).date(), granularity)
        idx = bucket_index.get(key)
        if idx is None:
            continue  # posted timestamp lands outside the range edges
        series = sums.setdefault(category_id, [0.0] * len(buckets))
        series[idx] += -amount  # debits positive, credits negative

    # Average per month across the range; ranges shorter than a month show
    # the plain total rather than extrapolating.
    months_span = max(((end_date - start_date).days + 1) / 30.4375, 1.0)

    def _series_json(category_id: int | None) -> dict:
        values = [
            round(max(v, 0.0), 2) for v in sums.get(category_id, [0.0] * len(buckets))
        ]
        if category_id is None:
            meta = {"name": "Uncategorized", "emoji": "", "color": UNCATEGORIZED_COLOR}
        else:
            c = spendable[category_id]
            meta = {"name": c.name, "emoji": c.emoji, "color": c.color}
        total = round(sum(values), 2)
        return {
            "key": "none" if category_id is None else str(category_id),
            "category_id": category_id,
            **meta,
            "values": values,
            "total": total,
            "avg_month": round(total / months_span, 2),
        }

    series = [
        _series_json(cid)
        for cid in sorted(selected_ids, key=lambda i: spendable[i].name.lower())
    ]
    if include_uncategorized:
        series.append(_series_json(None))
    grand_total = round(sum(s["total"] for s in series), 2)
    return {
        "granularity": granularity,
        "buckets": buckets,
        "series": series,
        "grand_total": grand_total,
        "grand_avg_month": round(grand_total / months_span, 2),
    }


@router.get("/cashflow")
def cashflow(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    start: str = Query(default=""),
    end: str = Query(default=""),
    granularity: str = Query(default="month", pattern="^(day|week|month|year)$"),
):
    """Income vs spending bucketed over time. Categories marked
    is_transaction (transfers, card payments…) are excluded entirely.
    Income is what lands in is_income categories (their debits count
    against it); everything else — uncategorized included — goes to the
    spending column, where credits (refunds) reduce it."""
    today = datetime.now().date()
    end_date = _parse_iso_date(end) if end else today
    if start:
        start_date = _parse_iso_date(start)
    else:
        # Default: the last 6 calendar months.
        start_date = (end_date.replace(day=1) - timedelta(days=150)).replace(day=1)
    if start_date > end_date:
        raise HTTPException(status_code=400, detail="start must be before end")

    buckets = _bucket_range(start_date, end_date, granularity)
    if len(buckets) > 400:
        raise HTTPException(
            status_code=400,
            detail="Too many buckets for that range — pick a coarser granularity",
        )

    start_ts = _parse_date(start_date.isoformat(), end_of_day=False)
    end_ts = _parse_date(end_date.isoformat(), end_of_day=True)
    rows = (
        db.query(Transaction.posted, Transaction.amount, Category.is_income)
        .outerjoin(Category, Transaction.category_id == Category.id)
        .filter(
            Transaction.user_id == user.id,
            Transaction.deleted.is_(False),
            Transaction.posted >= start_ts,
            Transaction.posted <= end_ts,
            or_(Transaction.category_id.is_(None), Category.is_transaction.is_(False)),
        )
        .all()
    )

    bucket_index = {b: i for i, b in enumerate(buckets)}
    income = [0.0] * len(buckets)
    spending = [0.0] * len(buckets)
    for posted, amount, is_income in rows:
        key = _bucket_key(datetime.fromtimestamp(posted).date(), granularity)
        idx = bucket_index.get(key)
        if idx is None:
            continue  # posted timestamp lands outside the range edges
        if is_income:
            income[idx] += amount
        else:
            # Both signs: a bucket's spending can dip below zero when
            # refunds outweigh purchases (the chart just draws no bar).
            spending[idx] += -amount

    income = [round(v, 2) for v in income]
    spending = [round(v, 2) for v in spending]
    net = [round(i - s, 2) for i, s in zip(income, spending)]
    total_income = round(sum(income), 2)
    total_spending = round(sum(spending), 2)
    total_net = round(total_income - total_spending, 2)
    months_span = max(((end_date - start_date).days + 1) / 30.4375, 1.0)
    return {
        "granularity": granularity,
        "buckets": buckets,
        "income": income,
        "spending": spending,
        "net": net,
        "total_income": total_income,
        "total_spending": total_spending,
        "total_net": total_net,
        "avg_income_month": round(total_income / months_span, 2),
        "avg_spending_month": round(total_spending / months_span, 2),
        "avg_net_month": round(total_net / months_span, 2),
    }
