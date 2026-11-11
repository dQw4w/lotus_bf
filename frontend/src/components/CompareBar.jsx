import { useEffect, useMemo, useRef, useState } from 'react'
import { useAnchoredStyle } from '../lib/anchor'
import { currentFragment, rankTerms, replaceRange, termToken } from '../lib/queryText'

const fmt = (n) => n?.toLocaleString('en-US')

// Validated with the dataviz palette checker on the viewer's dark background (#0f1117):
// lightness band, chroma, colour-blind separation and contrast all pass.
export const COMPARE_COLORS = { a: '#CF7A2E', b: '#3A8FD4', both: '#C06AA3' }

/**
 * Compare the current query (A) with another one (B): the brain shows where only A's
 * studies report foci, only B's, or both; the counts are studies.
 */
export function CompareBar ({ queryA, value, onSubmit, onClose, vocab, error, loading, counts }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const submit = (q) => { const t = q.trim(); if (t) onSubmit(t) }

  return (
    <div className='compare'>
      <div className='compare__rows'>
        <div className='compare__row'>
          <span className='compare__tag' style={{ '--c': COMPARE_COLORS.a }}>A</span>
          <code className='compare__a clamp1' title={queryA}>{queryA}</code>
        </div>
        <form className='compare__row' onSubmit={(e) => { e.preventDefault(); submit(draft) }}>
          <span className='compare__tag' style={{ '--c': COMPARE_COLORS.b }}>B</span>
          <QueryInput value={draft} onChange={setDraft} onEnter={submit} vocab={vocab}
            placeholder='Compare with… e.g. pain, or [0, -52, 26]' label='Query B' autoFocus={!value} />
          <button className='btn btn--sm btn--primary' type='submit' disabled={!draft.trim() || loading}>{loading ? '…' : 'Compare'}</button>
          <button className='btn btn--ghost btn--sm' type='button' onClick={onClose} aria-label='Close compare'>✕</button>
        </form>
      </div>
      {error && <div className='compare__error small' role='alert'>Query B: {error}</div>}
      {value && !error && (
        <div className='compare__legend small' aria-live='polite'>
          {[['a', 'A only', counts?.[0]], ['both', 'Both', counts?.[2]], ['b', 'B only', counts?.[1]]].map(([k, label, n]) => (
            <span key={k} className='compare__key'>
              <span className='swatch' style={{ background: COMPARE_COLORS[k] }} /> {label}
              <b className='num'> {n == null ? '…' : fmt(n)}</b><span className='muted'> studies</span>
            </span>
          ))}
          <span className='muted'>Colours: where each map is above the threshold.</span>
        </div>
      )}
    </div>
  )
}

/** Single-line query input with term autocomplete (same behaviour as the main search box). */
function QueryInput ({ value, onChange, onEnter, vocab, placeholder, label, autoFocus }) {
  const ref = useRef(null)
  const [caret, setCaret] = useState(0)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)

  const frag = useMemo(() => currentFragment(value, caret), [value, caret])
  const suggestions = useMemo(() => {
    if (!frag || !vocab.length) return []
    if (frag.quoted) return rankTerms(vocab, frag.text, 8).map((t) => ({ ...t, start: frag.start, end: frag.end }))
    for (const start of frag.wordStarts) {
      const hits = rankTerms(vocab, value.slice(start, caret), 8)
      if (hits.length) return hits.map((t) => ({ ...t, start, end: frag.end }))
    }
    return []
  }, [frag, vocab, value, caret])
  useEffect(() => setActive(0), [suggestions])
  const show = open && suggestions.length > 0
  const listStyle = useAnchoredStyle(ref, show)

  const accept = (s) => {
    const { value: next, caret: pos } = replaceRange(value, s.start, s.end, termToken(s.term))
    onChange(next)
    setOpen(false)
    requestAnimationFrame(() => { ref.current?.focus(); ref.current?.setSelectionRange(pos, pos); setCaret(pos) })
  }

  return (
    <div className='combo'>
      <input ref={ref} className='input input--sm compare__input mono' value={value} placeholder={placeholder} aria-label={label}
        autoFocus={autoFocus} spellCheck={false} autoComplete='off' role='combobox' aria-expanded={show}
        onChange={(e) => { onChange(e.target.value); setCaret(e.target.selectionStart); setOpen(true) }}
        onKeyUp={(e) => setCaret(e.currentTarget.selectionStart)}
        onClick={(e) => { setCaret(e.currentTarget.selectionStart); setOpen(true) }}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (show && e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => (a + 1) % suggestions.length) } else if (show && e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (a - 1 + suggestions.length) % suggestions.length) } else if (show && e.key === 'Tab') { e.preventDefault(); accept(suggestions[active]) } else if (e.key === 'Enter') {
            const s = suggestions[active]
            if (show && s.term !== value.slice(s.start, s.end).replace(/"/g, '').toLowerCase()) { e.preventDefault(); accept(s) } else { e.preventDefault(); setOpen(false); onEnter(value) }
          } else if (e.key === 'Escape') setOpen(false)
        }} />
      {show && (
        <ul className='combo__list' role='listbox' style={listStyle}>
          {suggestions.map((s, i) => (
            <li key={s.term} role='option' aria-selected={i === active} className={i === active ? 'is-active' : ''}
              onMouseDown={(e) => { e.preventDefault(); accept(s) }} onMouseEnter={() => setActive(i)}>
              <span>{s.term}</span><span className='muted num'>{fmt(s.n_studies)} studies</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
