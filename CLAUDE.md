# Durin — notes for Claude

## Where things run (don't trip on this)

- This checkout lives on **menegroth**, a remote headless server (192.168.1.203).
  **Port 8400 is the PRODUCTION server** (`durin.service`, systemd user unit),
  serving https://durin.giacomotag.io through Caddy, with Giacomo's real bank
  data in `data/durin.db`. Never dev-login to it, never point tests at it,
  never wipe or mutate its database.
- Prod serves static assets straight from this checkout's `frontend/dist`, so
  `npm run build` effectively deploys frontend changes immediately (the Python
  backend needs a `systemctl --user restart durin` to pick up backend changes).

## Verifying changes

- **UI-only change**: rebuild (`cd frontend && npm run build`) and check it
  directly on prod at https://durin.giacomotag.io — that's the practical route
  and Giacomo is fine with it.
- **Backend/risky change**: run a second instance on a different port with a
  scratch DB (env vars beat `.env` because `load_dotenv` doesn't override):
  `PORT=8410 APP_URL=... DEV_LOGIN=true ALLOWED_EMAILS=... DATABASE_PATH=<scratch> PYTHONPATH=backend .venv/bin/python -m app`
  Seed it with the SimpleFin demo token (see `.claude/skills/verify`).

## Browser automation gotcha

Claude's Chrome tools control Chrome on **Giacomo's local machine**, not on
menegroth. `localhost`/`127.0.0.1` URLs in the browser point at the laptop and
will not reach servers on menegroth. The app also binds to 127.0.0.1 only
(`app/main.py`), so a test instance is unreachable from the browser unless you
proxy/expose the port — ask Giacomo before doing that. For UI checks, prefer
https://durin.giacomotag.io (prod) in the browser.
