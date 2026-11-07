from fastapi import APIRouter, Depends

from db import Connection, get_conn
from params import DEFAULT_RADIUS, Radius, parse_coords, parse_term
from queries import fetch_studies, location_filter, term_filter

router = APIRouter(prefix="/dissociate", tags=["dissociate"])


@router.get("/terms/{term_a}/{term_b}")
def dissociate_terms(term_a: str, term_b: str, conn: Connection = Depends(get_conn)):
    """Studies that mention `term_a` but not `term_b`."""
    a, b = parse_term(term_a), parse_term(term_b)
    studies = fetch_studies(conn, term_filter(a, "a"), exclude=term_filter(b, "b"))
    return {"term_a": a, "term_b": b, "count": len(studies), "studies": studies}


@router.get("/locations/{coords_a}/{coords_b}")
def dissociate_locations(
    coords_a: str, coords_b: str, r: Radius = DEFAULT_RADIUS, conn: Connection = Depends(get_conn)
):
    """Studies reporting a coordinate near `coords_a` but none near `coords_b`."""
    a, b = parse_coords(coords_a), parse_coords(coords_b)
    studies = fetch_studies(conn, location_filter(a, r, "a"), exclude=location_filter(b, r, "b"))
    return {
        "location_a": list(a),
        "location_b": list(b),
        "radius_mm": r,
        "count": len(studies),
        "studies": studies,
    }


@router.get("/terms/{term_a}/{term_b}/both")
def dissociate_terms_both(term_a: str, term_b: str, conn: Connection = Depends(get_conn)):
    """Both directions in one response: A \\ B and B \\ A."""
    a, b = parse_term(term_a), parse_term(term_b)
    a_set, b_set = term_filter(a, "a"), term_filter(b, "b")
    a_not_b = fetch_studies(conn, a_set, exclude=b_set)
    b_not_a = fetch_studies(conn, b_set, exclude=a_set)
    return {
        "term_a": a,
        "term_b": b,
        "a_not_b": {"count": len(a_not_b), "studies": a_not_b},
        "b_not_a": {"count": len(b_not_a), "studies": b_not_a},
    }


@router.get("/locations/{coords_a}/{coords_b}/both")
def dissociate_locations_both(
    coords_a: str, coords_b: str, r: Radius = DEFAULT_RADIUS, conn: Connection = Depends(get_conn)
):
    """Both directions in one response: near A but not B, and near B but not A."""
    a, b = parse_coords(coords_a), parse_coords(coords_b)
    a_set, b_set = location_filter(a, r, "a"), location_filter(b, r, "b")
    a_not_b = fetch_studies(conn, a_set, exclude=b_set)
    b_not_a = fetch_studies(conn, b_set, exclude=a_set)
    return {
        "location_a": list(a),
        "location_b": list(b),
        "radius_mm": r,
        "a_not_b": {"count": len(a_not_b), "studies": a_not_b},
        "b_not_a": {"count": len(b_not_a), "studies": b_not_a},
    }
