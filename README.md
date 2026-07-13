# Durin

A small self-hosted app for pulling and checking your finances. It syncs
accounts and transactions from your banks via [SimpleFin](https://www.simplefin.org/),
stores them in SQLite, and shows them in a filterable, sortable table.

- **Backend:** Python (FastAPI) + SQLite. Background sync every 6 hours plus a
  refresh button in the top bar.
- **Frontend:** React + TypeScript (Vite), light and dark themes. An
  infinite-scrolling transactions table with filters (account, category, date
  range with quick presets, text search), sorting, spend/income/net summary,
  inline editing, and batch actions; a Spending page with a stacked-bar chart
  by category (day/week/month/year); an Assets page charting account balances
  over time; a Categories page; and a settings page for SimpleFin connections.
- **Categories:** per-user budget categories with substring matching rules,
  managed on the Categories page. See below.
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

## Categories & the Spending page

Everything starts uncategorized, and a new account starts with zero
categories. On the **Categories** page you create categories (name, emoji,
color, and a "not spending" flag for transfers/card payments) and attach
**substrings** to them. A transaction whose description, payee, or memo
contains a substring (case-insensitive; the longest matching substring wins,
so more specific rules beat broader ones) is filed in that category. A transaction belongs to at most one category.

- **Adding a substring** applies it to *uncategorized* transactions only — a
  live preview shows exactly which ones will match before you commit.
- **Removing a substring** never moves transactions.
- **Recategorize** (while editing a category) re-derives just that category:
  transactions it holds that no longer match any of its substrings go back to
  uncategorized, and uncategorized matches are pulled in.
- **Manual assignments win**: categorizing a transaction by hand (row editor
  or batch bar) marks it manual, and no rule pass ever touches it again.
- Deleting a category frees its transactions back to uncategorized.

**Editing & deleting transactions:** the pencil on each row opens an inline
editor (description, payee, memo, category — edits survive future syncs);
row checkboxes plus the batch bar delete or categorize many at once. Deleted
transactions stay gone even though the bank keeps reporting them.

The **Spending** page plots expenses (negative amounts, shown as positive) as
a stacked bar chart: pick the categories, a date range (with quick presets),
and a grouping (day / week / month / year). "Not spending" categories never
count there.

The **Vendors** page groups transactions by vendor (the payee, falling back
to the description) with each vendor's total and monthly average for the
filtered range — the usual account, category, and date filters apply. It also
shows each vendor's **automatic category**: click the chip to point the
vendor at a category (an exact-match rule that beats any substring and
re-derives the vendor's non-manual transactions immediately) or to remove the
vendor's own rule. A `≈` marker means the category is inherited from a
substring rule rather than a rule specific to that vendor.

## The Assets page

Every sync records one balance snapshot per account per day in the
`balance_snapshots` table (the day comes from the bank's balance-date stamp;
a same-day re-sync overwrites, so each day keeps its latest reading). The
Assets page plots those snapshots — a line per account plus a Total, with
values carried forward between readings — and lists every account's current
balance underneath.

SimpleFin only reports an account's *current* balance, so history starts
accumulating from the first sync after this table ships and **cannot be
backfilled**. (Reconstructing balances backwards from transactions would
break on investment accounts — market moves aren't transactions — so Durin
doesn't guess.)

## Importing historical transactions

`backend/scripts/import_csv.py` imports a Copilot/Monarch-style CSV export
(columns: date, name, amount, status, category, type, excluded, account,
account mask, note…):

```bash
PYTHONPATH=backend .venv/bin/python backend/scripts/import_csv.py \
    --csv ~/Documents/transactions.csv --email you@example.com          # dry run
PYTHONPATH=backend .venv/bin/python backend/scripts/import_csv.py \
    --csv ~/Documents/transactions.csv --email you@example.com --commit
```

CSV accounts matching an existing account by last-4 mask import only rows
older than that account's earliest bank-feed transaction (the CSV provides
pre-history; the bank feed owns the present — no duplicates). Unmatched
accounts are created under an "Imported history" connection that syncs
never touch. Amounts are sign-flipped (the export uses positive = expense),
income/transfer types map to your Income/Transfers categories, other CSV
categories map case-insensitively or are created, and categorized imports
are marked manual so rule passes leave them alone. `--revert` removes
everything a previous import added. Re-running the same file is a no-op;
before importing a *newer* export, `--revert` first (row fingerprints hash
the raw CSV text and formatting drift would defeat deduplication).

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
