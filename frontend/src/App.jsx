import { useCallback, useEffect, useRef, useState } from 'react'
import { BrainViewer } from './components/BrainViewer'
import { QueryBar } from './components/QueryBar'
import { Splitter, clamp, useLayout } from './components/Splitter'
import { StudiesTable } from './components/StudiesTable'
import { TermsPanel } from './components/TermsPanel'
import { ThemeToggle } from './components/ThemeToggle'
import { EMPTY_FILTERS, api, filterParams, filtersActive, readFiltersFromUrl, writeFiltersToUrl } from './lib/api'
import { appendWith, termToken } from './lib/queryText'

const fmt = (n) => n?.toLocaleString('en-US')
const DEFAULT_R = 6

function readUrl () {
  const sp = new URLSearchParams(window.location.search)
  const r = Number(sp.get('r'))
  return { q: sp.get('q') ?? '', r: Number.isFinite(r) && sp.has('r') ? r : DEFAULT_R }
}

export default function App () {
  const [{ q: query, r: radius }, setCommitted] = useState(readUrl)
  const [draft, setDraft] = useState(query)
  const [filters, setFiltersState] = useState(() => ({ ...EMPTY_FILTERS, ...readFiltersFromUrl(new URLSearchParams(window.location.search)) }))
  const filterKey = JSON.stringify(filterParams(filters))
  const [info, setInfo] = useState(null)
  const [error, setError] = useState(null)
  const [vocab, setVocab] = useState([])
  const [vocabError, setVocabError] = useState(null)
  const [stats, setStats] = useState(null)
  const [waking, setWaking] = useState(false)
  const [map, setMap] = useState(null)
  const [mapLoading, setMapLoading] = useState(false)
  const [mapError, setMapError] = useState(null)
  const [vs, setVsState] = useState(() => new URLSearchParams(window.location.search).get('vs') ?? '')
  const [vsMap, setVsMap] = useState(null)
  const [vsLoading, setVsLoading] = useState(false)
  const [vsError, setVsError] = useState(null)
  const [vsCounts, setVsCounts] = useState(null)
  const [selectedId, setSelectedId] = useState(null)
  const [study, setStudy] = useState(null)
  const [studyError, setStudyError] = useState(null)

  // URL is the source of truth for the committed query (shareable, back/forward work)
  const commit = useCallback((q, r = radius) => {
    const next = { q: q.trim(), r }
    setCommitted(next)
    const url = new URL(window.location.href)
    next.q ? url.searchParams.set('q', next.q) : url.searchParams.delete('q')
    r !== DEFAULT_R ? url.searchParams.set('r', r) : url.searchParams.delete('r')
    if (url.href !== window.location.href) window.history.pushState(null, '', url)
  }, [radius])

  useEffect(() => {
    const onPop = () => {
      const s = readUrl(); setCommitted(s); setDraft(s.q)
      setFiltersState({ ...EMPTY_FILTERS, ...readFiltersFromUrl(new URLSearchParams(window.location.search)) })
      setVsState(new URLSearchParams(window.location.search).get('vs') ?? '')
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  // Study filters (keyword / year / journal) narrow both the list and the brain map
  const setFilters = useCallback((f) => {
    setFiltersState(f)
    const url = new URL(window.location.href)
    writeFiltersToUrl(url.searchParams, f)
    if (url.href !== window.location.href) window.history.replaceState(null, '', url)
  }, [])

  // Compare mode: query B (?vs=) is mapped with the same radius and filters as A
  const setVs = useCallback((v) => {
    const next = (v ?? '').trim()
    setVsState(next)
    const url = new URL(window.location.href)
    next ? url.searchParams.set('vs', next) : url.searchParams.delete('vs')
    if (url.href !== window.location.href) window.history.replaceState(null, '', url)
  }, [])

  useEffect(() => {
    if (!vs || !query) { setVsMap(null); setVsError(null); setVsLoading(false); return }
    const ac = new AbortController()
    setVsLoading(true)
    api.map({ q: vs, r: radius, ...filterParams(filters) }, { signal: ac.signal })
      .then((d) => { setVsMap(d); setVsError(null) })
      .catch((e) => { if (e.name !== 'AbortError') { setVsMap(null); setVsError(e.message) } })
      .finally(() => { if (!ac.signal.aborted) setVsLoading(false) })
    return () => ac.abort()
  }, [vs, query, radius, filterKey]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setVsCounts(null)
    if (!vs || !query) return
    const ac = new AbortController()
    const A = `(${query})`; const B = `(${vs})`
    api.counts({ q: [`${A} AND NOT ${B}`, `${B} AND NOT ${A}`, `${A} AND ${B}`], r: radius, ...filterParams(filters) }, { signal: ac.signal })
      .then((d) => setVsCounts(d.counts.map((c) => c.total)))
      .catch(() => {})
    return () => ac.abort()
  }, [vs, query, radius, filterKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // Vocabulary + stats once. Render's free tier sleeps, so flag a slow first response.
  useEffect(() => {
    const t = setTimeout(() => setWaking(true), 2500)
    api.stats().then(setStats).catch(() => {}).finally(() => { clearTimeout(t); setWaking(false) })
    api.vocabulary().then((d) => setVocab(d.terms)).catch((e) => setVocabError(e.message))
    return () => clearTimeout(t)
  }, [])

  // Density map for the viewer
  useEffect(() => {
    setSelectedId(null)
    if (!query) { setMap(null); setMapError(null); return }
    const ac = new AbortController()
    setMapLoading(true)
    api.map({ q: query, r: radius, ...filterParams(filters) }, { signal: ac.signal })
      .then((d) => { setMap(d); setMapError(null) })
      .catch((e) => { if (e.name !== 'AbortError') { setMap(null); setMapError(e.message) } })
      .finally(() => { if (!ac.signal.aborted) setMapLoading(false) })
    return () => ac.abort()
  }, [query, radius, filterKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // Selected study (detail card + its foci in the viewer)
  useEffect(() => {
    setStudy(null); setStudyError(null)
    if (!selectedId) return
    const ac = new AbortController()
    api.study(selectedId, { signal: ac.signal }).then(setStudy)
      .catch((e) => { if (e.name !== 'AbortError') setStudyError(e.message) })
    return () => ac.abort()
  }, [selectedId])

  // Resizable panels: query bar height, terms / studies / brain widths, panel height
  const { layout, set: setLayout, reset: resetLayout, custom: layoutCustom } = useLayout()
  const queryRef = useRef(null)
  const gridRef = useRef(null)
  const dragStart = useRef({})
  const box = (sel) => gridRef.current?.querySelector(sel)?.getBoundingClientRect() ?? { width: 0, height: 0 }
  const measure = () => {
    dragStart.current = {
      query: queryRef.current?.getBoundingClientRect().height ?? 0,
      terms: box('.terms').width,
      studies: box('.studies').width,
      brain: box('.viewer').width,
      panel: box('.studies').height,
    }
  }
  const gridStyle = {
    '--w-terms': layout.termsW != null ? `${layout.termsW}px` : undefined,
    '--fr-studies': layout.brainFrac != null ? `${1 - layout.brainFrac}fr` : undefined,
    '--fr-brain': layout.brainFrac != null ? `${layout.brainFrac}fr` : undefined,
    '--panel-h': layout.panelH != null ? `${layout.panelH}px` : undefined,
  }

  const onResult = useCallback((d, err) => { setInfo(d); setError(err) }, [])

  // Clicking a term / coordinate appends it to the draft and runs the query
  const addToken = useCallback((token, op) => {
    const next = appendWith(draft, token, op)
    setDraft(next)
    commit(next)
  }, [draft, commit])
  const addTerm = useCallback((term, op) => addToken(termToken(term), op), [addToken])

  return (
    <div className='app'>
      <header className='header'>
        <div>
          <h1>LoTUS-BF</h1>
          <p className='muted small'>Location-or-Term Unified Search for Brain Functions · Neurosynth</p>
        </div>
        <div className='header__stats small muted'>
          {stats
            ? <>{fmt(stats.studies)} studies · {fmt(stats.foci)} foci · {fmt(stats.terms)} terms</>
            : waking ? <span className='badge'>Waking up the server (free tier, ~30 s)…</span> : null}
          {layoutCustom && <button className='btn btn--ghost btn--xs' onClick={resetLayout} title='Restore the default panel sizes'>Reset layout</button>}
          <ThemeToggle />
          <a href='/docs' target='_blank' rel='noreferrer'>API</a>
        </div>
      </header>

      <QueryBar
        boxRef={queryRef}
        height={layout.queryH}
        query={query}
        draft={draft}
        setDraft={setDraft}
        onSubmit={(q) => commit(q)}
        vocab={vocab}
        info={query ? info : null}
        error={query ? error : null}
        loading={false}
        radius={radius}
        setRadius={(r) => commit(query, r)}
      />

      <Splitter
        orientation='horizontal'
        label='Query panel height'
        className='splitter--query'
        onStart={measure}
        onMove={(d) => setLayout({ queryH: Math.round(clamp(dragStart.current.query + d, 72, window.innerHeight * 0.9)) })}
        onReset={() => setLayout({ queryH: null })}
      />

      <main className='grid' ref={gridRef} style={gridStyle}>
        <TermsPanel vocab={vocab} vocabError={vocabError} onAdd={addTerm} query={query} radius={radius} filters={filters} />
        <Splitter
          orientation='vertical'
          label='Terms panel width'
          onStart={measure}
          onMove={(d) => {
            const { terms, studies } = dragStart.current
            setLayout({ termsW: Math.round(clamp(terms + d, 160, Math.min(600, terms + studies - 400))) })
          }}
          onReset={() => setLayout({ termsW: null })}
        />
        <StudiesTable
          query={query}
          radius={radius}
          filters={filters}
          setFilters={setFilters}
          onResult={onResult}
          selectedId={selectedId}
          onSelect={setSelectedId}
          study={study}
          studyError={studyError}
          onAddTerm={addTerm}
        />
        <Splitter
          orientation='vertical'
          label='Studies and brain widths'
          onStart={measure}
          onMove={(d) => {
            const { studies, brain } = dragStart.current
            const both = studies + brain
            const b = clamp(brain - d, Math.max(300, both * 0.2), Math.min(both - 400, both * 0.8))
            setLayout({ brainFrac: Math.round((b / both) * 1000) / 1000 })
          }}
          onReset={() => setLayout({ brainFrac: null })}
        />
        <BrainViewer
          map={map}
          mapLoading={mapLoading}
          mapError={error ? null : mapError}
          filtered={filtersActive(filters)}
          points={info?.points}
          studyFoci={study?.foci}
          onAddPoint={addToken}
          query={query}
          vocab={vocab}
          compare={vs ? { query: vs, map: vsMap, loading: vsLoading, error: vsError, counts: vsCounts } : null}
          onCompare={setVs}
        />
      </main>

      <Splitter
        orientation='horizontal'
        label='Panel height'
        className='splitter--panels'
        onStart={measure}
        onMove={(d) => setLayout({ panelH: Math.round(clamp(dragStart.current.panel + d, 420, 2400)) })}
        onReset={() => setLayout({ panelH: null })}
      />

      <footer className='footer small muted'>
        Data: <a href='https://neurosynth.org' target='_blank' rel='noreferrer'>Neurosynth</a> (abstract TF-IDF terms, reported MNI foci).
        A study matches <code>[x, y, z]</code> if any reported focus lies within the radius.
      </footer>
    </div>
  )
}
