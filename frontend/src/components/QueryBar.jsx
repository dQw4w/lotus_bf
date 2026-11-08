import { useEffect, useMemo, useRef, useState } from 'react'
import { currentFragment, rankTerms, replaceRange, termToken } from '../lib/queryText'

const EXAMPLES = [
  ['"posterior cingulate" NOT "ventromedial prefrontal"', 'PCC but not vmPFC'],
  ['amygdala AND (fear OR anxiety)', 'Amygdala & fear/anxiety'],
  ['[0, -52, 26] OR "default mode"', 'Coordinate OR term'],
  ['"working memory" NOT [-44, 14, 28, 10]', 'Exclude a 10 mm sphere'],
  ['reward [10, 12, -8]', 'Implicit AND'],
]

const fmt = (n) => n?.toLocaleString('en-US')

export function QueryBar ({ draft, setDraft, onSubmit, vocab, info, error, loading, radius, setRadius }) {
  const inputRef = useRef(null)
  const [caret, setCaret] = useState(0)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)

  const frag = useMemo(() => currentFragment(draft, caret), [draft, caret])
  const suggestions = useMemo(() => {
    if (!frag || !vocab.length) return []
    // Try the two-word fragment first ("posterior cing"), then just the last word
    if (frag.quoted) return rankTerms(vocab, frag.text).map((t) => ({ ...t, start: frag.start, end: frag.end }))
    for (const start of frag.wordStarts) {
      const hits = rankTerms(vocab, draft.slice(start, caret))
      if (hits.length) return hits.map((t) => ({ ...t, start, end: frag.end }))
    }
    return []
  }, [frag, vocab, draft, caret])

  useEffect(() => setActive(0), [suggestions])

  const syncCaret = () => setCaret(inputRef.current?.selectionStart ?? draft.length)

  const setValueAndCaret = (value, pos) => {
    setDraft(value)
    requestAnimationFrame(() => {
      const el = inputRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(pos, pos)
      setCaret(pos)
    })
  }

  const accept = (s) => {
    const { value, caret: pos } = replaceRange(draft, s.start, s.end, termToken(s.term))
    setValueAndCaret(value, pos)
    setOpen(false)
  }

  const insert = (token) => {
    const el = inputRef.current
    const start = el?.selectionStart ?? draft.length
    const end = el?.selectionEnd ?? draft.length
    const before = draft.slice(0, start)
    const lead = before && !/[\s(]$/.test(before) && token !== ')' ? ' ' : ''
    const text = lead + token + (token === '(' ? '' : ' ')
    setValueAndCaret(draft.slice(0, start) + text + draft.slice(end), start + text.length)
  }

  const showList = open && suggestions.length > 0

  const onKeyDown = (e) => {
    if (showList) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => (a + 1) % suggestions.length); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (a - 1 + suggestions.length) % suggestions.length); return }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.metaKey && !e.ctrlKey)) {
        // Enter accepts only when the fragment isn't already an exact term
        const s = suggestions[active]
        if (e.key === 'Tab' || s.term !== draft.slice(s.start, s.end).replace(/"/g, '').toLowerCase()) {
          e.preventDefault(); accept(s); return
        }
      }
      if (e.key === 'Escape') { setOpen(false); return }
    }
    if (e.key === 'Enter') { e.preventDefault(); setOpen(false); onSubmit(draft) }
  }

  const applySuggestion = (term) => {
    const [s, eIdx] = error.position
    const next = draft.slice(0, s) + termToken(term) + draft.slice(eIdx)
    setDraft(next)
    onSubmit(next)
  }

  return (
    <section className='querybar card' aria-label='Query'>
      <form className='querybar__row' onSubmit={(e) => { e.preventDefault(); setOpen(false); onSubmit(draft) }}>
        <div className='combo'>
          <input
            ref={inputRef}
            className='combo__input'
            value={draft}
            spellCheck={false}
            autoComplete='off'
            role='combobox'
            aria-expanded={showList}
            aria-controls='term-suggestions'
            aria-activedescendant={showList ? `sugg-${active}` : undefined}
            placeholder='Try: amygdala AND (fear OR anxiety) NOT [22, 0, -20]'
            onChange={(e) => { setDraft(e.target.value); setCaret(e.target.selectionStart); setOpen(true) }}
            onKeyDown={onKeyDown}
            onKeyUp={syncCaret}
            onClick={() => { syncCaret(); setOpen(true) }}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 120)}
          />
          {showList && (
            <ul className='combo__list' id='term-suggestions' role='listbox'>
              {suggestions.map((s, i) => (
                <li
                  key={s.term}
                  id={`sugg-${i}`}
                  role='option'
                  aria-selected={i === active}
                  className={i === active ? 'is-active' : ''}
                  onMouseDown={(e) => { e.preventDefault(); accept(s) }}
                  onMouseEnter={() => setActive(i)}
                >
                  <span>{s.term}</span>
                  <span className='muted num'>{fmt(s.n_studies)} studies</span>
                </li>
              ))}
              <li className='combo__hint' aria-hidden>↑↓ to choose · Tab/Enter to insert · Esc to close</li>
            </ul>
          )}
        </div>
        <button className='btn btn--primary' type='submit' disabled={loading}>{loading ? 'Searching…' : 'Search'}</button>
      </form>

      <div className='querybar__tools'>
        <div className='ops' role='group' aria-label='Insert operator'>
          {['AND', 'OR', 'NOT', '(', ')'].map((op) => (
            <button key={op} type='button' className='btn btn--ghost btn--sm mono' onClick={() => insert(op)}>{op}</button>
          ))}
          <button type='button' className='btn btn--ghost btn--sm' onClick={() => { setDraft(''); onSubmit(''); inputRef.current?.focus() }}>Clear</button>
          <label className='radius small' title='Default sphere radius for [x, y, z] (override per point with a 4th number)'>
            Radius
            <select className='input input--sm' value={radius} onChange={(e) => setRadius(+e.target.value)}>
              {[0, 2, 4, 6, 8, 10, 12, 15, 20].map((r) => <option key={r} value={r}>{r} mm</option>)}
            </select>
          </label>
        </div>
        <div className='examples'>
          <span className='muted'>Examples:</span>
          {EXAMPLES.map(([q, label]) => (
            <button key={q} type='button' className='chip' title={q} onClick={() => { setDraft(q); onSubmit(q) }}>{label}</button>
          ))}
        </div>
      </div>

      {error
        ? <QueryError draft={draft} error={error} onPick={applySuggestion} />
        : info && <Interpretation info={info} />}
    </section>
  )
}

function QueryError ({ draft, error, onPick }) {
  const pos = error.position
  const q = error.query ?? draft
  return (
    <div className='qerror' role='alert'>
      <div><b>Can’t run this query:</b> {error.detail || error.message}</div>
      {pos && q && (
        <code className='qerror__echo'>
          {q.slice(0, pos[0])}
          <mark>{q.slice(pos[0], Math.max(pos[1], pos[0] + 1)) || ' '}</mark>
          {q.slice(Math.max(pos[1], pos[0] + 1))}
        </code>
      )}
      {error.suggestions?.length > 0 && (
        <div className='qerror__sugg'>
          Did you mean{' '}
          {error.suggestions.map((s) => (
            <button key={s} type='button' className='chip chip--accent' onClick={() => onPick(s)}>{s}</button>
          ))}
        </div>
      )}
    </div>
  )
}

function Interpretation ({ info }) {
  return (
    <div className='interp'>
      <span className='muted'>Interpreted as</span>
      <span className='interp__expr'><Ast node={info.ast} radius={info.radius_mm} counts={info.terms} /></span>
      <span className='interp__total'><b className='num'>{fmt(info.query_total ?? info.total)}</b> studies</span>
    </div>
  )
}

const PREC = { or: 1, and: 2, not: 3 }

function Ast ({ node, radius, counts, parent = 0 }) {
  if (node.type === 'term') {
    const n = counts.find((t) => t.term === node.term)?.n_studies
    return <span className='tok tok--term' title={n != null ? `${fmt(n)} studies mention “${node.term}”` : undefined}>{node.term}</span>
  }
  if (node.type === 'point') {
    return (
      <span className='tok tok--point' title={`Studies with a focus within ${node.r ?? radius} mm`}>
        [{node.xyz.join(', ')}]<small> r={node.r ?? radius}</small>
      </span>
    )
  }
  if (node.type === 'not') {
    return <><span className='tok tok--op tok--not'>NOT</span> <Ast node={node.child} radius={radius} counts={counts} parent={PREC.not} /></>
  }
  const p = PREC[node.type]
  const body = node.children.flatMap((c, i) => [
    i > 0 && <span key={`op${i}`} className='tok tok--op'> {node.type.toUpperCase()} </span>,
    <Ast key={i} node={c} radius={radius} counts={counts} parent={p} />,
  ])
  return p < parent ? <span className='tok--group'>({body})</span> : <>{body}</>
}
