"""Rule-based categorization engine.

Categories and their rules are per-user rows managed from the Categories
and Vendors pages. Matching is case-insensitive. Exact rules ("payee" and
"description" match types, managed as a vendor's automatic category) match
their field exactly and always beat "substring" rules (which match against
description + payee + memo) — a vendor-specific rule must win over a
generic substring regardless of age. Substring rules match longest-first
across all of a user's categories: a longer substring is more specific, so
it wins regardless of age; creation order breaks length ties.

Semantics (per spec):
- Everything starts uncategorized.
- Adding a rule applies it to *uncategorized* transactions only.
- Removing a rule recategorizes nothing.
- A per-category "recategorize" (offered while editing that category)
  re-derives that one category: transactions it holds that no longer match
  any of its rules go back to uncategorized, and uncategorized transactions
  matching its rules are pulled in.
- Setting/removing a vendor's automatic category (the Vendors page) is the
  exception to the two rules above: it re-derives that vendor's
  transactions, because the user is stating where they belong.
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


def winner_fn(
    db: Session, user_id: int, extra_substring: tuple[str, int] | None = None
) -> Callable[[Transaction], int | None]:
    """Build a matcher over the user's rules: exact rules first, then
    substring rules longest-first. `extra_substring` (text, category_id)
    weighs one hypothetical substring rule alongside the stored ones, for
    previews; it loses length ties to stored rules."""
    rows = (
        db.query(CategoryRule.substring, CategoryRule.match_type, CategoryRule.category_id)
        .join(Category, CategoryRule.category_id == Category.id)
        .filter(Category.user_id == user_id)
        .order_by(CategoryRule.id)
        .all()
    )
    exact_rules = [
        (substring.lower(), match_type, category_id)
        for substring, match_type, category_id in rows
        if match_type != "substring"
    ]
    substring_rules = [
        (substring.lower(), category_id)
        for substring, match_type, category_id in rows
        if match_type == "substring"
    ]
    if extra_substring is not None:
        text, category_id = extra_substring
        substring_rules.append((text.lower(), category_id))
    # Stable sort: equal lengths stay in creation order.
    substring_rules.sort(key=lambda rule: len(rule[0]), reverse=True)

    def winner(txn: Transaction) -> int | None:
        payee = txn.payee.strip().lower()
        description = txn.description.strip().lower()
        for text, match_type, category_id in exact_rules:
            field = payee if match_type == "payee" else description
            if field and field == text:
                return category_id
        hay = _haystack(txn)
        for text, category_id in substring_rules:
            if text in hay:
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
        winner = winner_fn(db, user_id)
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


def preview_rule(
    db: Session, user_id: int, category_id: int, substring: str, limit: int = 20
) -> tuple[int, list[Transaction]]:
    """Which uncategorized transactions would adding this substring to this
    category actually file *here*?

    The matcher weighs the candidate rule against the stored ones, so a row
    only shows up when this category would win it on the next pass: an exact
    rule or a longer substring of another category still claims it, while
    the candidate outranks any shorter substring elsewhere.
    """
    needle = substring.strip().lower()
    if not needle:
        return 0, []
    winner = winner_fn(db, user_id, extra_substring=(needle, category_id))
    matches = []
    count = 0
    for txn in (
        _auto_scope(db, user_id)
        .filter(Transaction.category_id.is_(None))
        .order_by(Transaction.posted.desc())
    ):
        if needle not in _haystack(txn):
            continue
        if winner(txn) != category_id:
            continue  # an exact or longer rule of another category wins it
        count += 1
        if len(matches) < limit:
            matches.append(txn)
    return count, matches


def recategorize_category(db: Session, user_id: int, category: Category) -> dict:
    """Re-derive one category: pull out rows that no longer match any of its
    rules, pull in uncategorized rows whose winning rule belongs to it."""
    with _lock:
        winner = winner_fn(db, user_id)
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


def set_vendor_category(
    db: Session, user_id: int, source: str, name: str, category_id: int | None
) -> dict:
    """Point a vendor's exact rule at `category_id` (None removes the rule),
    then re-derive the vendor's non-manual transactions against the updated
    rules. Vendors are grouped by payee falling back to description, so
    `source` says which field the exact rule must match."""
    name = name.strip()
    key = name.lower()
    with _lock:
        # Replace, don't stack: one exact rule per vendor. Compare in Python
        # (not SQL lower(), which folds ASCII only) so the match pairs
        # exactly with how /api/vendors groups.
        existing = [
            r
            for r in db.query(CategoryRule)
            .join(Category, CategoryRule.category_id == Category.id)
            .filter(Category.user_id == user_id, CategoryRule.match_type == source)
            if r.substring.lower() == key
        ]
        for rule in existing:
            db.delete(rule)
        new_rule = None
        if category_id is not None:
            new_rule = CategoryRule(
                category_id=category_id, substring=name, match_type=source
            )
            db.add(new_rule)
        db.flush()
        winner = winner_fn(db, user_id)
        changed = 0
        # Python-side matching: it must pair exactly with how /api/vendors
        # groups (strip + lower, description only when payee is blank).
        for txn in _auto_scope(db, user_id):
            payee = txn.payee.strip().lower()
            if source == "payee":
                if payee != key:
                    continue
            else:
                if payee or txn.description.strip().lower() != key:
                    continue
            target = winner(txn)
            if txn.category_id != target:
                txn.category_id = target
                changed += 1
        db.commit()
        log.info(
            "vendor %r (%s) -> category %s for user %d: %d transactions moved",
            name,
            source,
            category_id,
            user_id,
            changed,
        )
        return {"changed": changed, "rule_id": new_rule.id if new_rule else None}
