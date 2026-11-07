"""
In-memory term vocabulary: every term with its number of studies.

The Neurosynth data is static, so the ~3k terms are loaded once per process
(one GROUP BY over annotations_terms) and reused for autocomplete, query
validation and "did you mean" suggestions.
"""

from __future__ import annotations

import difflib
import re
import threading
from dataclasses import dataclass

from loguru import logger
from sqlalchemy import text

from db import connect

# Purely numeric "terms" (001, 12 healthy, ...) are TF-IDF artefacts; keep them queryable
# but don't offer them in suggestions unless the user is typing a number.
_NUMERIC = re.compile(r"^\d")


@dataclass
class Vocabulary:
    counts: dict[str, int]

    def __post_init__(self):
        self.max_words = max((len(t.split()) for t in self.counts), default=1)
        self._ranked = sorted(self.counts, key=lambda t: (-self.counts[t], t))
        self._words = [t for t in self._ranked if not _NUMERIC.match(t)]

    def __contains__(self, term: str) -> bool:
        return term in self.counts

    def __len__(self) -> int:
        return len(self.counts)

    def search(self, q: str, limit: int = 15) -> list[str]:
        """Exact match, then prefix, then word-prefix, then substring; each tier by study count."""
        q = " ".join(q.lower().split())
        if not q:
            return self._words[:limit]
        pool = self._ranked if _NUMERIC.match(q) else self._words
        tiers: list[list[str]] = [[], [], [], []]
        for t in pool:
            if t == q:
                tiers[0].append(t)
            elif t.startswith(q):
                tiers[1].append(t)
            elif f" {q}" in f" {t}":
                tiers[2].append(t)
            elif q in t:
                tiers[3].append(t)
        return [t for tier in tiers for t in tier][:limit]

    def suggest(self, term: str, n: int = 5) -> list[str]:
        """Close spellings first, then terms containing the input."""
        term = " ".join(term.lower().split())
        close = difflib.get_close_matches(term, self._words, n=n, cutoff=0.75)
        extra = [t for t in self.search(term, n * 2) if t not in close]
        return (close + extra)[:n]


_lock = threading.Lock()
_vocab: Vocabulary | None = None


def get_vocabulary() -> Vocabulary:
    global _vocab
    if _vocab is None:
        with _lock:
            if _vocab is None:
                with connect() as conn:
                    rows = conn.execute(text(
                        "SELECT term, COUNT(DISTINCT study_id) AS n FROM annotations_terms GROUP BY term"
                    )).all()
                _vocab = Vocabulary({r.term: int(r.n) for r in rows})
                logger.info("Loaded vocabulary: {} terms", len(_vocab))
    return _vocab
