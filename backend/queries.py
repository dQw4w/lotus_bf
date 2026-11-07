"""
SQL for study lookups.

Each *_filter() returns (subquery, params) selecting a set of study_ids.
fetch_studies() returns metadata for studies in `include` and, optionally,
not in `exclude` -- which is how the dissociation endpoints compute A \\ B.
fetch_page() is the sorted, paginated variant used by the query-parameter endpoints.
"""

from sqlalchemy import text
from sqlalchemy.engine import Connection

from config import SRID

Filter = tuple[str, dict]

STUDY_COLUMNS = "m.study_id, m.title, m.authors, m.journal, m.year"

# Whitelisted ORDER BY expressions per sort key (never interpolate user input).
# PMIDs are numeric strings, so order by length first to get numeric order.
SORT_EXPRESSIONS = {
    "year": ("m.year",),
    "title": ("lower(m.title)",),
    "journal": ("lower(m.journal)",),
    "study_id": ("length(m.study_id)", "m.study_id"),
    "distance": ("distance_mm",),
}
DEFAULT_ORDER = {"year": "desc", "title": "asc", "journal": "asc", "study_id": "asc", "distance": "asc"}


def _point(prefix: str) -> str:
    return f"ST_SetSRID(ST_MakePoint(:{prefix}_x, :{prefix}_y, :{prefix}_z), {SRID})"


def term_filter(term: str, prefix: str = "a") -> Filter:
    sql = f"SELECT study_id FROM annotations_terms WHERE term = :{prefix}_term"
    return sql, {f"{prefix}_term": term}


def location_filter(xyz: tuple[float, float, float], radius: float, prefix: str = "a") -> Filter:
    x, y, z = xyz
    sql = f"SELECT study_id FROM coordinates WHERE ST_3DDWithin(geom, {_point(prefix)}, :{prefix}_r)"
    return sql, {f"{prefix}_x": x, f"{prefix}_y": y, f"{prefix}_z": z, f"{prefix}_r": radius}


def _where(include: Filter, exclude: Filter | None) -> tuple[str, dict]:
    inc_sql, params = include
    sql = f"m.study_id IN ({inc_sql})"
    if exclude is not None:
        exc_sql, exc_params = exclude
        sql += f" AND m.study_id NOT IN ({exc_sql})"
        params = {**params, **exc_params}
    return sql, params


def fetch_studies(conn: Connection, include: Filter, exclude: Filter | None = None) -> list[dict]:
    where, params = _where(include, exclude)
    sql = f"SELECT {STUDY_COLUMNS} FROM metadata m WHERE {where} ORDER BY m.year DESC, m.study_id"
    return [dict(r) for r in conn.execute(text(sql), params).mappings()]


def fetch_page(
    conn: Connection,
    include: Filter,
    exclude: Filter | None = None,
    *,
    sort: str = "year",
    order: str | None = None,
    limit: int,
    offset: int = 0,
    near: str | None = None,
) -> tuple[int, list[dict]]:
    """
    One page of studies plus the total number of matches.

    `near` names the parameter prefix of a point already bound by a location
    filter (e.g. "a"); each row then gets `distance_mm` to the study's closest focus.
    """
    where, params = _where(include, exclude)
    extra = None
    if near is not None:
        extra = (
            f"(SELECT MIN(ST_3DDistance(c.geom, {_point(near)})) "
            "FROM coordinates c WHERE c.study_id = m.study_id) AS distance_mm"
        )
    return fetch_page_where(conn, where, params, sort=sort, order=order, limit=limit,
                            offset=offset, extra_column=extra)


def fetch_page_where(
    conn: Connection,
    where: str,
    params: dict,
    *,
    sort: str = "year",
    order: str | None = None,
    limit: int,
    offset: int = 0,
    extra_column: str | None = None,
    with_sql: str = "",
) -> tuple[int, list[dict]]:
    """fetch_page() for an arbitrary trusted WHERE predicate over `metadata m` (plus optional WITH)."""
    columns = STUDY_COLUMNS + (f", {extra_column}" if extra_column else "")
    direction = "DESC" if (order or DEFAULT_ORDER[sort]) == "desc" else "ASC"
    order_by = ", ".join(f"{e} {direction}" for e in SORT_EXPRESSIONS[sort])
    if sort != "study_id":
        order_by += ", length(m.study_id), m.study_id"  # stable order across pages

    # The window count is taken before LIMIT, so it's the total over all matches
    sql = (
        f"{with_sql} SELECT {columns}, COUNT(*) OVER () AS total FROM metadata m WHERE {where} "
        f"ORDER BY {order_by} LIMIT :limit OFFSET :offset"
    )
    rows = [dict(r) for r in conn.execute(text(sql), {**params, "limit": limit, "offset": offset}).mappings()]
    if rows:
        total = rows[0]["total"]
        for r in rows:
            del r["total"]
    elif offset:
        # Past the last page: no rows to read the window count from
        total = conn.execute(text(f"{with_sql} SELECT COUNT(*) FROM metadata m WHERE {where}"), params).scalar()
    else:
        total = 0
    return total, rows
