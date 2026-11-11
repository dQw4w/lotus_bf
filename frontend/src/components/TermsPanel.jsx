import { useEffect, useMemo, useState } from 'react'
import { api, filterParams } from '../lib/api'
import { rankTerms } from '../lib/queryText'

const fmt = (n) => n?.toLocaleString('en-US')
const MAX_ROWS = 300

export function TermsPanel ({ vocab, vocabError, onAdd, query, radius, filters }) {
  const [search, setSearch] = useState('')
  const [related, setRelated] = useState(null) // {term, rows|null, error}
  const [tabChoice, setTab] = useState(null) // null = automatic: "In results" once there is a query
  const tab = query ? (tabChoice ?? 'results') : 'all'

  const rows = useMemo(() => {
    const s = search.trim()
    return (s ? rankTerms(vocab, s, MAX_ROWS) : vocab.slice(0, MAX_ROWS))
  }, [vocab, search])

  useEffect(() => {
    if (!related || related.rows || related.error) return
    const ac = new AbortController()
    api.related(related.term, { signal: ac.signal })
      .then((d) => setRelated((r) => r && r.term === d.term ? { ...r, rows: d.related } : r))
      .catch((e) => { if (e.name !== 'AbortError') setRelated((r) => r && { ...r, error: e.message }) })
    return () => ac.abort()
  }, [related])

  return (
    <section className='card terms' aria-label='Terms'>
      <div className='card__head'>
        <h2>Terms</h2>
        <span className='muted small'>{vocab.length ? `${fmt(vocab.length)} terms` : ''}</span>
      </div>

      {query && !related && (
        <div className='seg terms__tabs' role='tablist' aria-label='Which terms'>
          <button role='tab' className='seg__btn' aria-selected={tab === 'results'} onClick={() => setTab('results')}>In these results</button>
          <button role='tab' className='seg__btn' aria-selected={tab === 'all'} onClick={() => setTab('all')}>All terms</button>
        </div>
      )}

      {tab === 'results' && !related
        ? <ResultTerms query={query} radius={radius} filters={filters} onAdd={onAdd} onRelated={(term) => setRelated({ term })} />
        : related
        ? (
          <>
            <div className='terms__related-head'>
              <button className='btn btn--ghost btn--sm' onClick={() => setRelated(null)}>← All terms</button>
              <span className='small'>Related to <b>{related.term}</b></span>
            </div>
            {related.error && <div className='alert'>{related.error}</div>}
            {!related.rows && !related.error && <Skeleton />}
            {related.rows && (
              <ul className='terms__list'>
                {related.rows.map((r) => (
                  <TermRow key={r.term} term={r.term} n={r.n_studies} onAdd={onAdd}
                    extra={<span className='muted small num' title={`${fmt(r.co_count)} studies mention both`}>J {r.jaccard.toFixed(2)}</span>}
                    onRelated={() => setRelated({ term: r.term })} />
                ))}
              </ul>
            )}
          </>
          )
        : (
          <>
            <input
              className='input'
              type='search'
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder='Filter terms…'
              aria-label='Filter terms'
            />
            {vocabError && <div className='alert'>Couldn’t load terms: {vocabError}</div>}
            {!vocab.length && !vocabError && <Skeleton />}
            {vocab.length > 0 && rows.length === 0 && <div className='muted small pad'>No terms match “{search}”.</div>}
            <ul className='terms__list'>
              {rows.map((t) => (
                <TermRow key={t.term} term={t.term} n={t.n_studies} onAdd={onAdd}
                  onRelated={() => setRelated({ term: t.term })} />
              ))}
            </ul>
            {rows.length === MAX_ROWS && <div className='muted small pad'>Showing the top {MAX_ROWS}; type to filter.</div>}
          </>
          )}
    </section>
  )
}

/**
 * Terms the matching studies mention unusually often: share of the results vs. share of
 * all studies, so "what else is this literature about" is visible at a glance.
 */
function ResultTerms ({ query, radius, filters, onAdd, onRelated }) {
  const [rank, setRank] = useState('specific')
  const [state, setState] = useState({ data: null, error: null, loading: true })
  const filterKey = JSON.stringify(filterParams(filters))

  useEffect(() => {
    const ac = new AbortController()
    setState((s) => ({ ...s, loading: true, error: null }))
    api.resultTerms({ q: query, r: radius, ...filterParams(filters), rank, limit: 40 }, { signal: ac.signal })
      .then((data) => setState({ data, error: null, loading: false }))
      .catch((e) => { if (e.name !== 'AbortError') setState({ data: null, error: e.message, loading: false }) })
    return () => ac.abort()
  }, [query, radius, filterKey, rank]) // eslint-disable-line react-hooks/exhaustive-deps

  const { data, error, loading } = state
  const terms = data?.terms ?? []
  const scale = Math.max(0.05, ...terms.map((t) => Math.max(t.pct, t.pct_all)))

  return (
    <>
      <div className='rterms__head small'>
        <div className='seg' role='radiogroup' aria-label='Rank terms by'>
          <button role='radio' className='seg__btn' aria-checked={rank === 'specific'} aria-selected={rank === 'specific'} onClick={() => setRank('specific')}
            title='Mentioned much more often here than in all studies'>Distinctive</button>
          <button role='radio' className='seg__btn' aria-checked={rank === 'common'} aria-selected={rank === 'common'} onClick={() => setRank('common')}
            title='Mentioned most often in these results'>Most common</button>
        </div>
        <span className='rterms__legend muted'>
          <span className='rterms__key rterms__key--bar' /> here <span className='rterms__key rterms__key--tick' /> all studies
        </span>
      </div>
      {error && <div className='alert'>{error}</div>}
      {!data && !error && <Skeleton />}
      {data && terms.length === 0 && (
        <div className='muted small pad'>
          {data.total === 0 ? 'No studies to analyse.' : 'No term stands out: these studies use words about as often as all studies do.'}
        </div>
      )}
      {terms.length > 0 && (
        <ul className={`terms__list rterms ${loading ? 'is-loading' : ''}`}>
          {terms.map((t) => (
            <li key={t.term} className='term rterm'>
              <button className='term__name rterm__main' onClick={() => onAdd(t.term, 'AND')}
                title={`${fmt(t.n)} of ${fmt(data.total)} matching studies (${pct(t.pct)}) mention “${t.term}”, vs ${pct(t.pct_all)} of all ${fmt(data.total_all)} studies: ${t.lift.toFixed(1)}× as often. Click to add (AND).`}>
                <span className='rterm__top'>
                  <span className='term__label'>{t.term}</span>
                  <span className='small num rterm__nums'>{pct(t.pct)} <span className='muted'>vs {pct(t.pct_all)}</span></span>
                </span>
                <span className='rterm__track' aria-hidden>
                  <span className='rterm__bar' style={{ width: `${(t.pct / scale) * 100}%` }} />
                  <span className='rterm__tick' style={{ left: `${(t.pct_all / scale) * 100}%` }} />
                </span>
              </button>
              <span className='term__actions'>
                <button className='btn btn--ghost btn--xs mono' title='Add with OR' onClick={() => onAdd(t.term, 'OR')}>OR</button>
                <button className='btn btn--ghost btn--xs mono' title='Exclude (AND NOT)' onClick={() => onAdd(t.term, 'AND NOT')}>NOT</button>
                <button className='btn btn--ghost btn--xs' title='Related terms' aria-label={`Terms related to ${t.term}`} onClick={() => onRelated(t.term)}>≈</button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {data && terms.length > 0 && (
        <div className='muted small'>
          Out of {fmt(data.total)} matching studies{rank === 'specific'
            ? `; terms mentioned by at least ${fmt(data.min_support)} of them and 1.5× more often than overall`
            : `; terms found in over ${Math.round(data.generic_share * 100)}% of all studies (like “magnetic resonance”) are hidden`}. The query’s own terms are left out.
        </div>
      )}
    </>
  )
}

const pct = (v) => `${v >= 0.1 ? Math.round(v * 100) : Math.round(v * 1000) / 10}%`

function TermRow ({ term, n, onAdd, onRelated, extra }) {
  return (
    <li className='term'>
      <button className='term__name' title={`Add “${term}” to the query (AND)`} onClick={() => onAdd(term, 'AND')}>
        <span className='term__label'>{term}</span>
        <span className='muted small num'>{fmt(n)}</span>
      </button>
      {extra}
      <span className='term__actions'>
        <button className='btn btn--ghost btn--xs mono' title='Add with OR' onClick={() => onAdd(term, 'OR')}>OR</button>
        <button className='btn btn--ghost btn--xs mono' title='Exclude (AND NOT)' onClick={() => onAdd(term, 'AND NOT')}>NOT</button>
        <button className='btn btn--ghost btn--xs' title='Related terms' aria-label={`Terms related to ${term}`} onClick={onRelated}>≈</button>
      </span>
    </li>
  )
}

function Skeleton () {
  return <div className='skeleton'>{Array.from({ length: 8 }, (_, i) => <div key={i} />)}</div>
}
