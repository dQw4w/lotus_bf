import { useCallback, useEffect, useState } from 'react'
import { BrainViewer } from './components/BrainViewer'
import { QueryBar } from './components/QueryBar'
import { StudiesTable } from './components/StudiesTable'
import { TermsPanel } from './components/TermsPanel'
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
          <a href='/docs' target='_blank' rel='noreferrer'>API</a>
        </div>
      </header>

      <QueryBar
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

      <main className='grid'>
        <TermsPanel vocab={vocab} vocabError={vocabError} onAdd={addTerm} />
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
        <BrainViewer
          map={map}
          mapLoading={mapLoading}
          mapError={error ? null : mapError}
          filtered={filtersActive(filters)}
          points={info?.points}
          studyFoci={study?.foci}
          onAddPoint={addToken}
        />
      </main>

      <footer className='footer small muted'>
        Data: <a href='https://neurosynth.org' target='_blank' rel='noreferrer'>Neurosynth</a> (abstract TF-IDF terms, reported MNI foci).
        A study matches <code>[x, y, z]</code> if any reported focus lies within the radius.
      </footer>
    </div>
  )
}
