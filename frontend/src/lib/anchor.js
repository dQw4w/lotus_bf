import { useLayoutEffect, useState } from 'react'

/**
 * Fixed-position style that keeps a dropdown under `ref`'s element. Used for the
 * autocomplete lists so they aren't clipped when the query bar is resized and scrolls.
 */
export function useAnchoredStyle (ref, open, minWidth = 260) {
  const [style, setStyle] = useState(undefined)
  useLayoutEffect(() => {
    if (!open) return
    const update = () => {
      const r = ref.current?.getBoundingClientRect()
      if (!r) return
      const width = Math.min(Math.max(r.width, minWidth), 520, window.innerWidth - 16)
      const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8))
      setStyle({ position: 'fixed', top: r.bottom + 4, left, right: 'auto', width, maxWidth: 'none' })
    }
    update()
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    return () => { window.removeEventListener('scroll', update, true); window.removeEventListener('resize', update) }
  }, [open, ref, minWidth])
  return style
}
