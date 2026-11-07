import { useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import { rankTerms } from '../lib/queryText'

const fmt = (n) => n?.toLocaleString('en-US')
const MAX_ROWS = 300

export function TermsPanel ({ vocab, vocabError, onAdd }) {
  const [search, setSearch] = useState('')
  const [related, setRelated] = useState(null) // {term, rows|null, error}

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

      {related
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
