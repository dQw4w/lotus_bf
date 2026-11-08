import { useEffect, useMemo, useRef, useState } from 'react'
import { EMPTY_FILTERS, api, filterParams, filtersActive } from '../lib/api'

const fmt = (n) => n?.toLocaleString('en-US')

/**
 * Filters for the returned studies: keyword (title/authors/journal), year range and
 * journals. Counts come from /api/query/facets, where each facet ignores its own
 * filter, so the histogram always shows every year you could still pick.
 */
export function StudyFilters ({ query, radius, filters, setFilters }) {
  const [facets, setFacets] = useState(null)
  const [search, setSearch] = useState(filters.search)

  // Debounce typing into the shared filter state
  useEffect(() => { setSearch(filters.search) }, [filters.search])
  useEffect(() => {
    if (search === filters.search) return
    const t = setTimeout(() => setFilters({ ...filters, search }), 300)
    return () => clearTimeout(t)
  }, [search]) // eslint-disable-line react-hooks/exhaustive-deps

  const paramsKey = JSON.stringify(filterParams(filters))
  useEffect(() => {
    if (!query) { setFacets(null); return }
    const ac = new AbortController()
    api.facets({ q: query, r: radius, ...filterParams(filters) }, { signal: ac.signal })
      .then(setFacets).catch(() => {})
    return () => ac.abort()
  }, [query, radius, paramsKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const set = (patch) => setFilters({ ...filters, ...patch })
  const active = filtersActive(filters)

  return (
    <div className='filters' aria-label='Filter studies'>
      <div className='filters__row'>
        <input
          className='input filters__search'
          type='search'
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder='Filter by title, author or journal…'
          aria-label='Filter by title, author or journal'
        />
        <JournalPicker
          options={facets?.journals ?? []}
          selected={filters.journals}
          onChange={(journals) => set({ journals })}
        />
        {active && (
          <button className='btn btn--ghost btn--sm' onClick={() => { setSearch(''); setFilters(EMPTY_FILTERS) }}>
            Clear filters
          </button>
        )}
      </div>

      <YearFilter years={facets?.years ?? []} min={filters.yearMin} max={filters.yearMax}
        onChange={(yearMin, yearMax) => set({ yearMin, yearMax })} />

      {filters.journals.length > 0 && (
        <div className='chips'>
          {filters.journals.map((j) => (
            <button key={j} className='chip chip--accent chip--removable' title={`Remove ${j}`}
              onClick={() => set({ journals: filters.journals.filter((x) => x !== j) })}>
              <span className='clamp1'>{j}</span> <span aria-hidden>✕</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function YearFilter ({ years, min, max, onChange }) {
  const [hover, setHover] = useState(null)
  // Every year in the span, including empty ones, so the axis is continuous
  const series = useMemo(() => {
    if (!years.length) return []
    const byYear = new Map(years.map((y) => [y.year, y.n]))
    const lo = Math.min(years[0].year, min ?? Infinity)
    const hi = Math.max(years[years.length - 1].year, max ?? -Infinity)
    return Array.from({ length: hi - lo + 1 }, (_, i) => ({ year: lo + i, n: byYear.get(lo + i) ?? 0 }))
  }, [years, min, max])
  const peak = Math.max(1, ...series.map((d) => d.n))
  const inRange = (y) => (min == null || y >= min) && (max == null || y <= max)
  const single = min != null && min === max

  const pick = (y) => (single && min === y ? onChange(null, null) : onChange(y, y))

  return (
    <div className='years'>
      <div className='years__controls small'>
        <span className='muted'>Year</span>
        <select className='input input--sm' value={min ?? ''} aria-label='From year'
          onChange={(e) => onChange(e.target.value ? +e.target.value : null, max)}>
          <option value=''>Any</option>
          {series.map((d) => <option key={d.year} value={d.year}>{d.year} ({fmt(d.n)})</option>)}
        </select>
        <span className='muted'>to</span>
        <select className='input input--sm' value={max ?? ''} aria-label='To year'
          onChange={(e) => onChange(min, e.target.value ? +e.target.value : null)}>
          <option value=''>Any</option>
          {series.map((d) => <option key={d.year} value={d.year}>{d.year} ({fmt(d.n)})</option>)}
        </select>
        <span className='years__readout muted' aria-live='polite'>
          {hover ? <><b className='num'>{fmt(hover.n)}</b> studies in {hover.year}</> : 'Click a bar to pick one year'}
        </span>
      </div>
      {series.length > 0 && (
        <div className='hist' role='group' aria-label='Studies per year' onMouseLeave={() => setHover(null)}>
          {series.map((d) => (
            <button
              key={d.year}
              className={`hist__col ${inRange(d.year) ? 'is-in' : ''}`}
              aria-label={`${d.year}: ${d.n} studies`}
              aria-pressed={single && min === d.year}
              title={`${d.year}: ${d.n} studies`}
              onMouseEnter={() => setHover(d)}
              onFocus={() => setHover(d)}
              onBlur={() => setHover(null)}
              onClick={() => pick(d.year)}
            >
              <span className='hist__bar' style={{ height: `${d.n ? Math.max(6, (d.n / peak) * 100) : 0}%` }} />
            </button>
          ))}
        </div>
      )}
      {series.length > 0 && (
        <div className='hist__axis small muted' style={{ maxWidth: series.length * 26 }}><span>{series[0].year}</span><span>{series[series.length - 1].year}</span></div>
      )}
    </div>
  )
}

function JournalPicker ({ options, selected, onChange }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e) => { if (!ref.current?.contains(e.target)) setOpen(false) }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey) }
  }, [open])

  // Keep selected journals listed even if they have no matches right now
  const list = useMemo(() => {
    const known = new Set(options.map((o) => o.journal))
    const all = [...options, ...selected.filter((j) => !known.has(j)).map((journal) => ({ journal, n: 0 }))]
    const s = q.trim().toLowerCase()
    return s ? all.filter((o) => o.journal.toLowerCase().includes(s)) : all
  }, [options, selected, q])

  const toggle = (j) => onChange(selected.includes(j) ? selected.filter((x) => x !== j) : [...selected, j])

  return (
    <div className='picker' ref={ref}>
      <button className={`btn btn--sm ${selected.length ? 'btn--on' : ''}`} aria-expanded={open} aria-haspopup='listbox'
        onClick={() => setOpen((o) => !o)}>
        {selected.length ? `${selected.length} journal${selected.length > 1 ? 's' : ''}` : 'Journal: any'} ▾
      </button>
      {open && (
        <div className='picker__pop'>
          <input className='input input--sm picker__search' autoFocus value={q} onChange={(e) => setQ(e.target.value)}
            placeholder={`Search ${options.length} journals…`} aria-label='Search journals' />
          <ul className='picker__list' role='listbox' aria-multiselectable='true'>
            {list.length === 0 && <li className='muted small pad'>No journals match.</li>}
            {list.map((o) => (
              <li key={o.journal}>
                <label className='picker__opt'>
                  <input type='checkbox' checked={selected.includes(o.journal)} onChange={() => toggle(o.journal)} />
                  <span className='picker__name'>{o.journal}</span>
                  <span className='muted small num'>{fmt(o.n)}</span>
                </label>
              </li>
            ))}
          </ul>
          {selected.length > 0 && (
            <button className='btn btn--ghost btn--xs' onClick={() => onChange([])}>Clear journals</button>
          )}
        </div>
      )}
    </div>
  )
}
