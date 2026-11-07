from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, PlainTextResponse
from loguru import logger
from sqlalchemy import text

from config import DB_SCHEMA
from db import connect, get_engine, missing_tables
from errors import AppError, SchemaNotInitializedError

router = APIRouter(tags=["health"])

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"
SPA_DIR = STATIC_DIR / "app"  # built frontend, see Dockerfile


@router.get("/", response_class=HTMLResponse, include_in_schema=False)
def index():
    """The LoTUS-BF app if it has been built, otherwise the plain server check."""
    if (SPA_DIR / "index.html").is_file():
        return FileResponse(SPA_DIR / "index.html", media_type="text/html")
    return '<p>Server working!</p><p><a href="/ui">Explorer UI</a> · <a href="/docs">API docs</a></p>'


@router.get("/ui", include_in_schema=False)
def ui():
    return FileResponse(STATIC_DIR / "index.html", media_type="text/html")


FAN_PLEDGE = (
    "If Prof. Tren has 100 million fans, I am one of them. "
    "If Prof. Tren has 100 fans, I am one of them. "
    "If Prof. Tren has 1 fan, it is me. "
    "If Prof. Tren has 0 fans, I am dead."
)


@router.get("/health", response_class=PlainTextResponse)
def health_check():
    """Liveness ping for the keep-awake cron job. Doesn't touch the database."""
    return FAN_PLEDGE


@router.get("/img")
def show_img():
    return FileResponse(STATIC_DIR / "amygdala.gif", media_type="image/gif")


@router.get("/test_db")
def test_db():
    payload = {"ok": False, "schema": DB_SCHEMA}
    try:
        payload["dialect"] = get_engine().dialect.name
        with connect() as conn:
            payload["version"] = conn.exec_driver_sql("SELECT version()").scalar()

            missing = missing_tables(conn)
            if missing:
                payload["missing_tables"] = missing
                raise SchemaNotInitializedError(
                    f"Schema '{DB_SCHEMA}' is missing tables {missing}; "
                    "run create_db.py against this DATABASE_URL."
                )

            # Counts
            payload["coordinates_count"] = conn.execute(text("SELECT COUNT(*) FROM coordinates")).scalar()
            payload["metadata_count"] = conn.execute(text("SELECT COUNT(*) FROM metadata")).scalar()
            payload["annotations_terms_count"] = conn.execute(text("SELECT COUNT(*) FROM annotations_terms")).scalar()

            # Samples
            rows = conn.execute(text(
                "SELECT study_id, ST_X(geom) AS x, ST_Y(geom) AS y, ST_Z(geom) AS z FROM coordinates LIMIT 3"
            )).mappings().all()
            payload["coordinates_sample"] = [dict(r) for r in rows]

            rows = conn.execute(text(
                "SELECT study_id, title, authors, journal, year FROM metadata LIMIT 3"
            )).mappings().all()
            payload["metadata_sample"] = [dict(r) for r in rows]

            rows = conn.execute(text(
                "SELECT study_id, contrast_id, term, weight FROM annotations_terms LIMIT 3"
            )).mappings().all()
            payload["annotations_terms_sample"] = [dict(r) for r in rows]

        payload["ok"] = True
        return payload

    except AppError as e:
        # Diagnostic endpoint: report what failed instead of the generic error body
        logger.opt(exception=e.__cause__).error("test_db failed [{}]: {}", e.code, e.message)
        payload["error"] = e.code
        payload["detail"] = e.message
        return JSONResponse(payload, status_code=e.status_code)
