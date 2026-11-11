// Thin fetch wrapper: JSON in, `ApiError` (with the backend's error body) out.

export class ApiError extends Error {
  constructor (status, body) {
    super(body?.detail || body?.error || `HTTP ${status}`)
    this.status = status
    this.body = body || {}
  }
}

const API = (import.meta.env.VITE_API_BASE || '').replace(/\/$/, '')

/** Absolute-path API URL with query params (arrays become repeated params, e.g. journal=A&journal=B). */
export function apiUrl (path, params = {}) {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach((x) => qs.append(k, x))
    else if (v !== undefined && v !== null && v !== '') qs.set(k, v)
  }
  return `${API}${path}${qs.toString() ? `?${qs}` : ''}`
}

export async function getJSON (path, params = {}, { signal } = {}) {
  const url = apiUrl(path, params)
  const res = await fetch(url, { signal })
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new ApiError(res.status, body)
  return body
}

export const api = {
  stats: (opts) => getJSON('/api/stats', {}, opts),
  vocabulary: (opts) => getJSON('/api/terms', { limit: 5000 }, opts),
  related: (term, opts) => getJSON(`/api/terms/${encodeURIComponent(term)}/related`, { limit: 25 }, opts),
  query: (params, opts) => getJSON('/api/query', params, opts),
  map: (params, opts) => getJSON('/api/query/map', params, opts),
  facets: (params, opts) => getJSON('/api/query/facets', params, opts),
  counts: (params, opts) => getJSON('/api/query/count', params, opts),
  resultTerms: (params, opts) => getJSON('/api/query/terms', params, opts),
  exportUrl: (params) => apiUrl('/api/query/export', params),
  study: (id, opts) => getJSON(`/api/studies/${encodeURIComponent(id)}`, {}, opts),
}

// ------------------------------------------------------------ study filters

export const EMPTY_FILTERS = { search: '', yearMin: null, yearMax: null, journals: [] }

export const filtersActive = (f) =>
  Boolean(f.search.trim() || f.yearMin != null || f.yearMax != null || f.journals.length)

/** Filters -> backend query params. */
export const filterParams = (f) => ({
  search: f.search.trim() || undefined,
  year_min: f.yearMin ?? undefined,
  year_max: f.yearMax ?? undefined,
  journal: f.journals,
})

/** Filters <-> URL (?s=&y0=&y1=&j=&j=) so filtered views are shareable. */
export function readFiltersFromUrl (sp) {
  const year = (k) => (sp.get(k) && Number.isFinite(+sp.get(k)) ? +sp.get(k) : null)
  return { search: sp.get('s') ?? '', yearMin: year('y0'), yearMax: year('y1'), journals: sp.getAll('j') }
}

export function writeFiltersToUrl (sp, f) {
  for (const k of ['s', 'y0', 'y1', 'j']) sp.delete(k)
  if (f.search.trim()) sp.set('s', f.search.trim())
  if (f.yearMin != null) sp.set('y0', f.yearMin)
  if (f.yearMax != null) sp.set('y1', f.yearMax)
  f.journals.forEach((j) => sp.append('j', j))
}
