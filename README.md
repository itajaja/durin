# Durin

A small self-hosted app for pulling and checking your finances. It syncs
accounts and transactions from your banks via [SimpleFin](https://www.simplefin.org/),
stores them in SQLite, and shows them in a filterable, sortable table.

- **Backend:** Python (FastAPI) + SQLite. Background sync every 6 hours plus a
  force-refresh button.
- **Frontend:** React + TypeScript (Vite). One transactions table with filters
  (account, date range, text search) and sorting (date, amount), plus a
  settings page for SimpleFin connections.
- **Auth:** Google sign-in with an email allowlist; multiple users each see
  only their own data. A local dev login is available before Google is set up.

## Quick start

```bash
./run.sh
```

That creates a Python venv, installs dependencies, builds the frontend,
generates `.env` (with a random `SECRET_KEY`) on first run, and starts the app
at **http://localhost:8400**.

1. Open http://localhost:8400 and sign in with the dev login (any email on the
   allowlist — edit `ALLOWED_EMAILS` in `.env`).
2. Go to **Settings → Add a SimpleFin connection** and paste a setup token.
3. Transactions appear on the **Transactions** page as the first sync runs.

### Trying it without a bank

SimpleFin publishes a demo server with fake data. In Settings, paste this as
the token:

```
https://demo:demo@beta-bridge.simplefin.org/simplefin
```

### Connecting real banks

1. Create an account at [bridge.simplefin.org](https://bridge.simplefin.org)
   (it's a paid bridge, ~$1.50/month) and connect your banks there.
2. On the bridge site, click **New App Connection** to get a *setup token*.
3. Paste the setup token into Durin's Settings page. Setup tokens are
   one-time use — if a claim fails, generate a fresh one.

Durin exchanges the setup token for a long-lived access URL and stores it in
the local SQLite database (`data/durin.db`). Anyone with that file can read
your transactions, so treat it like a credentials file.

## Google sign-in

Dev login (`DEV_LOGIN=true` in `.env`) works out of the box for local use. To
enable Google:

1. Go to [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials)
   (create a project if needed).
2. Configure the OAuth consent screen (External, publish or add yourself as a
   test user).
3. **Create Credentials → OAuth client ID → Web application**, and add this
   authorized redirect URI:
   ```
   http://localhost:8400/api/auth/google/callback
   ```
4. Put the client ID and secret in `.env`:
   ```
   GOOGLE_CLIENT_ID=...apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=...
   ```
5. Make sure your Google account email is in `ALLOWED_EMAILS`, set
   `DEV_LOGIN=false`, and restart (`./run.sh`).

## Configuration

Everything lives in `.env` (see `.env.example` for the full list):

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` / `APP_URL` | `8400` / `http://localhost:8400` | Where the app runs; `APP_URL` is used for OAuth redirects. |
| `ALLOWED_EMAILS` | — | Comma-separated allowlist for sign-in (Google *and* dev login). |
| `DEV_LOGIN` | `true` | Email-only local login. Disable when exposing the app anywhere. |
| `GOOGLE_CLIENT_ID/SECRET` | — | Enables the Google sign-in button. |
| `SYNC_INTERVAL_HOURS` | `6` | Background sync cadence. |
| `HISTORY_DAYS` | `365` | How far back the first sync asks for. |
| `SYNC_OVERLAP_DAYS` | `7` | Window re-fetched each sync so pending transactions update. |
| `DATABASE_PATH` | `./data/durin.db` | SQLite location. |

## Development

```bash
# Backend with auto-reload
PYTHONPATH=backend .venv/bin/uvicorn app.main:app --reload --port 8400

# Frontend dev server (proxies /api to :8400)
cd frontend && npm run dev
```

`./run.sh --build` forces a frontend rebuild.

## How syncing works

- Each user can add any number of SimpleFin connections; each connection's
  accounts and transactions are stored per user.
- A background task re-syncs any connection whose last sync is older than
  `SYNC_INTERVAL_HOURS`. "Refresh from banks" forces it immediately.
- Syncs are incremental: each run re-fetches a `SYNC_OVERLAP_DAYS` window
  before the last successful sync so amounts/descriptions get corrected and
  pending transactions are replaced when they post (stale pending rows that
  the bank no longer reports are removed).
- Sync history is kept in the `sync_log` table; the Settings page shows each
  connection's last status and error.
