import base64
import json
import secrets
import smtplib
import time
from email.message import EmailMessage
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import RedirectResponse
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .config import settings
from .db import get_db
from .models import User

router = APIRouter(prefix="/api/auth", tags=["auth"])

SESSION_COOKIE = "durin_session"
_session_signer = URLSafeTimedSerializer(settings.secret_key, salt="durin-session")
_state_signer = URLSafeTimedSerializer(settings.secret_key, salt="durin-oauth-state")
_magic_signer = URLSafeTimedSerializer(settings.secret_key, salt="durin-magic-link")

MAGIC_LINK_MAX_AGE = 15 * 60
MAGIC_LINK_RESEND_SECONDS = 60

GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"


def set_session_cookie(response: Response, user_id: int) -> None:
    token = _session_signer.dumps({"uid": user_id})
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=settings.session_max_age_days * 86400,
        httponly=True,
        samesite="lax",
        secure=settings.app_url.startswith("https://"),
        path="/",
    )


def get_current_user(request: Request, db: Session = Depends(get_db)) -> User:
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        raise HTTPException(status_code=401, detail="Not signed in")
    try:
        payload = _session_signer.loads(token, max_age=settings.session_max_age_days * 86400)
    except (BadSignature, SignatureExpired):
        raise HTTPException(status_code=401, detail="Session expired")
    user = db.get(User, payload.get("uid"))
    if user is None:
        raise HTTPException(status_code=401, detail="User not found")
    return user


def _upsert_user(
    db: Session, email: str, name: str = "", picture: str = "", google_sub: str | None = None
) -> User:
    email = email.strip().lower()
    user = db.query(User).filter(User.email == email).one_or_none()
    if user is None:
        user = User(email=email, name=name, picture=picture, google_sub=google_sub)
        db.add(user)
    else:
        if name:
            user.name = name
        if picture:
            user.picture = picture
        if google_sub:
            user.google_sub = google_sub
    db.commit()
    return user


@router.get("/config")
def auth_config():
    return {
        "google_enabled": settings.google_enabled,
        "magic_link_enabled": settings.magic_link_enabled,
        "dev_login_enabled": settings.dev_login,
    }


class DevLoginRequest(BaseModel):
    email: str
    name: str = ""


@router.post("/dev-login")
def dev_login(body: DevLoginRequest, response: Response, db: Session = Depends(get_db)):
    if not settings.dev_login:
        raise HTTPException(status_code=403, detail="Dev login is disabled")
    email = body.email.strip().lower()
    if "@" not in email:
        raise HTTPException(status_code=400, detail="Enter a valid email address")
    if settings.allowed_emails and not settings.email_allowed(email):
        raise HTTPException(status_code=403, detail=f"{email} is not on the allowlist")
    user = _upsert_user(db, email, name=body.name or email.split("@")[0])
    set_session_cookie(response, user.id)
    return {"ok": True, "email": user.email}


def _send_magic_link_email(email: str, link: str) -> None:
    msg = EmailMessage()
    msg["From"] = settings.smtp_user
    msg["To"] = email
    msg["Subject"] = "Sign in to Durin"
    msg.set_content(
        f"Click this link to sign in to Durin:\n\n{link}\n\n"
        "It expires in 15 minutes. If you didn't request it, you can ignore this email."
    )
    with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=30) as smtp:
        smtp.starttls()
        smtp.login(settings.smtp_user, settings.smtp_pass)
        smtp.send_message(msg)


class MagicLinkRequest(BaseModel):
    email: str


# Last send time per email, to keep double-clicks from double-sending. In-process
# only, which is fine for a single-worker app.
_magic_last_sent: dict[str, float] = {}


@router.post("/magic/request")
def magic_link_request(body: MagicLinkRequest):
    if not settings.magic_link_enabled:
        raise HTTPException(status_code=404, detail="Email sign-in is not configured")
    email = body.email.strip().lower()
    if "@" not in email:
        raise HTTPException(status_code=400, detail="Enter a valid email address")
    # Check the allowlist before sending so we never email strangers.
    if not settings.email_allowed(email):
        raise HTTPException(status_code=403, detail=f"{email} is not on the allowlist")
    last = _magic_last_sent.get(email)
    if last is not None and time.monotonic() - last < MAGIC_LINK_RESEND_SECONDS:
        raise HTTPException(
            status_code=429,
            detail="A link was just sent — check your inbox, or retry in a minute",
        )
    token = _magic_signer.dumps({"email": email})
    link = f"{settings.app_url}/api/auth/magic/verify?token={token}"
    try:
        _send_magic_link_email(email, link)
    except (smtplib.SMTPException, OSError):
        raise HTTPException(status_code=502, detail="Could not send the email — try again")
    _magic_last_sent[email] = time.monotonic()
    return {"ok": True}


@router.get("/magic/verify")
def magic_link_verify(token: str = "", db: Session = Depends(get_db)):
    if not settings.magic_link_enabled:
        raise HTTPException(status_code=404, detail="Email sign-in is not configured")
    try:
        payload = _magic_signer.loads(token, max_age=MAGIC_LINK_MAX_AGE)
    except SignatureExpired:
        return RedirectResponse("/login?error=magic_expired")
    except BadSignature:
        return RedirectResponse("/login?error=magic_invalid")
    email = (payload.get("email") or "").strip().lower()
    # Re-check in case the allowlist changed after the link was issued.
    if not email or not settings.email_allowed(email):
        return RedirectResponse("/login?error=not_allowed")
    user = _upsert_user(db, email)
    if not user.name:
        user.name = email.split("@")[0]
        db.commit()
    response = RedirectResponse("/")
    set_session_cookie(response, user.id)
    return response


OAUTH_NONCE_COOKIE = "durin_oauth_nonce"


@router.get("/google/login")
def google_login():
    if not settings.google_enabled:
        raise HTTPException(status_code=404, detail="Google auth is not configured")
    nonce = secrets.token_urlsafe(16)
    state = _state_signer.dumps({"nonce": nonce})
    params = {
        "client_id": settings.google_client_id,
        "redirect_uri": f"{settings.app_url}/api/auth/google/callback",
        "response_type": "code",
        "scope": "openid email profile",
        "state": state,
        "prompt": "select_account",
    }
    response = RedirectResponse(f"{GOOGLE_AUTH_URL}?{urlencode(params)}")
    # Bind the OAuth flow to this browser: the callback must present both the
    # signed state *and* this cookie with the same nonce (blocks login-CSRF).
    response.set_cookie(
        OAUTH_NONCE_COOKIE,
        state,
        max_age=600,
        httponly=True,
        samesite="lax",
        secure=settings.app_url.startswith("https://"),
        path="/api/auth/google",
    )
    return response


def _decode_jwt_payload(id_token: str) -> dict:
    # The id_token comes straight from Google's token endpoint over TLS, so
    # we decode the payload without re-verifying the signature.
    try:
        payload_b64 = id_token.split(".")[1]
        payload_b64 += "=" * (-len(payload_b64) % 4)
        return json.loads(base64.urlsafe_b64decode(payload_b64))
    except Exception:
        raise HTTPException(status_code=502, detail="Could not decode Google id_token")


@router.get("/google/callback")
def google_callback(
    request: Request,
    code: str = "",
    state: str = "",
    error: str = "",
    db: Session = Depends(get_db),
):
    if not settings.google_enabled:
        raise HTTPException(status_code=404, detail="Google auth is not configured")
    if error:
        return RedirectResponse(f"/login?error={error}")
    try:
        state_payload = _state_signer.loads(state, max_age=600)
        cookie_payload = _state_signer.loads(
            request.cookies.get(OAUTH_NONCE_COOKIE, ""), max_age=600
        )
        if not state_payload.get("nonce") or state_payload["nonce"] != cookie_payload.get("nonce"):
            raise BadSignature("nonce mismatch")
    except (BadSignature, SignatureExpired):
        raise HTTPException(
            status_code=400,
            detail="Invalid OAuth state — start the sign-in again from the login page",
        )
    if not code:
        raise HTTPException(status_code=400, detail="Missing authorization code")

    try:
        token_resp = httpx.post(
            GOOGLE_TOKEN_URL,
            data={
                "code": code,
                "client_id": settings.google_client_id,
                "client_secret": settings.google_client_secret,
                "redirect_uri": f"{settings.app_url}/api/auth/google/callback",
                "grant_type": "authorization_code",
            },
            timeout=30,
        )
    except httpx.HTTPError:
        raise HTTPException(status_code=502, detail="Could not reach Google")
    if token_resp.status_code != 200:
        raise HTTPException(status_code=502, detail="Google token exchange failed")
    id_token = token_resp.json().get("id_token", "")
    claims = _decode_jwt_payload(id_token)

    email = (claims.get("email") or "").lower()
    if not email or not claims.get("email_verified", False):
        return RedirectResponse("/login?error=unverified_email")
    if not settings.email_allowed(email):
        return RedirectResponse("/login?error=not_allowed")

    user = _upsert_user(
        db,
        email,
        name=claims.get("name", ""),
        picture=claims.get("picture", ""),
        google_sub=claims.get("sub"),
    )
    response = RedirectResponse("/")
    set_session_cookie(response, user.id)
    response.delete_cookie(OAUTH_NONCE_COOKIE, path="/api/auth/google")
    return response


@router.post("/logout")
def logout(response: Response):
    response.delete_cookie(SESSION_COOKIE, path="/")
    return {"ok": True}


@router.get("/me")
def me(user: User = Depends(get_current_user)):
    return {"id": user.id, "email": user.email, "name": user.name, "picture": user.picture}
