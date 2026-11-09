// The query builder's model: three boxes (all / any / none) of terms and locations.
// It maps to `all₁ AND all₂ AND (any₁ OR any₂) AND NOT none₁ AND NOT none₂`, and any
// parsed query of that shape maps back. Also: a plain-English reading of any query AST.

import { pointToken, termToken } from './queryText.js'

export const EMPTY_SPEC = Object.freeze({ all: [], any: [], none: [] })

// Builder item: { type: 'term', term } | { type: 'point', xyz: [x, y, z], r: number | null }
const isLeaf = (n) => n.type === 'term' || n.type === 'point'
const toItem = (n) => (n.type === 'term' ? { type: 'term', term: n.term } : { type: 'point', xyz: n.xyz, r: n.r ?? null })

export const itemKey = (it) => (it.type === 'term' ? `t:${it.term}` : `p:${it.xyz.join(',')}:${it.r ?? ''}`)
export const itemToken = (it) => (it.type === 'term' ? termToken(it.term) : pointToken(it.xyz, it.r))
export const specSize = (s) => s.all.length + s.any.length + s.none.length

/** Parsed AST (from the backend) -> builder spec, or null if the builder can't show it. */
export function specFromAst (ast) {
  if (!ast) return { all: [], any: [], none: [] }
  const spec = { all: [], any: [], none: [] }
  if (ast.type === 'or') {
    if (!ast.children.every(isLeaf)) return null
    spec.any = ast.children.map(toItem)
    return spec
  }
  for (const c of ast.type === 'and' ? ast.children : [ast]) {
    if (isLeaf(c)) spec.all.push(toItem(c))
    else if (c.type === 'or') {
      // Only one "any" group, and it may only hold plain terms/locations
      if (spec.any.length || !c.children.every(isLeaf)) return null
      spec.any = c.children.map(toItem)
    } else if (c.type === 'not') {
      const k = c.child
      if (isLeaf(k)) spec.none.push(toItem(k))
      else if (k.type === 'or' && k.children.every(isLeaf)) spec.none.push(...k.children.map(toItem))
      else return null
    } else return null
  }
  return spec
}

/** Builder spec -> query text the backend parses. */
export function specToQuery ({ all, any, none }) {
  const parts = all.map(itemToken)
  if (any.length === 1) parts.push(itemToken(any[0]))
  else if (any.length > 1) {
    const group = any.map(itemToken).join(' OR ')
    parts.push(parts.length || none.length ? `(${group})` : group)
  }
  parts.push(...none.map((it) => `NOT ${itemToken(it)}`))
  return parts.join(' AND ')
}

/** Queries for the running totals: rows 1, 1–2 and 1–3, null where the row is empty. */
export function cumulativeQueries (spec) {
  return [
    spec.all.length ? specToQuery({ ...EMPTY_SPEC, all: spec.all }) : null,
    spec.any.length ? specToQuery({ ...EMPTY_SPEC, all: spec.all, any: spec.any }) : null,
    spec.none.length ? specToQuery(spec) : null,
  ]
}

const COORD = /^\[?\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)(?:\s*[,\s]\s*(\d+(?:\.\d+)?))?\s*\]?$/

/** "22, 0, -20" / "[22 0 -20 8]" -> point item, else null. */
export function parseLocation (text) {
  const m = COORD.exec(text.trim())
  if (!m) return null
  return { type: 'point', xyz: [+m[1], +m[2], +m[3]], r: m[4] != null ? +m[4] : null }
}

// ------------------------------------------------------------ plain English

const quote = (t) => `“${t}”`
const list = (xs, conj) => (xs.length < 2 ? xs[0] ?? '' : `${xs.slice(0, -1).join(', ')} ${conj} ${xs[xs.length - 1]}`)
const excluded = (qs) => (qs.length === 1 ? `don’t mention ${qs[0]}`
  : qs.length === 2 ? `mention neither ${qs[0]} nor ${qs[1]}` : `mention none of ${list(qs, 'or')}`)
const where = (n, R) => `within ${n.r ?? R} mm of [${n.xyz.join(', ')}]`

function leaf (n, negated, R) {
  if (n.type === 'term') return `${negated ? 'don’t mention' : 'mention'} ${quote(n.term)}`
  return `report ${negated ? 'no peak' : 'a peak'} ${where(n, R)}`
}

function phrase (n, R, nested) {
  if (isLeaf(n)) return leaf(n, false, R)
  if (n.type === 'not') {
    const k = n.child
    if (isLeaf(k)) return leaf(k, true, R)
    if (k.type === 'or' && k.children.every((c) => c.type === 'term')) return excluded(k.children.map((c) => quote(c.term)))
    return `don’t match (${phrase(k, R, true)})`
  }
  const allTerms = n.children.every((c) => c.type === 'term')
  if (n.type === 'or') {
    if (allTerms) return `mention ${list(n.children.map((c) => quote(c.term)), 'or')}`
    const parts = n.children.map((c) => phrase(c, R, true))
    return `either ${parts.join(', or ')}`
  }
  // AND: merge plain terms ("mention “a” and “b”") and excluded terms, keep the rest in order
  const pos = n.children.filter((c) => c.type === 'term').map((c) => quote(c.term))
  const neg = n.children.filter((c) => c.type === 'not' && c.child.type === 'term').map((c) => quote(c.child.term))
  const rest = n.children.filter((c) => c.type !== 'term' && !(c.type === 'not' && c.child.type === 'term'))
  const parts = [
    ...(pos.length ? [`mention ${list(pos, 'and')}`] : []),
    ...rest.map((c) => phrase(c, R, true)),
    ...(neg.length ? [excluded(neg)] : []),
  ]
  if (parts.length === 1) return parts[0]
  if (!nested) return parts.join(', and ')
  return parts.length === 2 ? `both ${parts[0]} and ${parts[1]}` : `(${parts.join(', and ')})`
}

/** "Studies that mention “amygdala”, and mention “fear” or “anxiety”, and report no peak …" */
export function describeQuery (ast, radius) {
  if (!ast) return ''
  return `Studies that ${phrase(ast, radius, false)}.`
}
