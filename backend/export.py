"""
Study lists as CSV, BibTeX or RIS (for Excel, LaTeX, Zotero / EndNote / Mendeley).

Rows are dicts with study_id (a PMID), title, authors, journal, year. Authors come as
"Callicott JH, Mattay VS, ..." (last name + initials, comma-separated).
"""

from __future__ import annotations

import csv
import io
import re
import unicodedata

PUBMED = "https://pubmed.ncbi.nlm.nih.gov/{}/"

FORMATS = {
    # format: (media type, file extension)
    "csv": ("text/csv; charset=utf-8", "csv"),
    "bibtex": ("application/x-bibtex; charset=utf-8", "bib"),
    "ris": ("application/x-research-info-systems; charset=utf-8", "ris"),
}

_INITIALS = re.compile(r"^[A-Z][A-Z\-]{0,5}$")


def split_authors(authors: str | None) -> list[tuple[str, str]]:
    """'Callicott JH, Mattay VS' -> [('Callicott', 'J. H.'), ('Mattay', 'V. S.')]."""
    out = []
    for name in (authors or "").split(","):
        name = name.strip()
        if not name:
            continue
        last, _, ini = name.rpartition(" ")
        if last and _INITIALS.match(ini):
            out.append((last, " ".join(f"{c}." for c in ini.replace("-", ""))))
        else:
            out.append((name, ""))  # collective author or unusual format: keep as is
    return out


def to_csv(rows: list[dict]) -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["pmid", "year", "title", "authors", "journal", "pubmed_url"])
    for r in rows:
        w.writerow([r["study_id"], r["year"] or "", r["title"] or "", r["authors"] or "",
                    r["journal"] or "", PUBMED.format(r["study_id"])])
    return "﻿" + buf.getvalue()  # BOM so Excel reads UTF-8


def _bib_escape(s: str) -> str:
    s = (s or "").replace("\\", "").replace("{", "").replace("}", "")
    return re.sub(r"([&%$#_])", r"\\\1", s)


def _ascii_slug(s: str) -> str:
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    return re.sub(r"[^A-Za-z]", "", s) or "study"


def to_bibtex(rows: list[dict], header: str = "") -> str:
    out = [f"% {line}" for line in header.splitlines()] + ([""] if header else [])
    for r in rows:
        authors = split_authors(r["authors"])
        key = f"{_ascii_slug(authors[0][0]) if authors else 'study'}{r['year'] or ''}_{r['study_id']}"
        # Escape first, then brace collective names so BibTeX keeps them whole
        names = " and ".join(_bib_escape(f"{last}, {ini}") if ini else f"{{{_bib_escape(last)}}}" for last, ini in authors)
        fields = [
            ("title", f"{{{_bib_escape(r['title'])}}}"),  # double braces keep capitalisation
            ("author", names),
            ("journal", _bib_escape(r["journal"])),
            ("year", str(r["year"] or "")),
            ("pmid", str(r["study_id"])),
            ("url", PUBMED.format(r["study_id"])),
        ]
        body = ",\n".join(f"  {k} = {{{v}}}" for k, v in fields if v)
        out.append(f"@article{{{key},\n{body}\n}}\n")
    return "\n".join(out)


def to_ris(rows: list[dict]) -> str:
    lines: list[str] = []
    for r in rows:
        lines.append("TY  - JOUR")
        lines.append(f"TI  - {r['title'] or ''}")
        for last, ini in split_authors(r["authors"]):
            lines.append(f"AU  - {last}, {ini}" if ini else f"AU  - {last}")
        if r["journal"]:
            lines.append(f"JO  - {r['journal']}")
            lines.append(f"T2  - {r['journal']}")
        if r["year"]:
            lines.append(f"PY  - {r['year']}")
        lines.append(f"AN  - PMID:{r['study_id']}")
        lines.append(f"UR  - {PUBMED.format(r['study_id'])}")
        lines.append("ER  - ")
        lines.append("")
    return "\r\n".join(lines)  # RIS uses CRLF


def render(fmt: str, rows: list[dict], header: str = "") -> str:
    if fmt == "csv":
        return to_csv(rows)
    if fmt == "bibtex":
        return to_bibtex(rows, header)
    return to_ris(rows)


def filename_slug(query: str, limit: int = 60) -> str:
    s = unicodedata.normalize("NFKD", query).encode("ascii", "ignore").decode()
    return re.sub(r"[^A-Za-z0-9]+", "-", s).strip("-")[:limit].strip("-") or "query"
