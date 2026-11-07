"""
Boolean query language for mixed term / coordinate searches.

    posterior cingulate AND NOT [0, -52, 26]
    (fear OR anxiety) amygdala              -- adjacency means AND
    "working memory" OR [-44, 14, 28, 10]   -- 4th number = radius override (mm)

Grammar (NOT binds tighter than AND, which binds tighter than OR):

    expr    := and_expr ( OR and_expr )*
    and_expr:= unary ( [AND] unary )*          -- implicit AND between operands
    unary   := NOT unary | primary
    primary := '(' expr ')' | coord | term

Operators are case-insensitive; `&`, `|` and `!` are accepted as aliases.
Unquoted words are grouped into vocabulary terms by greedy longest match,
so `posterior cingulate emotion` reads as "posterior cingulate" AND emotion.

Unlike the original LoTUS-BF parser (which split the query into a separate
term expression and coordinate expression and always INTERSECTed them),
terms and coordinates live in ONE expression tree here, so
`[x,y,z] OR emotion` really is an OR.

The parser is pure (no DB access): vocabulary lookups go through the
`Vocabulary` protocol so it can be unit-tested with a plain set.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Protocol

MAX_QUERY_LENGTH = 1000
MAX_LEAVES = 40
MAX_DEPTH = 40


class Vocabulary(Protocol):
    max_words: int

    def __contains__(self, term: str) -> bool: ...

    def suggest(self, term: str, n: int = 5) -> list[str]: ...


class QuerySyntaxError(ValueError):
    """Malformed query. `start`/`end` are character offsets into the raw query."""

    def __init__(self, message: str, start: int, end: int | None = None,
                 *, term: str | None = None, suggestions: list[str] | None = None):
        super().__init__(message)
        self.message = message
        self.start = start
        self.end = end if end is not None else start + 1
        self.term = term
        self.suggestions = suggestions or []


# ---------------------------------------------------------------- AST

@dataclass(frozen=True)
class Term:
    name: str


@dataclass(frozen=True)
class Point:
    x: float
    y: float
    z: float
    r: float | None = None  # None = use the request's default radius


@dataclass(frozen=True)
class Not:
    child: "Node"


@dataclass(frozen=True)
class And:
    children: tuple["Node", ...]


@dataclass(frozen=True)
class Or:
    children: tuple["Node", ...]


Node = Term | Point | Not | And | Or


def _num(v: float) -> str:
    return str(int(v)) if float(v).is_integer() else f"{v:g}"


def to_string(node: Node, parent: type | None = None) -> str:
    """Canonical, fully explicit form, e.g. `"posterior cingulate" AND NOT [0, -52, 26]`."""
    if isinstance(node, Term):
        return f'"{node.name}"' if " " in node.name else node.name
    if isinstance(node, Point):
        nums = [node.x, node.y, node.z] + ([node.r] if node.r is not None else [])
        return "[" + ", ".join(_num(v) for v in nums) + "]"
    if isinstance(node, Not):
        inner = to_string(node.child, Not)
        return f"NOT {inner}"
    if isinstance(node, And):
        s = " AND ".join(to_string(c, And) for c in node.children)
        return f"({s})" if parent is Not else s
    if isinstance(node, Or):
        s = " OR ".join(to_string(c, Or) for c in node.children)
        return f"({s})" if parent in (And, Not) else s
    raise TypeError(node)


def to_json(node: Node) -> dict:
    if isinstance(node, Term):
        return {"type": "term", "term": node.name}
    if isinstance(node, Point):
        return {"type": "point", "xyz": [node.x, node.y, node.z], "r": node.r}
    if isinstance(node, Not):
        return {"type": "not", "child": to_json(node.child)}
    kind = "and" if isinstance(node, And) else "or"
    return {"type": kind, "children": [to_json(c) for c in node.children]}


def leaves(node: Node, negated: bool = False):
    """Yield (leaf, negated) pairs; `negated` = under an odd number of NOTs."""
    if isinstance(node, (Term, Point)):
        yield node, negated
    elif isinstance(node, Not):
        yield from leaves(node.child, not negated)
    else:
        for c in node.children:
            yield from leaves(c, negated)


# ---------------------------------------------------------------- lexer

@dataclass
class Token:
    kind: str  # LPAREN RPAREN AND OR NOT COORD QUOTED WORD
    text: str
    start: int
    end: int
    value: object = None


_OPS = {"and": "AND", "&": "AND", "&&": "AND",
        "or": "OR", "|": "OR", "||": "OR",
        "not": "NOT", "!": "NOT"}

_TOKEN_RE = re.compile(
    r"""
      (?P<ws>\s+)
    | (?P<lparen>\()
    | (?P<rparen>\))
    | (?P<coord>\[[^\[\]]*\]?)
    | (?P<quoted>"[^"]*"?|'[^']*'?)
    | (?P<sym>&&|\|\||[&|!])
    | (?P<word>[^\s()\[\]"'&|!]+)
    """,
    re.VERBOSE,
)

_NUM_SPLIT = re.compile(r"[\s,;]+")


def _parse_coord(text: str, start: int) -> Point:
    end = start + len(text)
    if not text.endswith("]"):
        raise QuerySyntaxError("Unclosed '[': coordinates look like [x, y, z]", start, end)
    inner = text[1:-1].strip()
    parts = [p for p in _NUM_SPLIT.split(inner) if p]
    if len(parts) not in (3, 4):
        raise QuerySyntaxError(
            f"Coordinates need 3 numbers [x, y, z] (or 4 with a radius), got {len(parts)}", start, end)
    try:
        nums = [float(p) for p in parts]
    except ValueError:
        raise QuerySyntaxError(f"Coordinates must be numbers: {text}", start, end) from None
    if not all(math.isfinite(v) for v in nums):
        raise QuerySyntaxError(f"Coordinates must be finite numbers: {text}", start, end)
    if len(nums) == 4 and nums[3] < 0:
        raise QuerySyntaxError("Radius must be >= 0", start, end)
    return Point(*nums)


def tokenize(query: str) -> list[Token]:
    tokens: list[Token] = []
    pos = 0
    while pos < len(query):
        m = _TOKEN_RE.match(query, pos)
        if m is None:  # pragma: no cover - the word branch matches anything else
            raise QuerySyntaxError(f"Unexpected character {query[pos]!r}", pos)
        kind, text = m.lastgroup, m.group()
        start, pos = m.start(), m.end()
        if kind == "ws":
            continue
        if kind == "lparen":
            tokens.append(Token("LPAREN", text, start, pos))
        elif kind == "rparen":
            tokens.append(Token("RPAREN", text, start, pos))
        elif kind == "coord":
            tokens.append(Token("COORD", text, start, pos, _parse_coord(text, start)))
        elif kind == "quoted":
            if len(text) < 2 or text[-1] != text[0]:
                raise QuerySyntaxError("Unclosed quote", start, pos)
            inner = " ".join(text[1:-1].split()).lower()
            if not inner:
                raise QuerySyntaxError("Empty quoted term", start, pos)
            tokens.append(Token("QUOTED", text, start, pos, inner))
        elif kind == "sym" or text.lower() in _OPS:
            tokens.append(Token(_OPS[text.lower()], text, start, pos))
        else:
            tokens.append(Token("WORD", text, start, pos, text.lower()))
    return tokens


# ---------------------------------------------------------------- parser

_OPERAND_START = {"LPAREN", "COORD", "QUOTED", "WORD", "NOT"}


@dataclass
class _Parser:
    query: str
    tokens: list[Token]
    vocab: Vocabulary
    i: int = 0
    n_leaves: int = 0
    depth: int = 0
    implicit_and: bool = False

    def peek(self) -> Token | None:
        return self.tokens[self.i] if self.i < len(self.tokens) else None

    def _eof_error(self, what: str) -> QuerySyntaxError:
        n = len(self.query)
        return QuerySyntaxError(f"Query ends early: expected {what}", n, n)

    def parse(self) -> Node:
        if not self.tokens:
            raise QuerySyntaxError("Query is empty", 0, 0)
        node = self.parse_or()
        tok = self.peek()
        if tok is not None:
            if tok.kind == "RPAREN":
                raise QuerySyntaxError("Unmatched ')'", tok.start, tok.end)
            raise QuerySyntaxError(f"Unexpected {tok.text!r}", tok.start, tok.end)  # pragma: no cover
        return node

    def _enter(self, tok: Token):
        self.depth += 1
        if self.depth > MAX_DEPTH:
            raise QuerySyntaxError("Query is nested too deeply", tok.start, tok.end)

    def parse_or(self) -> Node:
        children = [self.parse_and()]
        while (tok := self.peek()) is not None and tok.kind == "OR":
            self.i += 1
            children.append(self.parse_and())
        return _combine(Or, children)

    def parse_and(self) -> Node:
        children = [self.parse_unary()]
        while (tok := self.peek()) is not None:
            if tok.kind == "AND":
                self.i += 1
            elif tok.kind in _OPERAND_START:
                self.implicit_and = True
            else:
                break
            children.append(self.parse_unary())
        return _combine(And, children)

    def parse_unary(self) -> Node:
        tok = self.peek()
        if tok is not None and tok.kind == "NOT":
            self.i += 1
            self._enter(tok)
            child = self.parse_unary()
            self.depth -= 1
            # NOT NOT x == x
            return child.child if isinstance(child, Not) else Not(child)
        return self.parse_primary()

    def parse_primary(self) -> Node:
        tok = self.peek()
        if tok is None:
            raise self._eof_error("a term, [x, y, z] or '('")
        if tok.kind == "LPAREN":
            self.i += 1
            self._enter(tok)
            close = self.peek()
            if close is not None and close.kind == "RPAREN":
                raise QuerySyntaxError("Empty parentheses", tok.start, close.end)
            node = self.parse_or()
            self.depth -= 1
            close = self.peek()
            if close is None or close.kind != "RPAREN":
                raise QuerySyntaxError("Missing ')' for this '('", tok.start, tok.end)
            self.i += 1
            return node
        if tok.kind == "COORD":
            self.i += 1
            return self._leaf(tok.value, tok)
        if tok.kind == "QUOTED":
            self.i += 1
            return self._term(tok.value, tok.start, tok.end)
        if tok.kind == "WORD":
            return self._word_run()
        if tok.kind == "RPAREN":
            raise QuerySyntaxError("Unexpected ')': expected a term, [x, y, z] or '('", tok.start, tok.end)
        raise QuerySyntaxError(
            f"Operator {tok.text.upper()} needs something on its left", tok.start, tok.end)

    def _word_run(self) -> Node:
        """Greedy longest match of consecutive bare words against the vocabulary."""
        run: list[Token] = []
        j = self.i
        while j < len(self.tokens) and self.tokens[j].kind == "WORD" and len(run) < self.vocab.max_words:
            run.append(self.tokens[j])
            j += 1
        for n in range(len(run), 0, -1):
            name = " ".join(t.value for t in run[:n])
            if name in self.vocab:
                self.i += n
                return self._term(name, run[0].start, run[n - 1].end, checked=True)
        # Nothing matched: report the longest phrase (more useful suggestions), fall back to the word
        phrase = " ".join(t.value for t in run)
        sugg = self.vocab.suggest(phrase) or self.vocab.suggest(run[0].value)
        raise QuerySyntaxError(
            f"Unknown term '{run[0].value}'" if len(run) == 1 else
            f"Unknown term '{run[0].value}' (no term starts '{phrase}')",
            run[0].start, run[0].end, term=run[0].value, suggestions=sugg)

    def _term(self, name: str, start: int, end: int, checked: bool = False) -> Node:
        if not checked and name not in self.vocab:
            raise QuerySyntaxError(f"Unknown term '{name}'", start, end,
                                   term=name, suggestions=self.vocab.suggest(name))
        return self._leaf(Term(name), Token("TERM", name, start, end))

    def _leaf(self, node: Node, tok: Token) -> Node:
        self.n_leaves += 1
        if self.n_leaves > MAX_LEAVES:
            raise QuerySyntaxError(f"Too many terms/coordinates (max {MAX_LEAVES})", tok.start, tok.end)
        return node


def _combine(kind: type, children: list[Node]) -> Node:
    """Flatten nested same-kind nodes and drop duplicates (A AND A == A)."""
    out: list[Node] = []
    for c in children:
        out.extend(c.children if isinstance(c, kind) else [c])
    uniq = list(dict.fromkeys(out))
    return uniq[0] if len(uniq) == 1 else kind(tuple(uniq))


@dataclass
class ParsedQuery:
    raw: str
    ast: Node
    implicit_and: bool

    @property
    def canonical(self) -> str:
        return to_string(self.ast)

    @property
    def terms(self) -> list[str]:
        return list(dict.fromkeys(l.name for l, _ in leaves(self.ast) if isinstance(l, Term)))

    @property
    def points(self) -> list[tuple[Point, bool]]:
        return list(dict.fromkeys((l, neg) for l, neg in leaves(self.ast) if isinstance(l, Point)))


def parse(query: str, vocab: Vocabulary) -> ParsedQuery:
    if len(query) > MAX_QUERY_LENGTH:
        raise QuerySyntaxError(f"Query is too long (max {MAX_QUERY_LENGTH} characters)", MAX_QUERY_LENGTH)
    p = _Parser(query, tokenize(query), vocab)
    return ParsedQuery(query, p.parse(), p.implicit_and)


# ---------------------------------------------------------------- SQL

@dataclass
class CompiledQuery:
    ctes: str     # "q0 AS MATERIALIZED (...), q1 AS MATERIALIZED (...)" -- goes after WITH
    where: str    # boolean predicate over m.study_id (alias m = metadata)
    params: dict

    def with_clause(self, *more: str) -> str:
        parts = [self.ctes, *more]
        return "WITH " + ",\n".join(p for p in parts if p)


def compile_sql(node: Node, default_radius: float, srid: int) -> CompiledQuery:
    """
    Compile the AST into SQL.

    Every distinct leaf becomes one MATERIALIZED CTE (its set of study_ids) and the
    tree becomes a boolean predicate of `m.study_id IN (SELECT study_id FROM qN)`.
    Materializing guarantees each leaf -- in particular the PostGIS sphere search --
    runs exactly once; without it the planner sometimes turns a leaf into a
    parameterized semi-join and re-runs the GIST scan for every study.
    """
    params: dict = {}
    names: dict[Node, str] = {}
    ctes: list[str] = []

    def leaf_sql(leaf: Term | Point) -> str:
        key = leaf if isinstance(leaf, Term) else Point(leaf.x, leaf.y, leaf.z,
                                                        leaf.r if leaf.r is not None else default_radius)
        if key not in names:
            k = f"q{len(names)}"
            names[key] = k
            if isinstance(key, Term):
                params[k] = key.name
                body = f"SELECT DISTINCT study_id FROM annotations_terms WHERE term = :{k}"
            else:
                params.update({f"{k}_x": key.x, f"{k}_y": key.y, f"{k}_z": key.z, f"{k}_r": key.r})
                point = f"ST_SetSRID(ST_MakePoint(:{k}_x, :{k}_y, :{k}_z), {int(srid)})"
                body = f"SELECT DISTINCT study_id FROM coordinates WHERE ST_3DDWithin(geom, {point}, :{k}_r)"
            ctes.append(f"{k} AS MATERIALIZED ({body})")
        return f"m.study_id IN (SELECT study_id FROM {names[key]})"

    def walk(n: Node) -> str:
        if isinstance(n, (Term, Point)):
            return leaf_sql(n)
        if isinstance(n, Not):
            return f"NOT ({walk(n.child)})"
        op = " AND " if isinstance(n, And) else " OR "
        return "(" + op.join(walk(c) for c in n.children) + ")"

    where = walk(node)
    return CompiledQuery(",\n".join(ctes), where, params)
