// Region names for MNI coordinates: Harvard-Oxford cortical (lateralised) + subcortical,
// max-probability 25 %, on the viewer's 2 mm grid. Built by scripts/build_atlas.py.
import { useEffect, useState } from 'react'
import { SHAPE, mmToVoxel } from './density'

const BASE = `${import.meta.env.BASE_URL}atlas/`
let pending = null

async function gunzipIfNeeded (buf) {
  const bytes = new Uint8Array(buf)
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes // server already decoded it
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** Loads once (about 32 KB) and is shared by every caller. */
export function loadAtlas () {
  pending ??= Promise.all([
    fetch(`${BASE}harvard-oxford-2mm.u8.gz`).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`atlas ${r.status}`)))).then(gunzipIfNeeded),
    fetch(`${BASE}harvard-oxford.json`).then((r) => r.json()),
  ]).then(([data, meta]) => ({ data, labels: meta.labels, name: meta.name }))
    .catch((e) => { pending = null; throw e })
  return pending
}

export function useAtlas () {
  const [atlas, setAtlas] = useState(null)
  useEffect(() => {
    let live = true
    loadAtlas().then((a) => live && setAtlas(a)).catch((e) => console.warn('Atlas unavailable:', e.message))
    return () => { live = false }
  }, [])
  return atlas
}

const [NX, NY, NZ] = SHAPE
const at = (a, i, j, k) => (i < 0 || j < 0 || k < 0 || i >= NX || j >= NY || k >= NZ ? 0 : a.data[i + j * NX + k * NX * NY])

/**
 * Region at an MNI coordinate: {name, distance} where distance is 0 inside the region,
 * or the mm to the nearest labelled voxel within `searchMm` (e.g. in white matter).
 * null when nothing is labelled nearby.
 */
export function regionAt (atlas, xyz, searchMm = 6) {
  if (!atlas || !xyz) return null
  const [i, j, k] = mmToVoxel(xyz)
  const here = at(atlas, i, j, k)
  if (here) return { name: atlas.labels[here], distance: 0 }
  const R = Math.ceil(searchMm / 2)
  let best = null
  for (let dk = -R; dk <= R; dk++) {
    for (let dj = -R; dj <= R; dj++) {
      for (let di = -R; di <= R; di++) {
        const d2 = di * di + dj * dj + dk * dk
        if (d2 === 0 || d2 > R * R || (best && d2 >= best.d2)) continue
        const l = at(atlas, i + di, j + dj, k + dk)
        if (l) best = { l, d2 }
      }
    }
  }
  return best ? { name: atlas.labels[best.l], distance: Math.round(Math.sqrt(best.d2) * 2) } : null
}

/** "Right Amygdala" / "near Left Insular Cortex (4 mm)" / "" */
export function regionLabel (r) {
  if (!r) return ''
  return r.distance === 0 ? r.name : `near ${r.name} (${r.distance} mm)`
}
