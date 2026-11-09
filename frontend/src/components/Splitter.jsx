import { useCallback, useEffect, useRef, useState } from 'react'

// ------------------------------------------------------------ layout state

const KEY = 'lotus-bf.layout'
// null = use the CSS default for that size
export const DEFAULT_LAYOUT = Object.freeze({ termsW: null, brainFrac: null, panelH: null, queryH: null })

function load () {
  try {
    const v = JSON.parse(localStorage.getItem(KEY))
    return v && typeof v === 'object' ? { ...DEFAULT_LAYOUT, ...v } : { ...DEFAULT_LAYOUT }
  } catch { return { ...DEFAULT_LAYOUT } }
}

/** Panel sizes the user dragged, remembered in this browser. */
export function useLayout () {
  const [layout, setLayout] = useState(load)
  useEffect(() => {
    try { localStorage.setItem(KEY, JSON.stringify(layout)) } catch {}
  }, [layout])
  const set = useCallback((patch) => setLayout((l) => ({ ...l, ...patch })), [])
  const reset = useCallback(() => setLayout({ ...DEFAULT_LAYOUT }), [])
  const custom = Object.values(layout).some((v) => v != null)
  return { layout, set, reset, custom }
}

// ------------------------------------------------------------ splitter

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
export { clamp }

/**
 * A drag handle between two panels. `orientation` is the handle's own direction:
 * 'vertical' sits between columns (drag left/right), 'horizontal' between rows.
 * onStart() captures the sizes at drag start; onMove(delta) applies the pointer offset.
 * Arrow keys move it 16 px (64 with Shift); double-click or Enter resets.
 */
export function Splitter ({ orientation, label, onStart, onMove, onReset, className = '' }) {
  const drag = useRef(null)
  const vertical = orientation === 'vertical'

  const end = () => {
    drag.current = null
    document.body.classList.remove('is-resizing', 'is-resizing--col', 'is-resizing--row')
  }
  useEffect(() => end, [])

  return (
    <div
      className={`splitter splitter--${vertical ? 'col' : 'row'} ${className}`}
      role='separator'
      aria-orientation={orientation}
      aria-label={label}
      tabIndex={0}
      title={`${label}: drag to resize, double-click to reset`}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        onStart()
        drag.current = vertical ? e.clientX : e.clientY
        document.body.classList.add('is-resizing', vertical ? 'is-resizing--col' : 'is-resizing--row')
      }}
      onPointerMove={(e) => {
        if (drag.current == null) return
        onMove((vertical ? e.clientX : e.clientY) - drag.current)
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 64 : 16
        const keys = vertical ? { ArrowLeft: -step, ArrowRight: step } : { ArrowUp: -step, ArrowDown: step }
        if (e.key in keys) { e.preventDefault(); onStart(); onMove(keys[e.key]) } else if (e.key === 'Enter') { e.preventDefault(); onReset() }
      }}
    >
      <span className='splitter__grip' aria-hidden />
    </div>
  )
}
