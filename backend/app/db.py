from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session, sessionmaker

from .config import settings

settings.database_path.parent.mkdir(parents=True, exist_ok=True)

engine = create_engine(
    f"sqlite:///{settings.database_path}",
    connect_args={"check_same_thread": False, "timeout": 30},
)


@event.listens_for(engine, "connect")
def _set_sqlite_pragmas(dbapi_connection, _record):
    cursor = dbapi_connection.cursor()
    # WAL so the web endpoints can read while a sync is writing.
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.execute("PRAGMA busy_timeout=30000")
    cursor.close()


SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def init_db() -> None:
    from . import models  # noqa: F401  (register mappings)

    models.Base.metadata.create_all(engine)
    _migrate(engine)


def _migrate(eng) -> None:
    """Additive migrations for pre-existing databases (create_all only
    creates missing tables, it never alters existing ones)."""
    from . import models

    with eng.connect() as conn:
        cols = [r[1] for r in conn.exec_driver_sql("PRAGMA table_info(transactions)")]
        if "category_id" not in cols:
            conn.exec_driver_sql(
                "ALTER TABLE transactions ADD COLUMN category_id INTEGER "
                "REFERENCES categories(id) ON DELETE SET NULL"
            )
            conn.exec_driver_sql(
                "CREATE INDEX IF NOT EXISTS ix_transactions_category_id "
                "ON transactions (category_id)"
            )
        for flag in ("category_manual", "deleted", "edited"):
            if flag not in cols:
                conn.exec_driver_sql(
                    f"ALTER TABLE transactions ADD COLUMN {flag} BOOLEAN DEFAULT 0"
                )

        acct_cols = [r[1] for r in conn.exec_driver_sql("PRAGMA table_info(accounts)")]
        if "alias" not in acct_cols:
            conn.exec_driver_sql("ALTER TABLE accounts ADD COLUMN alias VARCHAR DEFAULT ''")
        conn.commit()

        # Categories became per-user (they were briefly global, sourced from
        # a script). There is no meaningful owner to migrate the old global
        # rows to, so rebuild the table; transactions revert to uncategorized.
        cat_cols = [r[1] for r in conn.exec_driver_sql("PRAGMA table_info(categories)")]
        if cat_cols and "user_id" not in cat_cols:
            conn.exec_driver_sql("UPDATE transactions SET category_id = NULL")
            conn.exec_driver_sql("DROP TABLE categories")
            conn.commit()
            models.Base.metadata.create_all(eng)

        # Case-insensitive uniqueness, enforced at the DB so concurrent
        # creates can't slip case-variant duplicates past the API checks.
        conn.exec_driver_sql(
            "CREATE UNIQUE INDEX IF NOT EXISTS ux_categories_user_lower_name "
            "ON categories (user_id, lower(name))"
        )
        rule_cols = [
            r[1] for r in conn.exec_driver_sql("PRAGMA table_info(category_rules)")
        ]
        if "match_type" not in rule_cols:
            conn.exec_driver_sql(
                "ALTER TABLE category_rules ADD COLUMN match_type VARCHAR "
                "DEFAULT 'substring'"
            )
        conn.exec_driver_sql("DROP INDEX IF EXISTS ux_category_rules_lower")
        conn.exec_driver_sql(
            "CREATE UNIQUE INDEX IF NOT EXISTS ux_category_rules_lower2 "
            "ON category_rules (category_id, match_type, lower(substring))"
        )
        conn.commit()


def get_db():
    db: Session = SessionLocal()
    try:
        yield db
    finally:
        db.close()
