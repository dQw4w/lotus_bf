import os
import re


def _database_url() -> str | None:
    url = os.getenv("DATABASE_URL") or os.getenv("DB_URL")
    # Normalize old 'postgres://' scheme to 'postgresql://'
    if url and url.startswith("postgres://"):
        url = "postgresql://" + url[len("postgres://"):]
    return url


DATABASE_URL = _database_url()

# Schema that create_db.py loaded the tables into
DB_SCHEMA = os.getenv("DB_SCHEMA", "ns")
if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", DB_SCHEMA):
    raise ValueError(f"Invalid DB_SCHEMA: {DB_SCHEMA!r}")

# Must match the --srid used by create_db.py
SRID = int(os.getenv("DB_SRID", "4326"))

# Location queries match coordinates within a sphere of this radius (mm)
DEFAULT_RADIUS_MM = float(os.getenv("DEFAULT_RADIUS_MM", "6"))
MAX_RADIUS_MM = float(os.getenv("MAX_RADIUS_MM", "20"))

# Page size for the paginated (query-parameter) endpoints
DEFAULT_PAGE_SIZE = int(os.getenv("DEFAULT_PAGE_SIZE", "50"))
MAX_PAGE_SIZE = int(os.getenv("MAX_PAGE_SIZE", "500"))
