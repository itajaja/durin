"""Minimal SimpleFin protocol client.

Protocol (https://www.simplefin.org/protocol.html):
  1. The user obtains a *setup token* from their SimpleFin server (e.g.
     https://bridge.simplefin.org). The token is the base64 of a one-time
     "claim URL".
  2. POSTing to the claim URL returns an *access URL* of the form
     https://user:pass@host/simplefin — this is the long-lived credential.
  3. GET {access_url}/accounts returns accounts and their transactions.
"""

import base64
import binascii
from urllib.parse import unquote, urlsplit, urlunsplit

import httpx


class SimpleFinError(Exception):
    pass


def _split_access_url(access_url: str) -> tuple[str, tuple[str, str] | None]:
    """Split credentials out of an access URL.

    httpx rejects URLs with userinfo in some configurations, so pass basic
    auth explicitly.
    """
    parts = urlsplit(access_url.strip())
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise SimpleFinError("Access URL is not a valid http(s) URL")
    auth = None
    if parts.username is not None:
        # urlsplit leaves userinfo percent-encoded; decode before use.
        auth = (unquote(parts.username), unquote(parts.password or ""))
    netloc = parts.hostname
    if parts.port:
        netloc = f"{netloc}:{parts.port}"
    bare = urlunsplit((parts.scheme, netloc, parts.path.rstrip("/"), "", ""))
    return bare, auth


def claim_setup_token(setup_token: str) -> str:
    """Exchange a base64 setup token for an access URL."""
    try:
        claim_url = base64.b64decode(setup_token.strip(), validate=True).decode("utf-8")
    except (binascii.Error, UnicodeDecodeError):
        raise SimpleFinError(
            "That doesn't look like a SimpleFin setup token (expected base64 text)."
        )
    if not claim_url.startswith(("http://", "https://")):
        raise SimpleFinError("Setup token did not decode to a claim URL.")
    try:
        resp = httpx.post(claim_url, headers={"Content-Length": "0"}, timeout=30)
    except httpx.HTTPError as exc:
        raise SimpleFinError(f"Could not reach SimpleFin server: {exc}")
    if resp.status_code == 403:
        raise SimpleFinError(
            "SimpleFin rejected the setup token (it may have already been used — "
            "setup tokens are one-time)."
        )
    if 300 <= resp.status_code < 400:
        raise SimpleFinError(
            "SimpleFin redirected the claim request, which usually means the "
            "token is stale or from a retired server. Generate a fresh setup "
            "token and try again."
        )
    if resp.status_code != 200:
        raise SimpleFinError(
            f"SimpleFin claim failed with HTTP {resp.status_code}: {resp.text[:200]}"
        )
    access_url = resp.text.strip()
    _split_access_url(access_url)  # validate
    return access_url


def fetch_accounts(
    access_url: str,
    start_date: int | None = None,
    end_date: int | None = None,
    include_pending: bool = True,
    balances_only: bool = False,
) -> dict:
    """GET /accounts from a SimpleFin access URL. Returns the parsed JSON."""
    bare, auth = _split_access_url(access_url)
    params: dict[str, str] = {}
    if start_date is not None:
        params["start-date"] = str(int(start_date))
    if end_date is not None:
        params["end-date"] = str(int(end_date))
    if include_pending:
        params["pending"] = "1"
    if balances_only:
        params["balances-only"] = "1"
    try:
        resp = httpx.get(f"{bare}/accounts", params=params, auth=auth, timeout=120)
    except httpx.HTTPError as exc:
        raise SimpleFinError(f"Could not reach SimpleFin server: {exc}")
    if resp.status_code == 403:
        raise SimpleFinError("SimpleFin rejected the access credentials (HTTP 403).")
    if resp.status_code != 200:
        raise SimpleFinError(
            f"SimpleFin /accounts failed with HTTP {resp.status_code}: {resp.text[:200]}"
        )
    try:
        data = resp.json()
    except ValueError:
        raise SimpleFinError("SimpleFin returned a non-JSON response.")
    if not isinstance(data, dict) or not isinstance(data.get("accounts"), list):
        raise SimpleFinError("SimpleFin response is missing the accounts list.")
    return data
