---
name: verify
description: Build, launch, and drive Durin (SimpleFin finance viewer) end-to-end to verify changes at the real surface.
---

# Verifying Durin

## Build & launch

```bash
./run.sh                 # venv + deps + .env + frontend build + server on :8400
./run.sh --build         # force a frontend rebuild after frontend/src changes
```

Manual equivalent (from repo root — the server MUST be launched from repo root,
`.venv` is a relative path):

```bash
(cd frontend && npm run build)
PYTHONPATH=backend .venv/bin/python -m app   # serves http://localhost:8400
```

Frontend changes need a rebuild (`npm run build`); backend changes need a
server restart. The SPA catch-all only registers if `frontend/dist/index.html`
exists at startup.

## Drive it

Session bootstrap (dev login is on by default in `.env`):

```bash
curl -s -c /tmp/ck.txt -X POST localhost:8400/api/auth/dev-login \
  -H 'Content-Type: application/json' -d '{"email":"giacomo@anthropic.com"}'
```

The email must be in `ALLOWED_EMAILS` in `.env`.

Live SimpleFin data — the demo server works and returns ~340+ transactions
across 3 accounts (data keeps growing between syncs):

```bash
curl -s -b /tmp/ck.txt -X POST localhost:8400/api/connections \
  -H 'Content-Type: application/json' \
  -d '{"token":"https://demo:demo@beta-bridge.simplefin.org/simplefin","name":"Demo"}'
sleep 8   # background initial sync
curl -s -b /tmp/ck.txt 'localhost:8400/api/transactions?page_size=3'
```

Key flows worth driving after changes: login → transactions table
(filters/sort/pagination), Settings → add connection via the FORM (not just
the API), Sync now, Delete, "Refresh from banks" on the Transactions page,
category filter + chips, the Spending page (picker toggles, hover
tooltip, granularity/date changes), and the Assets page (balance history
lines from `GET /api/assets`; snapshots are written by each sync, so force
a sync first on a fresh database).

Categories: per-user, managed via API/UI (no script). Demo-data substrings
that match: "grocer", "fishin", "pay day". Key endpoints: POST
/api/categories, POST /api/categories/{id}/rules (applies to uncategorized
only), DELETE .../rules/{rid} (moves nothing), POST
/api/categories/{id}/recategorize (never touches category_manual rows),
GET /api/categories/preview?substring=x. Transactions: PATCH
/api/transactions/{id} (amend text → edited flag; category → manual flag),
POST /api/transactions/batch {ids, action: delete|categorize}. Soft-deleted
rows must stay gone across syncs (check `deleted` in sqlite).

zsh gotcha: quote URLs with `?`/`&` (globbing) and don't put curl flags in
an unquoted shell variable (zsh doesn't word-split; the cookie flag
silently drops and everything 401s).

cwd gotcha: `cd frontend && npm run build` leaves the persistent shell in
frontend/, so a later `PYTHONPATH=backend .venv/bin/python -m app` silently
fails (relative paths). Always `cd /Users/giacomo/code/durin` in the same
command that launches the server.

CAUTION: the database may contain the user's REAL bank data (they use the
app live). Never wipe data/durin.db, delete connections, or run destructive
tests against user 1's rows — use a second allowlisted test user instead.

## Gotchas

- **Sandbox**: the server needs outbound network to `beta-bridge.simplefin.org`
  and curl to localhost is blocked by the sandbox proxy — run server + curl
  with sandbox disabled.
- **Demo quirks**: the demo server ignores start-dates beyond 90 days and
  returns `errors: ["Requested date range exceeds limit of 90 days and was
  capped."]` — the app classifies this as benign (status stays `ok`, note
  shown). Institution-health errors instead produce status `partial` and do
  NOT advance the incremental cursor. The published base64 demo *setup token*
  is dead upstream (redirects); only the direct access URL works.
- **Browser automation**: the Settings Delete button uses `window.confirm`,
  which freezes Chrome-extension automation — delete via
  `curl -X DELETE .../api/connections/{id}` instead. Typing into the setup
  textarea needs `form_input` (plain click+type misses the React field).
- SQLite lives at `data/durin.db`; delete it for a fresh start. Server log
  goes wherever you redirect it; sync activity logs under `durin.sync`.
- State-changing requests with a foreign `Origin` header are rejected (403)
  by the CSRF middleware — either omit Origin (curl default) or send
  `Origin: http://localhost:8400`.
