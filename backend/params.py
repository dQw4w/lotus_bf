"""Path/query parameter parsing shared by the routers."""

import math
from dataclasses import dataclass
from enum import Enum
from typing import Annotated

from fastapi import Query

from config import DEFAULT_PAGE_SIZE, DEFAULT_RADIUS_MM, MAX_PAGE_SIZE, MAX_RADIUS_MM
from errors import InvalidParameterError

Radius = Annotated[
    float,
    Query(ge=0, le=MAX_RADIUS_MM, description="Sphere radius in mm; 0 = exact match"),
]
DEFAULT_RADIUS = DEFAULT_RADIUS_MM

# Query-parameter style (routers/query.py): FastAPI validates and documents these itself
TermQuery = Annotated[str, Query(min_length=1, description="Term, e.g. posterior cingulate")]
Coord = Annotated[float, Query(allow_inf_nan=False, description="MNI coordinate (mm)")]


class SortBy(str, Enum):
    year = "year"
    title = "title"
    journal = "journal"
    study_id = "study_id"


class LocationSortBy(str, Enum):
    year = "year"
    title = "title"
    journal = "journal"
    study_id = "study_id"
    distance = "distance"


class SortOrder(str, Enum):
    asc = "asc"
    desc = "desc"


@dataclass
class PageRequest:
    sort: str
    order: str | None
    limit: int
    offset: int


Limit = Annotated[int, Query(ge=1, le=MAX_PAGE_SIZE, description="Page size")]
Offset = Annotated[int, Query(ge=0, description="Number of results to skip")]
Order = Annotated[
    SortOrder | None,
    Query(description="Default: desc for year, asc for everything else"),
]


def term_page(sort: SortBy = SortBy.year, order: Order = None,
              limit: Limit = DEFAULT_PAGE_SIZE, offset: Offset = 0) -> PageRequest:
    return PageRequest(sort.value, order and order.value, limit, offset)


def location_page(
    sort: Annotated[LocationSortBy, Query(description="`distance` = closest reported focus to the (first) point")]
    = LocationSortBy.year,
    order: Order = None, limit: Limit = DEFAULT_PAGE_SIZE, offset: Offset = 0,
) -> PageRequest:
    return PageRequest(sort.value, order and order.value, limit, offset)


def normalize_term(raw: str) -> str:
    # Terms are stored lowercase with single spaces
    term = " ".join(raw.split()).lower()
    if not term:
        raise InvalidParameterError("Term must not be empty")
    return term


def parse_term(raw: str) -> str:
    # Path segments can't comfortably carry spaces, so accept underscores for them
    return normalize_term(raw.replace("_", " "))


def parse_coords(raw: str) -> tuple[float, float, float]:
    parts = raw.split("_")
    try:
        if len(parts) != 3:
            raise ValueError
        x, y, z = (float(p) for p in parts)
        if not all(math.isfinite(v) for v in (x, y, z)):
            raise ValueError
    except ValueError:
        raise InvalidParameterError(f"Invalid coordinates {raw!r}; expected x_y_z, e.g. 0_-52_26")
    return x, y, z
