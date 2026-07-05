"""One-off importer for a Copilot/Monarch-style transactions CSV.

Usage (from the repo root):
    PYTHONPATH=backend .venv/bin/python backend/scripts/import_csv.py \
        --csv ~/Documents/transactions.csv --email you@example.com [--commit]
    ... --revert          # delete everything a previous import created

Strategy:
- CSV accounts matching an existing Durin account by last-4 mask import only
  rows strictly BEFORE that account's earliest existing transaction (clean
  cutoff: the CSV owns pre-history, the bank feed owns the present).
- CSV accounts with no Durin match become new accounts under a special
  "Imported history" connection (access_url "import:<file>"), which the sync
  engine skips.
- Amounts are sign-flipped (the export uses positive = expense).
- Categories: type income -> Income, type internal transfer -> Transfers,
  else the CSV category mapped case-insensitively (plus a small alias table)
  to existing categories; unknown categories are created (not-spending when
  the source rows were "excluded"). "Other"/empty stay uncategorized so
  substring rules can claim them. Categorized rows are marked manual.
- Row ids are deterministic ("import:<sha1>-<n>") so re-runs are idempotent
  FOR THE SAME FILE. The fingerprint hashes the raw CSV strings, so an export
  whose formatting drifts (amount "12.5" vs "12.50", renamed accounts) will
  not match: run --revert before importing a newer export.
"""

import argparse
import csv
import hashlib
import sys
from collections import Counter, defaultdict
from datetime import datetime

from sqlalchemy import func

from app.db import SessionLocal, init_db
from app.models import Account, Category, Connection, Transaction, User, now_ts

IMPORT_PREFIX = "import:"

# CSV category -> Durin category name (matched against the user's existing
# categories case-insensitively; aliases follow the user's own conventions).
ALIASES = {
    "restaurants": "restaurant",
    "healthcare": "health",
    "hoa": "home",
    "transportation": "life essentials",
    "travel": "travel & vacation",
    "subscriptions and utilities": "subscription & utilities",
}

# CSV categories that mean "leave uncategorized".
JUNK_CATEGORIES = {"", "other"}


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--csv", required=True)
    p.add_argument("--email", required=True)
    p.add_argument("--commit", action="store_true", help="write changes (default: dry run)")
    p.add_argument("--revert", action="store_true", help="delete a previous import")
    return p.parse_args()


def revert(db, user):
    n_txn = (
        db.query(Transaction)
        .filter(Transaction.user_id == user.id, Transaction.simplefin_id.like("import:%"))
        .delete(synchronize_session=False)
    )
    conns = (
        db.query(Connection)
        .filter(Connection.user_id == user.id, Connection.access_url.like("import:%"))
        .all()
    )
    n_acct = 0
    for conn in conns:
        n_acct += (
            db.query(Account).filter(Account.connection_id == conn.id).delete(
                synchronize_session=False
            )
        )
        db.query(Connection).filter(Connection.id == conn.id).delete(
            synchronize_session=False
        )
    db.commit()
    print(f"reverted: {n_txn} transactions, {n_acct} imported accounts, "
          f"{len(conns)} import connection(s) removed")
    # Import-created categories can't be told apart reliably, so list the
    # now-empty, rule-less ones as cleanup candidates instead of deleting.
    empties = [
        c.name
        for c in db.query(Category).filter(Category.user_id == user.id)
        if not c.rules
        and not db.query(Transaction.id)
        .filter(Transaction.category_id == c.id)
        .first()
    ]
    if empties:
        print("empty categories you may want to delete in the UI:", ", ".join(empties))


def main():
    args = parse_args()
    init_db()
    db = SessionLocal()
    user = db.query(User).filter(func.lower(User.email) == args.email.lower()).one_or_none()
    if user is None:
        sys.exit(f"no user with email {args.email}")

    if args.revert:
        revert(db, user)
        return

    rows = list(csv.DictReader(open(args.csv)))
    print(f"{len(rows)} CSV rows")

    # ---- resolve categories -------------------------------------------------
    existing_cats = {
        c.name.lower(): c
        for c in db.query(Category).filter(Category.user_id == user.id)
    }

    def resolve_category(row):
        """Return (category_name_lower or None). None = uncategorized."""
        if row["type"] == "income":
            return "income" if "income" in existing_cats else None
        if row["type"] == "internal transfer":
            return "transfers" if "transfers" in existing_cats else None
        raw = row["category"].strip().lower()
        if raw in JUNK_CATEGORIES:
            return None
        return ALIASES.get(raw, raw)

    # ---- resolve accounts ---------------------------------------------------
    durin_accounts = db.query(Account).filter(Account.user_id == user.id).all()

    def mask_of(acct: Account) -> str:
        name = acct.name.strip()
        if name.endswith(")") and "(" in name:
            return name.rsplit("(", 1)[1].rstrip(")")
        return ""

    by_mask = {}
    for a in durin_accounts:
        m = mask_of(a)
        if m:
            by_mask.setdefault(m, a)

    # Earliest existing BANK-FEED txn per matched account = the import
    # cutoff. Previously-imported rows must not shift it, or re-runs would
    # mis-skip everything newer than the oldest import.
    cutoffs = {}
    for a in durin_accounts:
        earliest = (
            db.query(func.min(Transaction.posted))
            .filter(
                Transaction.account_id == a.id,
                ~Transaction.simplefin_id.like("import:%"),
            )
            .scalar()
        )
        if earliest:
            cutoffs[a.id] = datetime.fromtimestamp(earliest).date()

    # One pass decides, per row, whether it imports; category tallies only
    # count rows that will actually be written.
    plan = defaultdict(lambda: {"import": 0, "skipped_overlap": 0})
    needed = Counter()
    excluded_votes = defaultdict(list)
    importable = []
    for r in rows:
        key = (r["account"], r["account mask"])
        target = by_mask.get(r["account mask"]) if r["account mask"] else None
        d = datetime.strptime(r["date"], "%Y-%m-%d").date()
        if target is not None:
            cutoff = cutoffs.get(target.id)
            if cutoff and d >= cutoff:
                plan[key]["skipped_overlap"] += 1
                continue
            plan[key]["target"] = f"existing: {target.name}"
        else:
            plan[key]["target"] = "new account"
        plan[key]["import"] += 1
        importable.append((r, target, d))
        name = resolve_category(r)
        if name and name not in existing_cats:
            needed[name] += 1
            excluded_votes[name].append(r["excluded"] == "true")

    print("\n--- plan ---")
    for key, info in sorted(plan.items()):
        print(f"{key[0]} ({key[1] or 'no mask'}): {info['import']} to import, "
              f"{info['skipped_overlap']} skipped (bank feed overlap) -> {info.get('target')}")
    print("\ncategories to create:", dict(needed) or "none")
    for name, votes in excluded_votes.items():
        if sum(votes) > len(votes) / 2:
            print(f"  {name}: will be flagged not-spending "
                  f"({sum(votes)}/{len(votes)} rows excluded in source)")

    if not args.commit:
        print("\nDRY RUN — rerun with --commit to write")
        return

    # ---- write --------------------------------------------------------------
    from app.categorize import categorize_uncategorized  # after init_db

    # palette for created categories/accounts (matches frontend CATEGORY_COLORS)
    palette = ["#2a78d6", "#eda100", "#008300", "#e34948", "#00a3d8", "#93379f",
               "#66a61e", "#e87ba4", "#0aa08c", "#a5692c", "#4a3aa7", "#e88a83",
               "#1baf7a", "#b02e63", "#4b6cb0", "#eb6834", "#8a6fd1", "#85871f",
               "#8a8984", "#c98500"]
    used_colors = {c.color for c in existing_cats.values()}

    for name in needed:
        color = next((c for c in palette if c not in used_colors), palette[0])
        used_colors.add(color)
        votes = excluded_votes[name]
        cat = Category(
            user_id=user.id,
            name=name,
            emoji="",
            color=color,
            is_transaction=sum(votes) > len(votes) / 2,
        )
        db.add(cat)
        db.flush()
        existing_cats[name] = cat
        print(f"created category {name!r} (not-spending={cat.is_transaction})")

    conn = (
        db.query(Connection)
        .filter(Connection.user_id == user.id, Connection.access_url.like("import:%"))
        .one_or_none()
    )
    if conn is None:
        conn = Connection(
            user_id=user.id,
            name="Imported history (CSV)",
            access_url=f"{IMPORT_PREFIX}{args.csv.rsplit('/', 1)[-1]}",
            last_sync_status="ok",
            last_sync_at=now_ts(),
            last_success_at=now_ts(),
        )
        db.add(conn)
        db.flush()

    def get_import_account(key) -> Account:
        if key in get_import_account.cache:
            return get_import_account.cache[key]
        name, mask = key
        display = f"{name} ({mask})" if mask else name
        acct = (
            db.query(Account)
            .filter(Account.connection_id == conn.id, Account.name == display)
            .one_or_none()
        )
        if acct is None:
            acct = Account(
                user_id=user.id,
                connection_id=conn.id,
                # name+mask: two source accounts can share a last-4.
                simplefin_id=f"{IMPORT_PREFIX}{name}|{mask}",
                name=display,
                org_name="Imported history",
                currency="USD",
                balance="0",
            )
            db.add(acct)
            db.flush()
        get_import_account.cache[key] = acct
        return acct
    get_import_account.cache = {}

    existing_ids = {
        sfid
        for (sfid,) in db.query(Transaction.simplefin_id).filter(
            Transaction.user_id == user.id, Transaction.simplefin_id.like("import:%")
        )
    }

    occurrences = Counter()
    added = skipped_dup = 0
    for r, target, d in importable:
        acct = target if target is not None else get_import_account(
            (r["account"], r["account mask"])
        )

        fingerprint = f"{r['date']}|{r['name']}|{r['amount']}|{r['account mask']}|{r['account']}"
        occurrences[fingerprint] += 1
        digest = hashlib.sha1(fingerprint.encode()).hexdigest()[:16]
        sfid = f"{IMPORT_PREFIX}{digest}-{occurrences[fingerprint]}"
        if sfid in existing_ids:
            skipped_dup += 1
            continue

        amount = -float(r["amount"])  # export uses positive = expense
        cat_name = resolve_category(r)
        cat = existing_cats.get(cat_name) if cat_name else None
        posted = int(datetime(d.year, d.month, d.day, 12, 0).timestamp())
        db.add(
            Transaction(
                user_id=user.id,
                account_id=acct.id,
                simplefin_id=sfid,
                posted=posted,
                amount=amount,
                amount_str=f"{amount:.2f}",
                description=r["name"],
                payee="",
                memo=r["note"] or "",
                pending=False,
                category_id=cat.id if cat else None,
                category_manual=cat is not None,
            )
        )
        added += 1
        if added % 2000 == 0:
            db.flush()

    db.commit()
    print(f"\nimported {added} transactions ({skipped_dup} already present)")

    swept = categorize_uncategorized(db, user.id)
    print(f"substring rules categorized {swept} of the uncategorized imports")


if __name__ == "__main__":
    main()
