import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[2]
load_dotenv(ROOT / ".env")


def _bool(name: str, default: bool = False) -> bool:
    val = os.environ.get(name)
    if val is None:
        return default
    return val.strip().lower() in ("1", "true", "yes", "on")


class Settings:
    root: Path = ROOT

    secret_key: str = os.environ.get("SECRET_KEY", "")
    port: int = int(os.environ.get("PORT", "8400"))
    app_url: str = os.environ.get("APP_URL", "").rstrip("/") or f"http://localhost:{int(os.environ.get('PORT', '8400'))}"

    database_path: Path = Path(os.environ.get("DATABASE_PATH", str(ROOT / "data" / "durin.db")))

    google_client_id: str = os.environ.get("GOOGLE_CLIENT_ID", "")
    google_client_secret: str = os.environ.get("GOOGLE_CLIENT_SECRET", "")
    dev_login: bool = _bool("DEV_LOGIN", False)
    smtp_host: str = os.environ.get("SMTP_HOST", "smtp.gmail.com")
    smtp_port: int = int(os.environ.get("SMTP_PORT", "587"))
    smtp_user: str = os.environ.get("SMTP_USER", "")
    # Gmail shows app passwords with spaces; accept the value pasted either way.
    smtp_pass: str = os.environ.get("SMTP_PASS", "").replace(" ", "")
    allowed_emails: list[str] = [
        e.strip().lower() for e in os.environ.get("ALLOWED_EMAILS", "").split(",") if e.strip()
    ]

    sync_interval_hours: float = float(os.environ.get("SYNC_INTERVAL_HOURS", "6"))
    history_days: int = int(os.environ.get("HISTORY_DAYS", "365"))
    # Overlap window re-fetched on every sync so pending transactions get
    # updated/replaced once they post.
    sync_overlap_days: int = int(os.environ.get("SYNC_OVERLAP_DAYS", "7"))

    session_max_age_days: int = int(os.environ.get("SESSION_MAX_AGE_DAYS", "30"))

    @property
    def google_enabled(self) -> bool:
        return bool(self.google_client_id and self.google_client_secret)

    @property
    def magic_link_enabled(self) -> bool:
        return bool(self.smtp_user and self.smtp_pass)

    def email_allowed(self, email: str) -> bool:
        if not self.allowed_emails:
            # No allowlist configured: only permit sign-in while dev login is
            # on (local development). With real Google auth an empty allowlist
            # would otherwise mean "anyone with a Google account".
            return self.dev_login
        return email.strip().lower() in self.allowed_emails


settings = Settings()

if not settings.secret_key:
    raise RuntimeError(
        "SECRET_KEY is not set. Copy .env.example to .env (run.sh does this "
        "automatically) or set the SECRET_KEY environment variable."
    )
