import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import api, auth
from .config import settings
from .db import init_db
from .sync import scheduler_loop, set_main_loop

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s"
)

FRONTEND_DIST = settings.root / "frontend" / "dist"


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    set_main_loop(asyncio.get_running_loop())
    task = asyncio.create_task(scheduler_loop())
    yield
    task.cancel()


app = FastAPI(title="Durin", lifespan=lifespan)
app.include_router(auth.router)
app.include_router(api.router)

# SameSite=lax does not isolate localhost ports (SameSite ignores the port),
# so a page served by some other local app could fire authenticated POSTs.
# Reject state-changing requests whose Origin isn't ours.
_ALLOWED_ORIGINS = {
    urlsplit(settings.app_url).netloc,
    f"localhost:{settings.port}",
    f"127.0.0.1:{settings.port}",
    "localhost:5173",  # vite dev server (proxies /api and forwards Origin)
    "127.0.0.1:5173",
}


@app.middleware("http")
async def csrf_origin_check(request: Request, call_next):
    if request.method in ("POST", "PUT", "PATCH", "DELETE"):
        origin = request.headers.get("origin")
        if origin and urlsplit(origin).netloc not in _ALLOWED_ORIGINS:
            return JSONResponse(
                {"detail": "Cross-origin request blocked"}, status_code=403
            )
    return await call_next(request)


if (FRONTEND_DIST / "index.html").exists():
    app.mount(
        "/assets", StaticFiles(directory=FRONTEND_DIST / "assets"), name="assets"
    )

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        # Unknown API paths should 404, not render the SPA.
        if path.startswith("api/"):
            return JSONResponse({"detail": "Not found"}, status_code=404)
        # Serve real files (favicon etc.); everything else falls back to the
        # SPA index so client-side routes work on refresh.
        try:
            candidate = (FRONTEND_DIST / path).resolve()
            if (
                path
                and candidate.is_relative_to(FRONTEND_DIST)
                and candidate.is_file()
            ):
                return FileResponse(candidate)
        except (ValueError, OSError):
            pass  # e.g. embedded null byte in the path
        return FileResponse(FRONTEND_DIST / "index.html")

else:

    @app.get("/", include_in_schema=False)
    def missing_frontend():
        return JSONResponse(
            {
                "error": "Frontend build not found",
                "fix": "run: cd frontend && npm install && npm run build (or use ./run.sh)",
            },
            status_code=503,
        )


def main() -> None:
    import uvicorn

    uvicorn.run(
        "app.main:app",
        host="127.0.0.1",
        port=settings.port,
        app_dir=str(Path(__file__).resolve().parents[1]),
    )


if __name__ == "__main__":
    main()
