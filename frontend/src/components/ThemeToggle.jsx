import { useEffect, useState } from 'react'

const KEY = 'lotus-bf.theme'
const ORDER = ['auto', 'light', 'dark']
const LABEL = { auto: 'Auto', light: 'Light', dark: 'Dark' }
const ICON = { auto: '◐', light: '☀', dark: '☾' }

const read = () => { try { return ORDER.includes(localStorage.getItem(KEY)) ? localStorage.getItem(KEY) : 'auto' } catch { return 'auto' } }

/** Auto (follow the OS) → Light → Dark. index.html applies the saved choice before first paint. */
export function ThemeToggle () {
  const [theme, setTheme] = useState(read)
  useEffect(() => {
    const root = document.documentElement
    if (theme === 'auto') delete root.dataset.theme
    else root.dataset.theme = theme
    try { localStorage.setItem(KEY, theme) } catch {}
  }, [theme])
  const next = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length]
  return (
    <button className='btn btn--ghost btn--sm theme-toggle' onClick={() => setTheme(next)}
      title={`Theme: ${LABEL[theme]} (click for ${LABEL[next]})`} aria-label={`Theme: ${LABEL[theme]}. Switch to ${LABEL[next]}`}>
      <span aria-hidden>{ICON[theme]}</span> {LABEL[theme]}
    </button>
  )
}
