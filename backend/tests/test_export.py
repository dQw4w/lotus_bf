import csv
import io

from export import filename_slug, split_authors, to_bibtex, to_csv, to_ris

ROW = {"study_id": "12345", "title": "Fear & 50% {braces}_test", "authors": "Callicott JH, Mattay VS, Consortium Group",
       "journal": "NeuroImage", "year": 2001}


def test_split_authors():
    assert split_authors("Callicott JH, Mattay VS") == [("Callicott", "J. H."), ("Mattay", "V. S.")]
    assert split_authors("Consortium Group") == [("Consortium Group", "")]
    assert split_authors("") == [] and split_authors(None) == []


def test_bibtex_escapes_and_fields():
    bib = to_bibtex([ROW], header="Query: fear")
    assert bib.startswith("% Query: fear")
    assert "@article{Callicott2001_12345," in bib
    assert r"Fear \& 50\% braces\_test" in bib and "{braces}" not in bib
    assert "author = {Callicott, J. H. and Mattay, V. S. and {Consortium Group}}" in bib
    assert "url = {https://pubmed.ncbi.nlm.nih.gov/12345/}" in bib


def test_ris_records():
    lines = to_ris([ROW, ROW]).split("\r\n")
    assert lines[0] == "TY  - JOUR" and lines.count("ER  - ") == 2
    assert "AU  - Callicott, J. H." in lines and "AU  - Consortium Group" in lines
    assert "PY  - 2001" in lines and "AN  - PMID:12345" in lines


def test_csv_roundtrip():
    text = to_csv([ROW])
    assert text.startswith("﻿")
    rows = list(csv.DictReader(io.StringIO(text.lstrip("﻿"))))
    assert rows[0]["pmid"] == "12345" and rows[0]["title"] == ROW["title"]


def test_filename_slug():
    assert filename_slug('amygdala AND (fear OR "anxiety")') == "amygdala-AND-fear-OR-anxiety"
    assert filename_slug("((") == "query"
