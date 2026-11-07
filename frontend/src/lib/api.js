// Thin fetch wrapper: JSON in, `ApiError` (with the backend's error body) out.

export class ApiError extends Error {
  constructor (status, body) {
    super(body?.detail || body?.error || `HTTP ${status}`)
    this.status = status
    this.body = body || {}
  }
}

const API = (import.meta.env.VITE_API_BASE || '').replace(/\/$/, '')

export async function getJSON (path, params = {}, { signal } = {}) {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') qs.set(k, v)
  const url = `${API}${path}${qs.toString() ? `?${qs}` : ''}`
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
  study: (id, opts) => getJSON(`/api/studies/${encodeURIComponent(id)}`, {}, opts),
}
