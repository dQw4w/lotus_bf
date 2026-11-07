import { useEffect, useState } from 'react'
import { api } from '../lib/api'

const PAGE = 25
const fmt = (n) => n?.toLocaleString('en-US')
const COLS = [
  { key: 'year', label: 'Year' },
  { key: 'title', label: 'Title' },
  { key: 'journal', label: 'Journal' },
]

export function StudiesTable ({ query, radius, onResult, selectedId, onSelect, study, studyError, onAddTerm }) {
  const [sort, setSort] = useState({ key: 'year', order: 'desc' })
  const [offset, setOffset] = useState(0)
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => { setOffset(0) }, [query, radius, sort])

  useEffect(() => {
    if (!query) { setData(null); setError(null); onResult(null, null); return }
    const ac = new AbortController()
    setLoading(true)
    api.query({ q: query, r: radius, sort: sort.key, order: sort.order, limit: PAGE, offset }, { signal: ac.signal })
      .then((d) => { setData(d); setError(null); onResult(d, null) })
      .catch((e) => {
        if (e.name === 'AbortError') return
        const err = { ...e.body, message: e.message, query }
        setData(null); setError(err); onResult(null, err)
      })
      .finally(() => { if (!ac.signal.aborted) setLoading(false) })
    return () => ac.abort()
  }, [query, radius, sort, offset]) // eslint-disable-line react-hooks/exhaustive-deps

  const changeSort = (key) => setSort((s) => (s.key === key
    ? { key, order: s.order === 'asc' ? 'desc' : 'asc' }
    : { key, order: key === 'year' ? 'desc' : 'asc' }))

  const total = data?.total ?? 0
  const page = Math.floor(offset / PAGE) + 1
  const pages = Math.max(1, Math.ceil(total / PAGE))

  return (
    <section className='card studies' aria-label='Studies'>
      <div className='card__head'>
        <h2>Studies</h2>
        {data && <span className='muted small'><b className='num'>{fmt(total)}</b> matching</span>}
      </div>

      {selectedId && <StudyDetail s={study} err={studyError} onClose={() => onSelect(null)} onAddTerm={onAddTerm} />}

      {!query && <Empty />}
      {query && error && !data && <div className='muted small pad'>Fix the query above to see studies.</div>}
      {query && (data || loading) && (
        <div className={`table-wrap ${loading ? 'is-loading' : ''}`}>
          <table className='table'>
            <thead>
              <tr>
                {COLS.map((c) => (
                  <th key={c.key} aria-sort={sort.key === c.key ? (sort.order === 'asc' ? 'ascending' : 'descending') : 'none'}>
                    <button className='th-btn' onClick={() => changeSort(c.key)}>
                      {c.label}<span className='sort-ind'>{sort.key === c.key ? (sort.order === 'asc' ? '▲' : '▼') : ''}</span>
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {!data && Array.from({ length: 8 }, (_, i) => (
                <tr key={i} className='row-skel'><td colSpan={3}><div /></td></tr>
              ))}
              {data?.studies.length === 0 && (
                <tr><td colSpan={3} className='muted pad'>No studies match this query.</td></tr>
              )}
              {data?.studies.map((s) => (
                <tr
                  key={s.study_id}
                  className={s.study_id === selectedId ? 'is-selected' : ''}
                  onClick={() => onSelect(s.study_id === selectedId ? null : s.study_id)}
                  title='Show this study’s foci in the brain viewer'
                >
                  <td className='num'>{s.year ?? ''}</td>
                  <td>
                    <div className='study-title'>{s.title}</div>
                    <div className='muted small clamp1'>{s.authors}</div>
                  </td>
                  <td className='small'>{s.journal}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && total > PAGE && (
        <div className='pager'>
          <span className='small muted'>Page <b>{page}</b> of <b>{fmt(pages)}</b></span>
          <span className='pager__btns'>
            <button className='btn btn--ghost btn--sm' disabled={offset === 0} onClick={() => setOffset(0)} aria-label='First page'>«</button>
            <button className='btn btn--ghost btn--sm' disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Prev</button>
            <button className='btn btn--ghost btn--sm' disabled={data.next_offset == null} onClick={() => setOffset(data.next_offset)}>Next</button>
            <button className='btn btn--ghost btn--sm' disabled={data.next_offset == null} onClick={() => setOffset((pages - 1) * PAGE)} aria-label='Last page'>»</button>
          </span>
        </div>
      )}
    </section>
  )
}

function StudyDetail ({ s, err, onClose, onAddTerm }) {
  return (
    <div className='study-detail'>
      <button className='btn btn--ghost btn--xs study-detail__close' onClick={onClose} aria-label='Close study'>✕</button>
      {err && <div className='alert'>{err}</div>}
      {!s && !err && <div className='skeleton'><div /><div /></div>}
      {s && (
        <>
          <div className='study-detail__title'>{s.title}</div>
          <div className='muted small'>{s.authors}</div>
          <div className='small'>
            {s.journal} · {s.year} ·{' '}
            <a href={`https://pubmed.ncbi.nlm.nih.gov/${s.study_id}/`} target='_blank' rel='noreferrer'>PubMed {s.study_id} ↗</a>
          </div>
          <div className='small'>
            <span className='swatch swatch--focus' /> {s.foci.length} foci shown in the viewer
          </div>
          {s.top_terms.length > 0 && (
            <div className='chips'>
              {s.top_terms.map((t) => (
                <button key={t.term} className='chip' title={`TF-IDF ${t.weight.toFixed(3)} · click to add to query`}
                  onClick={() => onAddTerm(t.term, 'AND')}>{t.term}</button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function Empty () {
  return (
    <div className='empty'>
      <p><b>Search by term, coordinate, or both.</b></p>
      <ul className='small'>
        <li>Combine with <code>AND</code>, <code>OR</code>, <code>NOT</code> and parentheses. Writing two items next to each other means AND.</li>
        <li>Coordinates are MNI mm: <code>[0, -52, 26]</code>. Add a 4th number for a custom radius: <code>[0, -52, 26, 10]</code>.</li>
        <li>Multi-word terms are recognised automatically (<code>posterior cingulate</code>), or quote them.</li>
        <li>Click anywhere on the brain to add that coordinate to the query.</li>
      </ul>
    </div>
  )
}
