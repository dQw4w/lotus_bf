from contextlib import contextmanager

from loguru import logger
from sqlalchemy import create_engine, make_url, text
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.exc import SQLAlchemyError

from config import DATABASE_URL, DB_SCHEMA
from errors import AppError, DatabaseNotConfiguredError, translate_db_error

REQUIRED_TABLES = ("coordinates", "metadata", "annotations_terms")

_engine: Engine | None = None


def get_engine() -> Engine:
    global _engine
    if _engine is not None:
        return _engine
    if not DATABASE_URL:
        raise DatabaseNotConfiguredError("Missing DATABASE_URL (or DB_URL) environment variable.")
    _engine = create_engine(DATABASE_URL, pool_pre_ping=True, pool_size=5, max_overflow=5)
    return _engine


def describe_database() -> str:
    """Connection target with the password masked, for logs."""
    if not DATABASE_URL:
        return "<not configured>"
    return make_url(DATABASE_URL).render_as_string(hide_password=True)


@contextmanager
def connect():
    """
    Open a transaction with search_path pointed at our schema.

    SET LOCAL keeps the setting transaction-scoped, which is safe behind
    Supabase's connection pooler. 'extensions' is where Supabase installs
    PostGIS; Postgres ignores it if the schema does not exist.

    SQLAlchemy errors raised inside the block are re-raised as AppErrors.
    """
    try:
        with get_engine().begin() as conn:
            conn.execute(text(f"SET LOCAL search_path TO {DB_SCHEMA}, public, extensions"))
            yield conn
    except SQLAlchemyError as e:
        raise translate_db_error(e, DB_SCHEMA) from e


def get_conn():
    """FastAPI dependency yielding a connection."""
    with connect() as conn:
        yield conn


def missing_tables(conn: Connection) -> list[str]:
    return [
        t for t in REQUIRED_TABLES
        if conn.execute(text("SELECT to_regclass(:name)"), {"name": f"{DB_SCHEMA}.{t}"}).scalar() is None
    ]


def check_database() -> None:
    """Log whether the database is reachable and loaded. Never raises."""
    logger.info("Database: {} (schema '{}')", describe_database(), DB_SCHEMA)
    try:
        with connect() as conn:
            missing = missing_tables(conn)
    except AppError as e:
        logger.error("Database check failed: {} ({})", e.message, e.detail or "no detail")
        return
    if missing:
        logger.error(
            "Schema '{}' is missing tables {}; run create_db.py against this DATABASE_URL",
            DB_SCHEMA, missing,
        )
    else:
        logger.info("Database check passed: all required tables present")


__all__ = ["Connection", "check_database", "connect", "get_conn", "get_engine", "missing_tables"]
