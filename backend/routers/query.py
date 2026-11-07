"""
Query-parameter mirrors of the four assignment endpoints.

Same matching logic, but every input is its own typed query parameter
(?term=..., ?x=..&y=..&z=..) instead of being packed into the path
(`posterior_cingulate`, `0_-52_26`). FastAPI validates them and lists each one in /docs.

They're also paginated for frontends: ?sort=&order=&limit=&offset=, and the
response carries `total` (all matches) next to `count` (rows in this page).
"""

from fastapi import APIRouter, Depends

from db import Connection, get_conn
from params import (
    DEFAULT_RADIUS, Coord, PageRequest, Radius, TermQuery, location_page, normalize_term, term_page,
)
from queries import DEFAULT_ORDER, Filter, fetch_page, location_filter, term_filter

router = APIRouter(tags=["query-parameter mirrors"])


def _paged(conn: Connection, header: dict, page: PageRequest, include: Filter,
           exclude: Filter | None = None, near: str | None = None) -> dict:
    total, studies = fetch_page(conn, include, exclude, sort=page.sort, order=page.order,
                                limit=page.limit, offset=page.offset, near=near)
    end = page.offset + len(studies)
    return {
        **header,
        "total": total,
        "count": len(studies),
        "offset": page.offset,
        "limit": page.limit,
        "next_offset": end if end < total else None,
        "sort": page.sort,
        "order": page.order or DEFAULT_ORDER[page.sort],
        "studies": studies,
    }


@router.get("/studies/by-term")
def studies_by_term_q(term: TermQuery, page: PageRequest = Depends(term_page),
                      conn: Connection = Depends(get_conn)):
    """Mirror of `/terms/{term}/studies`."""
    term = normalize_term(term)
    return _paged(conn, {"term": term}, page, term_filter(term))


@router.get("/studies/by-location")
def studies_by_location_q(x: Coord, y: Coord, z: Coord, r: Radius = DEFAULT_RADIUS,
                          page: PageRequest = Depends(location_page), conn: Connection = Depends(get_conn)):
    """Mirror of `/locations/{x_y_z}/studies`. Each study includes `distance_mm` to its closest focus."""
    xyz = (x, y, z)
    return _paged(conn, {"location": list(xyz), "radius_mm": r}, page, location_filter(xyz, r, "a"), near="a")


@router.get("/dissociate/terms")
def dissociate_terms_q(term_a: TermQuery, term_b: TermQuery, page: PageRequest = Depends(term_page),
                       conn: Connection = Depends(get_conn)):
    """Mirror of `/dissociate/terms/{term_a}/{term_b}`: mentions `term_a` but not `term_b`."""
    a, b = normalize_term(term_a), normalize_term(term_b)
    return _paged(conn, {"term_a": a, "term_b": b}, page, term_filter(a, "a"), exclude=term_filter(b, "b"))


@router.get("/dissociate/locations")
def dissociate_locations_q(x1: Coord, y1: Coord, z1: Coord, x2: Coord, y2: Coord, z2: Coord,
                           r: Radius = DEFAULT_RADIUS, page: PageRequest = Depends(location_page),
                           conn: Connection = Depends(get_conn)):
    """
    Mirror of `/dissociate/locations/{x1_y1_z1}/{x2_y2_z2}`: near point 1 but not point 2.
    Each study includes `distance_mm` to its closest focus from point 1.
    """
    a, b = (x1, y1, z1), (x2, y2, z2)
    return _paged(conn, {"location_a": list(a), "location_b": list(b), "radius_mm": r}, page,
                  location_filter(a, r, "a"), exclude=location_filter(b, r, "b"), near="a")
