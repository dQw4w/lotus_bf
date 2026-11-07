// Client-side helpers for editing query text. The backend does the real parsing;
// these only need to know where tokens start and end.

const OPERATOR = /^(and|or|not|&&|\|\||&|\||!)$/i

/** Format a term for insertion: multi-word terms are quoted so grouping is explicit. */
export const termToken = (t) => (/\s/.test(t) ? `"${t}"` : t)

/** Format a coordinate. */
export const pointToken = ([x, y, z], r) =>
  `[${[x, y, z, ...(r != null ? [r] : [])].map((v) => Math.round(v * 10) / 10).join(', ')}]`

/**
 * The term fragment being typed at `caret`, for autocomplete.
 * Returns {start, end, text, quoted, wordStarts?} or null when the caret is inside a coordinate,
 * right after an operator/paren, or on whitespace.
 */
export function currentFragment (value, caret) {
  const before = value.slice(0, caret)
  // Inside an unclosed [ ... ] -> no term completion
  if (before.lastIndexOf('[') > before.lastIndexOf(']')) return null
  // Inside an unclosed quote -> fragment runs from the quote
  const quotes = (before.match(/"/g) || []).length
  if (quotes % 2 === 1) {
    const q = before.lastIndexOf('"')
    const text = before.slice(q + 1)
    const close = value.indexOf('"', caret)
    return { start: q, end: close === -1 ? caret : close + 1, text, quoted: true }
  }
  if (/\s$/.test(before) || before === '') return null
  // Walk back over up to two bare words (vocabulary terms have at most 2 words)
  const words = []
  let i = caret
  while (words.length < 2) {
    const m = /[^\s()[\]"&|!]+$/.exec(value.slice(0, i))
    if (!m || OPERATOR.test(m[0])) break
    words.unshift({ start: m.index, text: m[0] })
    const gap = /\s+$/.exec(value.slice(0, m.index))
    if (!gap) break
    i = gap.index
  }
  if (!words.length) return null
  // Extend to the end of the word under the caret
  const tail = /^[^\s()[\]"&|!]*/.exec(value.slice(caret))[0]
  return {
    start: words[0].start,
    end: caret + tail.length,
    text: value.slice(words[0].start, caret),
    wordStarts: words.map((w) => w.start), // try "posterior cing" first, then "cing"
    quoted: false,
  }
}

/** Replace [start, end) with `insert`, returning the new value and caret. */
export function replaceRange (value, start, end, insert) {
  const after = value.slice(end)
  const space = after.startsWith(' ') || after.startsWith(')') ? '' : ' '
  const next = value.slice(0, start) + insert + space + after
  return { value: next, caret: start + insert.length + (after.startsWith(')') ? 0 : 1) }
}

/**
 * Append `token` to a query joined by `op` ("AND" | "OR" | "AND NOT").
 * No operator is added after "(" or an operator, or when the query is empty.
 */
export function appendWith (query, token, op = 'AND') {
  const q = query.trim()
  if (!q) return op === 'AND NOT' ? `NOT ${token}` : token
  const last = q.split(/\s+/).pop()
  if (q.endsWith('(') || OPERATOR.test(last)) {
    return `${q} ${op === 'AND NOT' && !/^not$/i.test(last) ? 'NOT ' : ''}${token}`
  }
  return `${q} ${op} ${token}`
}

/** Rank vocabulary entries for a fragment: exact, prefix, word-prefix, substring; by study count. */
export function rankTerms (vocab, text, limit = 10) {
  const q = text.toLowerCase().trim().replace(/\s+/g, ' ')
  if (!q) return []
  const tiers = [[], [], [], []]
  for (const t of vocab) { // vocab is pre-sorted by n_studies desc
    const s = t.term
    if (s === q) tiers[0].push(t)
    else if (s.startsWith(q)) tiers[1].push(t)
    else if ((' ' + s).includes(' ' + q)) tiers[2].push(t)
    else if (s.includes(q)) tiers[3].push(t)
  }
  return tiers.flat().slice(0, limit)
}
