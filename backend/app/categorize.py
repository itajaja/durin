"""Rule-based categorization engine.

Categories and their substring rules are per-user rows managed from the
Categories page. Matching is case-insensitive against a transaction's
description + payee + memo; rules match in creation order and the first
match wins across all of a user's categories.

Semantics (per spec):
- Everything starts uncategorized.
- Adding a rule applies it to *uncategorized* transactions only.
- Removing a rule recategorizes nothing.
- A per-category "recategorize" (offered while editing that category)
  re-derives that one category: transactions it holds that no longer match
  any of its rules go back to uncategorized, and uncategorized transactions
  matching its rules are pulled in.
- Manual assignments (category_manual) are never touched by any rule pass.
"""

import logging
import threading
from typing import Callable

from sqlalchemy.orm import Session

from .models import Category, CategoryRule, Transaction

log = logging.getLogger("durin.categorize")

# Serializes rule passes; they read-modify-write transactions in bulk.
_lock = threading.Lock()


def _haystack(txn: Transaction) -> str:
    return f"{txn.description} {txn.payee} {txn.memo}".lower()


def _winner_fn(db: Session, user_id: int) -> Callable[[Transaction], int | None]:
    """Build a first-match-wins matcher over the user's rules."""
    rows = (
        db.query(CategoryRule.substring, CategoryRule.category_id)
        .join(Category, CategoryRule.category_id == Category.id)
        .filter(Category.user_id == user_id)
        .order_by(CategoryRule.id)
        .all()
    )
    pairs = [(substring.lower(), category_id) for substring, category_id in rows]

    def winner(txn: Transaction) -> int | None:
        hay = _haystack(txn)
        for substring, category_id in pairs:
            if substring in hay:
                return category_id
        return None

    return winner


def _auto_scope(db: Session, user_id: int):
    """Transactions that rule passes may touch: the user's, not deleted,
    never manually categorized."""
    return db.query(Transaction).filter(
        Transaction.user_id == user_id,
        Transaction.deleted.is_(False),
        Transaction.category_manual.is_(False),
    )


def categorize_uncategorized(db: Session, user_id: int) -> int:
    """Match all of the user's rules against their uncategorized
    transactions (runs after every sync)."""
    with _lock:
        winner = _winner_fn(db, user_id)
        changed = 0
        for txn in _auto_scope(db, user_id).filter(Transaction.category_id.is_(None)):
            target = winner(txn)
            if target is not None:
                txn.category_id = target
                changed += 1
        db.commit()
        if changed:
            log.info("categorized %d transactions for user %d", changed, user_id)
        return changed


def recategorize_all(db: Session, user_id: int) -> int:
    """Re-derive every non-manual transaction from the current rules: each
    gets its first-match-wins winner, or reverts to uncategorized when no
    rule matches. Manual assignments are never touched."""
    with _lock:
        winner = _winner_fn(db, user_id)
        changed = 0
        for txn in _auto_scope(db, user_id).yield_per(500):
            target = winner(txn)
            if txn.category_id != target:
                txn.category_id = target
                changed += 1
        db.commit()
        log.info("recategorized all for user %d: %d changed", user_id, changed)
        return changed


def preview_rule(
    db: Session, user_id: int, category_id: int, substring: str, limit: int = 20
) -> tuple[int, list[Transaction]]:
    """Which uncategorized transactions would adding this substring to this
    category actually file *here*?

    Existing rules keep priority: an uncategorized row that matches an older
    rule of another category (possible after rule removals or category
    deletes, which don't recategorize) would be claimed by that category on
    the next pass, so it must not show up in this preview.
    """
    needle = substring.strip().lower()
    if not needle:
        return 0, []
    winner = _winner_fn(db, user_id)
    matches = []
    count = 0
    for txn in (
        _auto_scope(db, user_id)
        .filter(Transaction.category_id.is_(None))
        .order_by(Transaction.posted.desc())
    ):
        if needle not in _haystack(txn):
            continue
        prior = winner(txn)
        if prior is not None and prior != category_id:
            continue  # an existing rule of another category claims it first
        count += 1
        if len(matches) < limit:
            matches.append(txn)
    return count, matches


def recategorize_category(db: Session, user_id: int, category: Category) -> dict:
    """Re-derive one category: pull out rows that no longer match any of its
    rules, pull in uncategorized rows whose winning rule belongs to it."""
    with _lock:
        winner = _winner_fn(db, user_id)
        pulled_out = pulled_in = 0
        for txn in _auto_scope(db, user_id).filter(
            Transaction.category_id == category.id
        ):
            if winner(txn) != category.id:
                txn.category_id = None
                pulled_out += 1
        for txn in _auto_scope(db, user_id).filter(Transaction.category_id.is_(None)):
            if winner(txn) == category.id:
                txn.category_id = category.id
                pulled_in += 1
        db.commit()
        log.info(
            "recategorized %r for user %d: -%d +%d",
            category.name,
            user_id,
            pulled_out,
            pulled_in,
        )
        return {"pulled_out": pulled_out, "pulled_in": pulled_in}
