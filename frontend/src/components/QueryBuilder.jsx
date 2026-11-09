import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { itemKey, parseLocation } from '../lib/builder'
import { rankTerms } from '../lib/queryText'

const fmt = (n) => n?.toLocaleString('en-US')

const ROWS = [
  { key: 'all', label: 'All of these', hint: 'must match every one' },
  { key: 'any', label: 'Any of these', hint: 'must match at least one' },
  { key: 'none', label: 'None of these', hint: 'must match none' },
]

/**
 * Three boxes instead of AND / OR / NOT. Each row shows how many studies are left
 * after it and the rows above (`totals`), so you can see what every row does.
 */
export function QueryBuilder ({ spec, onChange, vocab, radius, totals, unsupported, onEditText, onReset }) {
  const counts = useMemo(() => new Map(vocab.map((t) => [t.term, t.n_studies])), [vocab])

  if (unsupported) {
    return (
      <div className='builder__notice' role='status'>
        <span>
          {unsupported === 'error'
            ? 'This query has an error. Fix it in the Text tab, or start a new one here.'
            : 'This query uses grouping the builder can’t show, like (A AND B) OR C.'}
        </span>
        <button type='button' className='btn btn--sm' onClick={onEditText}>Edit as text</button>
        <button type='button' className='btn btn--ghost btn--sm' onClick={onReset}>Start over here</button>
      </div>
    )
  }

  const add = (row, item) => {
    const k = itemKey(item)
    // An item lives in one box: adding it elsewhere moves it
    const next = Object.fromEntries(ROWS.map((r) => [r.key, spec[r.key].filter((x) => itemKey(x) !== k)]))
    next[row] = [...next[row], item]
    onChange(next)
  }
  const remove = (row, k) => onChange({ ...spec, [row]: spec[row].filter((x) => itemKey(x) !== k) })

  return (
    <div className='builder'>
      <div className='builder__lead small muted'>
        A term matches studies whose abstract mentions it; a location (x, y, z) matches studies that report a peak within the radius.
      </div>
      {ROWS.map((row, i) => (
        <div key={row.key} className={`brow brow--${row.key}`}>
          <div className='brow__label'>
            <b>{row.label}</b>
            <span className='muted small'>{row.hint}</span>
          </div>
          <div className='brow__items'>
            {spec[row.key].map((it) => (
              <BuilderChip key={itemKey(it)} item={it} row={row.key} radius={radius} n={counts.get(it.term)}
                onRemove={() => remove(row.key, itemKey(it))} />
            ))}
            <AddInput vocab={vocab} radius={radius} onAdd={(it) => add(row.key, it)}
              label={`Add to “${row.label}”`} autoFocus={i === 0 && !spec.all.length && !spec.any.length && !spec.none.length} />
          </div>
          <div className='brow__total small' title='Studies left after this row and the rows above'>
            {spec[row.key].length > 0 && (totals[i] == null
              ? <span className='muted'>…</span>
              : <><span className='muted'>→</span> <b className='num'>{fmt(totals[i])}</b></>)}
          </div>
        </div>
      ))}
    </div>
  )
}

function BuilderChip ({ item, row, radius, n, onRemove }) {
  const neg = row === 'none'
  const label = item.type === 'term'
    ? item.term
    : <>[{item.xyz.join(', ')}] <small>{item.r ?? radius} mm</small></>
  const title = item.type === 'term'
    ? `${fmt(n)} studies mention “${item.term}”`
    : `Studies with a reported peak within ${item.r ?? radius} mm`
  return (
    <span className={`bchip bchip--${item.type} ${neg ? 'bchip--neg' : ''}`} title={title}>
      <span className='bchip__label'>{label}</span>
      {item.type === 'term' && n != null && <span className='bchip__n num'>{fmt(n)}</span>}
      <button type='button' className='bchip__x' aria-label={`Remove ${item.type === 'term' ? item.term : 'location'}`} onClick={onRemove}>✕</button>
    </span>
  )
}

function AddInput ({ vocab, radius, onAdd, label, autoFocus }) {
  const [text, setText] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const ref = useRef(null)

  const options = useMemo(() => {
    const loc = parseLocation(text)
    if (loc) return [{ item: loc, label: `Location [${loc.xyz.join(', ')}]`, meta: `within ${loc.r ?? radius} mm` }]
    return rankTerms(vocab, text, 8).map((t) => ({ item: { type: 'term', term: t.term }, label: t.term, meta: `${fmt(t.n_studies)} studies` }))
  }, [text, vocab, radius])
  useEffect(() => setActive(0), [options])

  const pick = (o) => { onAdd(o.item); setText(''); setOpen(false); ref.current?.focus() }
  const show = open && text.trim().length > 0
  const id = useId()

  return (
    <div className='combo brow__add'>
      <input
        ref={ref}
        className='input input--sm'
        value={text}
        autoFocus={autoFocus}
        placeholder='+ term, or x, y, z'
        aria-label={label}
        role='combobox'
        aria-expanded={show}
        aria-controls={id}
        aria-activedescendant={show && options.length ? `${id}-${active}` : undefined}
        autoComplete='off'
        spellCheck={false}
        onChange={(e) => { setText(e.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && options.length) { e.preventDefault(); setActive((a) => (a + 1) % options.length) }
          else if (e.key === 'ArrowUp' && options.length) { e.preventDefault(); setActive((a) => (a - 1 + options.length) % options.length) }
          else if ((e.key === 'Enter' || e.key === 'Tab') && show && options.length) { e.preventDefault(); pick(options[active]) }
          else if (e.key === 'Escape') setOpen(false)
          else if (e.key === 'Backspace' && !text) setOpen(false)
        }}
      />
      {show && (
        <ul className='combo__list' id={id} role='listbox'>
          {options.length === 0 && <li className='combo__hint'>No term matches. Locations are typed as x, y, z (optionally a 4th number for the radius).</li>}
          {options.map((o, i) => (
            <li key={o.label} id={`${id}-${i}`} role='option' aria-selected={i === active} className={i === active ? 'is-active' : ''}
              onMouseDown={(e) => { e.preventDefault(); pick(o) }} onMouseEnter={() => setActive(i)}>
              <span>{o.label}</span>
              <span className='muted num'>{o.meta}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
