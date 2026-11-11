"""
API behind the LoTUS-BF frontend (all under /api).

    GET /api/stats                       row counts
    GET /api/terms?q=&limit=             term autocomplete with study counts
    GET /api/terms/{term}/related        co-occurring terms (Jaccard)
    GET /api/query?q=...                 boolean term/coordinate query -> paged studies
    GET /api/query/map?q=...             foci of the matching studies binned on the MNI 2mm grid
    GET /api/query/facets?q=...          year / journal counts of the matches (for filter controls)
    GET /api/query/terms?q=...           terms over-represented in the matches vs. the whole database
    GET /api/query/export?q=&format=     all matches as CSV, BibTeX or RIS
    GET /api/query/count?q=&q=           study counts for several queries (query builder totals)

The three /api/query endpoints share optional study filters: `search` (words in the
title, authors or journal), `year_min`, `year_max` and repeated `journal`.
    GET /api/studies/{study_id}          one study: metadata, foci, top terms
"""

import math
import re
from datetime import date
from enum import Enum
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy import text

from boolean_query import QuerySyntaxError, compile_sql, parse, to_json
from config import MAX_RADIUS_MM, SRID
from db import Connection, connect, get_conn
from errors import NotFoundError, QueryError
import export
from params import DEFAULT_RADIUS, Order, PageRequest, Radius, SortBy, term_page
from queries import DEFAULT_ORDER, STUDY_COLUMNS, fetch_page_where
from vocab import get_vocabulary

router = APIRouter(prefix="/api", tags=["lotus-bf"])

# MNI152 2mm grid (matches the frontend's template): voxel i,j,k -> mm
#   x = -2*i + 90,  y = 2*j - 126,  z = 2*k - 72
GRID_SHAPE = (91, 109, 91)

QueryString = Annotated[str, Query(
    min_length=1, max_length=1000,
    description='Boolean query, e.g. `"posterior cingulate" AND NOT [0, -52, 26]`',
)]


@dataclass
class StudyFilters:
    """Filters applied on top of the boolean query (metadata only, no effect on the parse)."""
    search: str | None = None
    year_min: int | None = None
    year_max: int | None = None
    journals: list[str] = field(default_factory=list)

    @property
    def words(self) -> list[str]:
        # Letters/digits only, so the tsquery we build can't be malformed
        return [w.lower() for w in re.findall(r"[^\W_]+", self.search or "")][:12]

    @property
    def active(self) -> bool:
        return bool(self.words or self.year_min is not None or self.year_max is not None or self.journals)

    def sql(self, skip: str | None = None) -> tuple[str, dict]:
        """
        Predicate over `metadata m` (or "TRUE"). `skip` leaves one dimension out,
        which is what facet counts need ("which years exist given the other filters").
        """
        parts, params = [], {}
        if self.words and skip != "search":
            # Every word must match, as a prefix ("eickh" finds Eickhoff), against the
            # title/authors/journal tsvector. Stop-word-only input reduces to an empty
            # tsquery; numnode() = 0 then disables the filter instead of matching nothing.
            params["f_search"] = " & ".join(f"{w}:*" for w in self.words)
            parts.append("(numnode(to_tsquery('english', :f_search)) = 0 "
                         "OR m.fts @@ to_tsquery('english', :f_search))")
        if self.year_min is not None and skip != "year":
            parts.append("m.year >= :f_year_min")
            params["f_year_min"] = self.year_min
        if self.year_max is not None and skip != "year":
            parts.append("m.year <= :f_year_max")
            params["f_year_max"] = self.year_max
        if self.journals and skip != "journal":
            parts.append("m.journal = ANY(:f_journals)")
            params["f_journals"] = list(self.journals)
        return (" AND ".join(parts) or "TRUE"), params

    def to_json(self) -> dict:
        return {"search": self.search or None, "year_min": self.year_min,
                "year_max": self.year_max, "journals": self.journals}


Year = Annotated[int | None, Query(ge=1900, le=2100)]


def study_filters(
    search: Annotated[str | None, Query(max_length=200,
                                        description="Words in the title, authors or journal (prefix match, all must match)")] = None,
    year_min: Year = None,
    year_max: Year = None,
    journal: Annotated[list[str], Query(description="Journal name; repeat for several (OR)")] = [],  # noqa: B006
) -> StudyFilters:
    if year_min is not None and year_max is not None and year_min > year_max:
        year_min, year_max = year_max, year_min
    return StudyFilters(search, year_min, year_max, [j for j in journal if j])


def _filtered(cq, f: StudyFilters, skip: str | None = None) -> tuple[str, dict]:
    """The query's WHERE combined with the filters, plus the merged params."""
    fsql, fparams = f.sql(skip)
    return f"({cq.where}) AND {fsql}", {**cq.params, **fparams}


def _query_total(conn: Connection, cq) -> int:
    return conn.execute(text(f"{cq.with_clause()} SELECT COUNT(*) FROM metadata m WHERE {cq.where}"),
                        cq.params).scalar()


def _compile(q: str, r: float):
    vocab = get_vocabulary()
    try:
        parsed = parse(q, vocab)
    except QuerySyntaxError as e:
        raise QueryError(e.message, extra={
            "position": [e.start, e.end], "term": e.term, "suggestions": e.suggestions,
        }) from None
    for point, _ in parsed.points:
        if point.r is not None and point.r > MAX_RADIUS_MM:
            raise QueryError(f"Radius {point.r:g} mm is above the maximum of {MAX_RADIUS_MM:g} mm",
                             extra={"position": [0, len(q)], "suggestions": []})
    compiled = compile_sql(parsed.ast, r, SRID)
    interpretation = {
        "query": q,
        "interpreted": parsed.canonical,
        "implicit_and": parsed.implicit_and,
        "ast": to_json(parsed.ast),
        "terms": [{"term": t, "n_studies": vocab.counts[t]} for t in parsed.terms],
        "points": [
            {"xyz": [p.x, p.y, p.z], "r": p.r if p.r is not None else r, "negated": neg}
            for p, neg in parsed.points
        ],
        "radius_mm": r,
    }
    return interpretation, compiled


@lru_cache(maxsize=1)
def _stats() -> dict:
    with connect() as conn:
        studies = conn.execute(text("SELECT COUNT(*) FROM metadata")).scalar()
        foci = conn.execute(text("SELECT COUNT(*) FROM coordinates")).scalar()
    return {"studies": studies, "foci": foci, "terms": len(get_vocabulary())}


@router.get("/stats")
def stats():
    """Row counts (cached per process: the dataset is static)."""
    return _stats()


@router.get("/terms")
def terms(q: str = "", limit: Annotated[int, Query(ge=1, le=5000)] = 15):
    """
    Terms matching `q`: exact match first, then prefix, word-prefix and substring
    matches, each ranked by number of studies. Empty `q` lists the most common terms.
    """
    vocab = get_vocabulary()
    found = vocab.search(q, limit)
    return {"query": q, "count": len(found),
            "terms": [{"term": t, "n_studies": vocab.counts[t]} for t in found]}


@router.get("/terms/{term}/related")
def related_terms(term: str, limit: Annotated[int, Query(ge=1, le=100)] = 20,
                  conn: Connection = Depends(get_conn)):
    """Terms that co-occur with `term`, ranked by Jaccard similarity of their study sets."""
    vocab = get_vocabulary()
    term = " ".join(term.lower().split())
    if term not in vocab:
        raise NotFoundError(f"Unknown term '{term}'", extra={"suggestions": vocab.suggest(term)})
    rows = conn.execute(text("""
        SELECT b.term, COUNT(DISTINCT a.study_id) AS co
        FROM annotations_terms a
        JOIN annotations_terms b ON b.study_id = a.study_id AND b.term <> a.term
        WHERE a.term = :t
        GROUP BY b.term
    """), {"t": term}).all()
    n_a = vocab.counts[term]
    scored = []
    for r in rows:
        n_b = vocab.counts.get(r.term, 0)
        scored.append({"term": r.term, "co_count": r.co, "n_studies": n_b,
                       "jaccard": r.co / (n_a + n_b - r.co) if n_a + n_b - r.co else 0.0})
    scored.sort(key=lambda d: (-d["jaccard"], -d["co_count"], d["term"]))
    return {"term": term, "n_studies": n_a, "related": scored[:limit]}


@router.get("/query")
def query_studies(q: QueryString, r: Radius = DEFAULT_RADIUS,
                  page: PageRequest = Depends(term_page), filters: StudyFilters = Depends(study_filters),
                  conn: Connection = Depends(get_conn)):
    """
    Studies matching a boolean query over terms and MNI coordinates.

    - Operators: `AND`, `OR`, `NOT`, parentheses (also `&`, `|`, `!`); adjacency = AND
    - Terms: bare words are grouped into vocabulary terms (`posterior cingulate`), or quote them
    - Coordinates: `[x, y, z]` uses radius `r`; `[x, y, z, radius]` overrides it per point

    The response echoes how the query was interpreted (`interpreted`, `ast`).
    Bad queries return 400 with `position` (character span) and `suggestions`.

    `total` counts matches after the study filters; `query_total` before them.
    """
    info, cq = _compile(q, r)
    where, params = _filtered(cq, filters)
    total, studies = fetch_page_where(conn, where, params, with_sql=cq.with_clause(),
                                      sort=page.sort, order=page.order,
                                      limit=page.limit, offset=page.offset)
    end = page.offset + len(studies)
    return {
        **info,
        "filters": filters.to_json(),
        "query_total": _query_total(conn, cq) if filters.active else total,
        "total": total,
        "count": len(studies),
        "offset": page.offset,
        "limit": page.limit,
        "next_offset": end if end < total else None,
        "sort": page.sort,
        "order": page.order or DEFAULT_ORDER[page.sort],
        "studies": studies,
    }


@router.get("/query/count")
def query_counts(q: Annotated[list[str], Query(description="Boolean query; repeat for several (max 5)")],
                 r: Radius = DEFAULT_RADIUS, filters: StudyFilters = Depends(study_filters),
                 conn: Connection = Depends(get_conn)):
    """
    Study counts for several queries at once (no rows). The query builder uses it for its
    running totals (rows 1, 1-2 and 1-3); compare mode for A only / B only / both, with
    the study filters applied.
    """
    if not 1 <= len(q) <= 5 or any(not 1 <= len(one) <= 1000 for one in q):
        raise QueryError("Pass 1 to 5 queries of 1 to 1000 characters", extra={"position": None, "suggestions": []})
    out = []
    for one in q:
        _, cq = _compile(one, r)
        if filters.active:
            where, params = _filtered(cq, filters)
            total = conn.execute(text(f"{cq.with_clause()} SELECT COUNT(*) FROM metadata m WHERE {where}"), params).scalar()
        else:
            total = _query_total(conn, cq)
        out.append({"query": one, "total": total})
    return {"counts": out}


GENERIC_SHARE = 0.30  # terms in more than this share of all studies are boilerplate ("magnetic resonance")


class TermRanking(str, Enum):
    specific = "specific"
    common = "common"


@router.get("/query/terms")
def query_terms(q: QueryString, r: Radius = DEFAULT_RADIUS, filters: StudyFilters = Depends(study_filters),
                rank: TermRanking = TermRanking.specific,
                limit: Annotated[int, Query(ge=1, le=100)] = 30,
                conn: Connection = Depends(get_conn)):
    """
    What else the matching studies (after filters) talk about: for each term, the share of
    matches that mention it (`pct`) vs. the share of all studies (`pct_all`), and their ratio
    (`lift`). Terms of the query itself are left out.

    - `rank=specific` (default): terms with lift >= 1.5 and enough support, by n * log2(lift),
      which favours terms that are both frequent here and unusual elsewhere
    - `rank=common`: most frequent terms in the matches, leaving out generic terms that
      appear in more than 30% of all studies ("magnetic resonance", "task", ...)
    """
    info, cq = _compile(q, r)
    where, params = _filtered(cq, filters)
    with_sql = cq.with_clause(f"matched AS MATERIALIZED (SELECT DISTINCT m.study_id FROM metadata m WHERE {where})")
    n_match = conn.execute(text(f"{with_sql} SELECT COUNT(*) FROM matched"), params).scalar()
    rows = conn.execute(text(f"""
        {with_sql} SELECT a.term, COUNT(DISTINCT a.study_id) AS n
        FROM annotations_terms a JOIN matched USING (study_id) GROUP BY a.term
    """), params).all() if n_match else []

    vocab = get_vocabulary()
    n_all = _stats()["studies"]
    own = {t["term"] for t in info["terms"]}
    own_words = [set(t.split()) for t in own]  # "posterior cingulate" also hides "posterior", "cingulate"
    min_n = max(3, math.ceil(0.02 * n_match))
    out = []
    for term, n in rows:
        if term in own or term not in vocab.counts or any(set(term.split()) <= w for w in own_words):
            continue
        pct, pct_all = n / n_match, vocab.counts[term] / n_all
        lift = pct / pct_all
        if rank is TermRanking.specific and (n < min_n or lift < 1.5):
            continue
        if rank is TermRanking.common and pct_all > GENERIC_SHARE:
            continue
        out.append({"term": term, "n": n, "n_all": vocab.counts[term], "pct": pct, "pct_all": pct_all, "lift": lift,
                    "score": n * math.log2(lift) if lift > 0 else 0})
    key = (lambda t: (-t["score"], t["term"])) if rank is TermRanking.specific else (lambda t: (-t["n"], t["term"]))
    out.sort(key=key)
    return {"query": q, "filters": filters.to_json(), "rank": rank.value, "total": n_match,
            "total_all": n_all, "min_support": min_n, "generic_share": GENERIC_SHARE, "terms": out[:limit]}


def _describe_filters(f: StudyFilters) -> str:
    parts = []
    if f.search:
        parts.append(f'keyword "{f.search}"')
    if f.year_min is not None or f.year_max is not None:
        parts.append(f"years {f.year_min or '…'}–{f.year_max or '…'}")
    if f.journals:
        parts.append("journal " + " or ".join(f.journals))
    return ", ".join(parts) or "none"


class ExportFormat(str, Enum):
    csv = "csv"
    bibtex = "bibtex"
    ris = "ris"


MAX_EXPORT = 20000  # more than the whole database


@router.get("/query/export")
def export_studies(q: QueryString, r: Radius = DEFAULT_RADIUS, format: ExportFormat = ExportFormat.csv,
                   sort: SortBy = SortBy.year, order: Order = None,
                   filters: StudyFilters = Depends(study_filters), conn: Connection = Depends(get_conn)):
    """All matching studies (after filters) as a file: `csv`, `bibtex` or `ris` (Zotero, EndNote, Mendeley)."""
    _, cq = _compile(q, r)
    where, params = _filtered(cq, filters)
    total, rows = fetch_page_where(conn, where, params, with_sql=cq.with_clause(), sort=sort.value,
                                   order=order and order.value, limit=MAX_EXPORT, offset=0)
    media, ext = export.FORMATS[format.value]
    header = f"LoTUS-BF export, {date.today().isoformat()}\nQuery: {q}\nFilters: {_describe_filters(filters)}\n{total} studies"
    body = export.render(format.value, rows, header)
    name = f"lotus-bf_{export.filename_slug(q)}_{total}.{ext}"
    return Response(body, media_type=media, headers={
        "Content-Disposition": f'attachment; filename="{name}"',
        "X-Total-Count": str(total),
    })


@router.get("/query/map")
def query_map(q: QueryString, r: Radius = DEFAULT_RADIUS, filters: StudyFilters = Depends(study_filters),
              conn: Connection = Depends(get_conn)):
    """
    Foci of all matching studies, binned on the MNI152 2mm grid (91x109x91).

    `voxels` is a flat list `[i, j, k, n, i, j, k, n, ...]` where `n` is the number of
    distinct matching studies with a focus in that voxel. The frontend smooths it into
    a density map, so no NIfTI is generated server-side. Study filters apply here too,
    so the map always shows the same studies as the list.
    """
    info, cq = _compile(q, r)
    where, params = _filtered(cq, filters)
    nx, ny, nz = GRID_SHAPE
    # Out-of-grid foci are dropped in Python, not SQL: a bounds filter on the computed
    # voxel indices gets pushed into the join, the planner then estimates 1 row and
    # picks a nested loop that runs for minutes on large result sets.
    with_sql = cq.with_clause(
        f"matched AS MATERIALIZED (SELECT m.study_id FROM metadata m WHERE {where})")
    rows = conn.execute(text(f"""
        {with_sql}
        SELECT round((90 - ST_X(c.geom)) / 2)::int AS i,
               round((ST_Y(c.geom) + 126) / 2)::int AS j,
               round((ST_Z(c.geom) + 72) / 2)::int AS k,
               COUNT(DISTINCT c.study_id) AS n,
               COUNT(*) AS n_foci
        FROM coordinates c JOIN matched USING (study_id)
        GROUP BY 1, 2, 3
    """), params).all()
    n_studies = conn.execute(text(f"{with_sql} SELECT COUNT(*) FROM matched"), params).scalar()
    flat: list[int] = []
    n_foci = n_voxels = 0
    for i, j, k, n, nf in rows:
        if 0 <= i < nx and 0 <= j < ny and 0 <= k < nz:
            flat.extend((i, j, k, n))
            n_foci += nf
            n_voxels += 1
    return {
        **info,
        "filters": filters.to_json(),
        "total": n_studies,
        "n_foci": n_foci,
        "n_voxels": n_voxels,
        "shape": list(GRID_SHAPE),
        "affine": [[-2, 0, 0, 90], [0, 2, 0, -126], [0, 0, 2, -72], [0, 0, 0, 1]],
        "voxels": flat,
    }


@router.get("/query/facets")
def query_facets(q: QueryString, r: Radius = DEFAULT_RADIUS, filters: StudyFilters = Depends(study_filters),
                 conn: Connection = Depends(get_conn)):
    """
    Counts for the filter controls. Each facet ignores its own filter but applies the
    others, so `years` shows every year you could still pick given the search and journals.
    """
    info, cq = _compile(q, r)
    with_sql = cq.with_clause()
    where, params = _filtered(cq, filters, skip="year")
    years = conn.execute(text(f"""
        {with_sql} SELECT m.year, COUNT(*) AS n FROM metadata m
        WHERE {where} AND m.year IS NOT NULL GROUP BY m.year ORDER BY m.year
    """), params).all()
    where, params = _filtered(cq, filters, skip="journal")
    journals = conn.execute(text(f"""
        {with_sql} SELECT m.journal, COUNT(*) AS n FROM metadata m
        WHERE {where} AND m.journal IS NOT NULL GROUP BY m.journal ORDER BY n DESC, m.journal
    """), params).all()
    where, params = _filtered(cq, filters)
    total = conn.execute(text(f"{with_sql} SELECT COUNT(*) FROM metadata m WHERE {where}"), params).scalar()
    return {
        "query": q,
        "filters": filters.to_json(),
        "total": total,
        "query_total": _query_total(conn, cq),
        "years": [{"year": y, "n": n} for y, n in years],
        "journals": [{"journal": j, "n": n} for j, n in journals],
    }


@router.get("/studies/{study_id}")
def study(study_id: str, conn: Connection = Depends(get_conn)):
    """One study's metadata, all reported foci, and its highest-weighted terms."""
    meta = conn.execute(text(f"SELECT {STUDY_COLUMNS} FROM metadata m WHERE m.study_id = :id"),
                        {"id": study_id}).mappings().first()
    if meta is None:
        raise NotFoundError(f"No study with id {study_id!r}")
    foci = conn.execute(text(
        "SELECT ST_X(geom) AS x, ST_Y(geom) AS y, ST_Z(geom) AS z FROM coordinates WHERE study_id = :id"
    ), {"id": study_id}).all()
    top = conn.execute(text("""
        SELECT term, MAX(weight) AS weight FROM annotations_terms
        WHERE study_id = :id GROUP BY term ORDER BY weight DESC LIMIT 15
    """), {"id": study_id}).all()
    return {
        **dict(meta),
        "foci": [[f.x, f.y, f.z] for f in foci],
        "top_terms": [{"term": t.term, "weight": t.weight} for t in top],
    }

