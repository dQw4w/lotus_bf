"""
Application error types.

Routers and the DB layer raise these instead of leaking driver exceptions;
main.py turns them into JSON responses of the form
{"error": <code>, "detail": <message>}.
"""

from sqlalchemy.exc import DBAPIError, InterfaceError, OperationalError, SQLAlchemyError

# PostgreSQL SQLSTATE codes we map to specific errors
UNDEFINED_TABLE = "42P01"
UNDEFINED_FUNCTION = "42883"


class AppError(Exception):
    status_code = 500
    code = "internal_error"

    def __init__(self, message: str, *, detail: str | None = None, extra: dict | None = None):
        super().__init__(message)
        self.message = message
        # Extra context for the logs only; never sent to the client
        self.detail = detail
        # Extra fields merged into the JSON error body (e.g. error position, suggestions)
        self.extra = extra or {}


class InvalidParameterError(AppError):
    status_code = 400
    code = "invalid_parameter"


class QueryError(AppError):
    """Malformed boolean query; `extra` carries the error span and suggestions."""
    status_code = 400
    code = "invalid_query"


class NotFoundError(AppError):
    status_code = 404
    code = "not_found"


class DatabaseNotConfiguredError(AppError):
    status_code = 503
    code = "database_not_configured"


class DatabaseUnavailableError(AppError):
    status_code = 503
    code = "database_unavailable"


class SchemaNotInitializedError(AppError):
    status_code = 503
    code = "schema_not_initialized"


class DatabaseQueryError(AppError):
    status_code = 500
    code = "database_query_failed"


def translate_db_error(exc: SQLAlchemyError, schema: str) -> AppError:
    """Map a SQLAlchemy/psycopg2 exception to an AppError."""
    pgcode = getattr(getattr(exc, "orig", None), "pgcode", None)
    driver_msg = str(exc.orig if isinstance(exc, DBAPIError) else exc).strip()

    if pgcode == UNDEFINED_TABLE:
        return SchemaNotInitializedError(
            f"Required tables are missing from schema '{schema}'. "
            "Load the data with create_db.py against this DATABASE_URL.",
            detail=driver_msg,
        )
    if pgcode == UNDEFINED_FUNCTION:
        return DatabaseQueryError(
            "A database function is missing; is the PostGIS extension enabled?",
            detail=driver_msg,
        )
    if isinstance(exc, (OperationalError, InterfaceError)):
        return DatabaseUnavailableError("Could not reach the database.", detail=driver_msg)
    return DatabaseQueryError("Database query failed.", detail=driver_msg)
