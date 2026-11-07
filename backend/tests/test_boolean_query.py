import pytest

from boolean_query import And, Not, Or, Point, QuerySyntaxError, Term, compile_sql, parse
from vocab import Vocabulary

V = Vocabulary({t: 10 for t in [
    "amygdala", "fear", "emotion", "anxiety", "working", "memory", "working memory",
    "posterior cingulate", "ventromedial prefrontal", "posterior", "pain", "12 healthy",
]})


def p(q):
    return parse(q, V)


def test_precedence_not_and_or():
    # NOT > AND > OR
    assert p("fear OR amygdala AND NOT pain").ast == Or((Term("fear"), And((Term("amygdala"), Not(Term("pain"))))))


def test_implicit_and_and_greedy_multiword():
    q = p("posterior cingulate emotion")
    assert q.ast == And((Term("posterior cingulate"), Term("emotion")))
    assert q.implicit_and
    # longest match wins: "working memory" is one term
    assert p("working memory").ast == Term("working memory")
    # falls back to the single word when the bigram isn't a term
    assert p("posterior fear").ast == And((Term("posterior"), Term("fear")))


def test_mixed_terms_and_points_share_one_tree():
    # The original parser INTERSECTed terms and locations; OR must really be OR
    q = p("[0,-52,26] OR emotion")
    assert q.ast == Or((Point(0, -52, 26), Term("emotion")))
    assert q.canonical == "[0, -52, 26] OR emotion"


def test_parentheses_and_not_group():
    q = p("amygdala NOT (fear OR anxiety)")
    assert q.ast == And((Term("amygdala"), Not(Or((Term("fear"), Term("anxiety"))))))
    assert q.canonical == "amygdala AND NOT (fear OR anxiety)"
    assert p("NOT NOT fear").ast == Term("fear")


def test_coordinate_formats_and_radius():
    assert p("[1 2 3]").ast == Point(1, 2, 3)
    assert p("[1, 2, 3, 10]").ast == Point(1, 2, 3, 10)
    assert p("[-2.5,50,-6]").canonical == "[-2.5, 50, -6]"


def test_case_insensitive_ops_symbols_quotes():
    assert p('fear and "Working  Memory"').ast == And((Term("fear"), Term("working memory")))
    assert p("fear | pain & !emotion").ast == Or((Term("fear"), And((Term("pain"), Not(Term("emotion"))))))


def test_flatten_and_dedupe():
    assert p("fear AND (pain AND fear)").ast == And((Term("fear"), Term("pain")))
    assert p("fear OR fear").ast == Term("fear")


@pytest.mark.parametrize("q,msg,start", [
    ("", "empty", 0),
    ("fear AND", "ends early", 8),
    ("(fear OR pain", "Missing ')'", 0),
    ("fear)", "Unmatched ')'", 4),
    ("AND fear", "needs something", 0),
    ("()", "Empty parentheses", 0),
    ("[1,2]", "3 numbers", 0),
    ("[1,2,x]", "numbers", 0),
    ("[1,2,3", "Unclosed '['", 0),
    ('"fear', "Unclosed quote", 0),
    ("fear amygdalaa", "Unknown term", 5),
])
def test_errors_have_positions(q, msg, start):
    with pytest.raises(QuerySyntaxError) as e:
        p(q)
    assert msg.lower() in e.value.message.lower()
    assert e.value.start == start


def test_unknown_term_suggestions():
    with pytest.raises(QuerySyntaxError) as e:
        p("amygdal")
    assert e.value.suggestions[0] == "amygdala"


def test_compile_sql_dedupes_params():
    cq = compile_sql(p("(fear OR [0,0,0]) AND NOT fear AND [0,0,0,6]").ast, 6.0, 4326)
    assert sorted(cq.params) == ["q0", "q1_r", "q1_x", "q1_y", "q1_z"]  # [0,0,0] == [0,0,0,6] at r=6
    assert cq.ctes.count("MATERIALIZED") == 2
    assert cq.where.count("NOT (") == 1


def test_vocab_search_ranking():
    v = Vocabulary({"memory": 5, "working memory": 50, "memory retrieval": 20, "mnemonic": 1, "12 healthy": 99})
    assert v.search("memory") == ["memory", "memory retrieval", "working memory"]
    assert "12 healthy" not in v.search("")
    assert v.search("12") == ["12 healthy"]
