from fastapi import APIRouter, Depends

from db import Connection, get_conn
from params import DEFAULT_RADIUS, Radius, parse_coords, parse_term
from queries import fetch_studies, location_filter, term_filter

router = APIRouter(tags=["studies"])


@router.get("/terms/{term}/studies")
def studies_by_term(term: str, conn: Connection = Depends(get_conn)):
    """Studies whose abstract mentions `term`."""
    term = parse_term(term)
    studies = fetch_studies(conn, term_filter(term))
    return {"term": term, "count": len(studies), "studies": studies}


@router.get("/locations/{coords}/studies")
def studies_by_location(coords: str, r: Radius = DEFAULT_RADIUS, conn: Connection = Depends(get_conn)):
    """Studies reporting a coordinate within `r` mm of `x_y_z`."""
    xyz = parse_coords(coords)
    studies = fetch_studies(conn, location_filter(xyz, r))
    return {"location": list(xyz), "radius_mm": r, "count": len(studies), "studies": studies}
