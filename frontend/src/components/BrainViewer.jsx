import { useEffect, useMemo, useRef, useState } from 'react'
import { Niivue, NVImage, SHOW_RENDER, SLICE_TYPE } from '@niivue/niivue'
import { buildDensity, toNifti } from '../lib/density'
import { pointToken } from '../lib/queryText'

const TEMPLATE_URL = `${import.meta.env.BASE_URL}mni_2mm.nii.gz`

const VIEWS = [
  { id: 'render', label: '3D', type: SLICE_TYPE.RENDER },
  { id: 'multi', label: '3D + slices', type: SLICE_TYPE.MULTIPLANAR },
  { id: 'axial', label: 'Axial', type: SLICE_TYPE.AXIAL },
  { id: 'coronal', label: 'Coronal', type: SLICE_TYPE.CORONAL },
  { id: 'sagittal', label: 'Sagittal', type: SLICE_TYPE.SAGITTAL },
]

const COLORMAPS = ['warm', 'hot', 'plasma', 'viridis', 'winter']
const fmt = (n) => n?.toLocaleString('en-US')
const round1 = (v) => Math.round(v * 10) / 10

/**
 * 3D brain viewer (Niivue / WebGL2): MNI152 template + a density map of the
 * matching studies' foci, with query coordinates and the selected study's foci
 * drawn as spheres.
 */
export function BrainViewer ({ map, mapLoading, mapError, filtered, points, studyFoci, onAddPoint }) {
  const canvasRef = useRef(null)
  const nvRef = useRef(null)
  const overlayRef = useRef(null)
  const meshesRef = useRef({})
  const [ready, setReady] = useState(false)
  const [initError, setInitError] = useState(null)

  const [view, setView] = useState('render')
  const [fwhm, setFwhm] = useState(8)
  const [threshold, setThreshold] = useState(25) // % of the map's peak
  const [opacity, setOpacity] = useState(0.9)
  const [colormap, setColormap] = useState('warm')
  const [glass, setGlass] = useState(true)
  const [cut, setCut] = useState(0) // 0 = no clip plane, otherwise depth 0..1
  const [loc, setLoc] = useState(null) // {mm:[x,y,z], value}

  // ---------------------------------------------------------------- init
  useEffect(() => {
    let disposed = false
    const nv = new Niivue({
      backColor: [0.06, 0.07, 0.09, 1],
      show3Dcrosshair: true,
      crosshairColor: [0.35, 0.75, 1, 0.9],
      crosshairWidth: 1,
      isColorbar: true,
      multiplanarShowRender: SHOW_RENDER.ALWAYS,
      isOrientCube: true,
      dragAndDropEnabled: false,
      loadingText: 'Loading MNI152 template…',
      fontColor: [0.85, 0.87, 0.9, 1],
      isClipPlanesCutaway: false,
      clipPlaneColor: [0, 0, 0, 0], // cut without tinting the cut face
      meshXRay: 0.7, // keep query/focus spheres visible through the brain
      meshThicknessOn2D: 4, // on 2D slices, only draw spheres within 4 mm of the slice
    })
    nvRef.current = nv
    nv.onLocationChange = (l) => {
      const mm = Array.from(l.mm ?? []).slice(0, 3)
      const value = l.values?.[1]?.value
      setLoc({ mm, value })
    }
    ;(async () => {
      try {
        await nv.attachToCanvas(canvasRef.current)
        await nv.loadVolumes([{ url: TEMPLATE_URL, colormap: 'gray', colorbarVisible: false }])
        if (disposed) return
        nv.setSliceType(SLICE_TYPE.RENDER)
        nv.setRenderAzimuthElevation(120, 15)
        setReady(true)
      } catch (e) {
        console.error(e)
        if (!disposed) setInitError(String(e?.message || e))
      }
    })()
    return () => {
      disposed = true
      try { nv.gl?.getExtension('WEBGL_lose_context')?.loseContext() } catch { /* ignore */ }
    }
  }, [])

  // ---------------------------------------------------------------- density overlay
  const density = useMemo(() => {
    if (!map || !map.voxels?.length) return null
    return buildDensity(map.voxels, map.total, fwhm)
  }, [map, fwhm])

  useEffect(() => {
    const nv = nvRef.current
    if (!ready || !nv) return
    let cancelled = false
    ;(async () => {
      if (overlayRef.current) {
        nv.removeVolume(overlayRef.current)
        overlayRef.current = null
      }
      if (!density || density.max <= 0) { nv.updateGLVolume(); return }
      const img = await NVImage.loadFromUrl({
        url: 'density.nii', // only used for the file type; `buffer` supplies the data
        buffer: toNifti(density.data),
        name: 'density.nii',
        colormap,
        opacity,
        cal_min: (threshold / 100) * density.max,
        cal_max: density.max,
        trustCalMinMax: true,
      })
      if (cancelled) return
      nv.addVolume(img)
      overlayRef.current = img
    })().catch((e) => console.error('overlay failed', e))
    return () => { cancelled = true }
  }, [ready, density]) // eslint-disable-line react-hooks/exhaustive-deps

  // cheap property updates: no rebuild
  useEffect(() => {
    const nv = nvRef.current; const ov = overlayRef.current
    if (!ready || !nv || !ov || !density) return
    ov.cal_min = (threshold / 100) * density.max
    ov.cal_max = density.max
    nv.setOpacity(nv.getVolumeIndexByID(ov.id), opacity)
    nv.setColormap(ov.id, colormap) // also refreshes the GL volume
  }, [ready, threshold, colormap, opacity, density])

  // ---------------------------------------------------------------- view & 3D options
  useEffect(() => {
    const nv = nvRef.current
    if (!ready || !nv) return
    nv.setSliceType(VIEWS.find((v) => v.id === view).type)
  }, [ready, view])

  useEffect(() => {
    const nv = nvRef.current
    if (!ready || !nv) return
    // Glass brain: translucent template so deep blobs stay visible in 3D
    nv.setOpacity(0, glass ? 0.3 : 1)
    nv.updateGLVolume()
  }, [ready, glass])

  useEffect(() => {
    const nv = nvRef.current
    if (!ready || !nv) return
    // depth, azimuth, elevation. Depth > 1.7 hides the plane.
    if (cut === 0) nv.setClipPlane([2, 0, 0])
    else nv.setClipPlane([0.5 - cut, 270, 0])
  }, [ready, cut])

  // ---------------------------------------------------------------- spheres
  useEffect(() => {
    const nv = nvRef.current
    if (!ready || !nv) return
    const setConnectome = (key, nodes, opts) => {
      const old = meshesRef.current[key]
      if (old) { nv.removeMesh(old); meshesRef.current[key] = null }
      if (!nodes.length) return
      nv.loadConnectome({
        name: key,
        nodeScale: 1,
        nodeMinColor: 0,
        nodeMaxColor: 1,
        edgeMin: 0,
        edgeMax: 1,
        edgeScale: 0,
        edgeColormap: 'warm',
        edgeColormapNegative: 'winter',
        showLegend: false,
        ...opts,
        nodes,
        edges: [],
      })
      meshesRef.current[key] = nv.meshes[nv.meshes.length - 1]
    }
    setConnectome('query-points', (points || []).map((p, i) => ({
      name: `P${i + 1}`,
      x: p.xyz[0], y: p.xyz[1], z: p.xyz[2],
      colorValue: p.negated ? -1 : 1,
      sizeValue: Math.max(1.5, p.r),
    })), { nodeColormap: 'green', nodeColormapNegative: 'red' })
    setConnectome('study-foci', (studyFoci || []).map(([x, y, z], i) => ({
      name: `F${i + 1}`, x, y, z, colorValue: 1, sizeValue: 2.5,
    })), { nodeColormap: 'blue', nodeColormapNegative: 'blue' })
    for (const m of nv.meshes) m.colorbarVisible = false // only the density map gets a colorbar
    nv.updateGLVolume() // also rebuilds Niivue's cached colorbar list
  }, [ready, points, studyFoci])

  // keep canvas sized to its container
  useEffect(() => {
    const el = canvasRef.current?.parentElement
    if (!el || !ready) return
    const ro = new ResizeObserver(() => nvRef.current?.resizeListener())
    ro.observe(el)
    return () => ro.disconnect()
  }, [ready])

  const moveTo = (xyz) => {
    const nv = nvRef.current
    if (!nv) return
    nv.scene.crosshairPos = nv.mm2frac(xyz)
    nv.updateGLVolume()
    nv.createOnLocationChange?.()
  }

  const downloadNifti = () => {
    if (!density) return
    const blob = new Blob([toNifti(density.data)], { type: 'application/octet-stream' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `lotus-bf_density_fwhm${fwhm}.nii`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }

  const xyz = loc?.mm?.length === 3 ? loc.mm.map((v) => Math.round(v)) : null

  return (
    <section className='card viewer' aria-label='Brain viewer'>
      <div className='card__head'>
        <h2>Brain</h2>
        <div className='seg' role='tablist' aria-label='View'>
          {VIEWS.map((v) => (
            <button key={v.id} role='tab' aria-selected={view === v.id} className='seg__btn' onClick={() => setView(v.id)}>{v.label}</button>
          ))}
        </div>
      </div>

      <div className='viewer__stage'>
        <canvas ref={canvasRef} />
        <div className='viewer__badges'>
          {mapLoading && <span className='badge'>Computing map…</span>}
          {!mapLoading && map && (
            <span className='badge'>
              {fmt(map.total)} studies · {fmt(map.n_foci)} foci{filtered ? ' · filtered' : ''}
            </span>
          )}
          {mapError && <span className='badge badge--err'>Map unavailable</span>}
        </div>
        {initError && (
          <div className='viewer__error'>
            3D viewer couldn’t start (WebGL2 required).<br /><span className='small muted'>{initError}</span>
          </div>
        )}
        <div className='viewer__legend small'>
          {points?.some((p) => !p.negated) && <span><span className='swatch swatch--pos' /> query point</span>}
          {points?.some((p) => p.negated) && <span><span className='swatch swatch--neg' /> NOT point</span>}
          {studyFoci?.length > 0 && <span><span className='swatch swatch--focus' /> selected study</span>}
        </div>
      </div>

      <div className='viewer__loc'>
        <span className='mono small'>
          {xyz ? <>MNI <b>[{xyz.join(', ')}]</b></> : 'Click the brain to pick a coordinate'}
          {xyz && loc.value != null && density && <span className='muted'> · {round1(loc.value)}% of studies</span>}
        </span>
        <span className='viewer__loc-btns'>
          <button className='btn btn--sm' disabled={!xyz} onClick={() => onAddPoint(pointToken(xyz), 'AND')} title='Add this coordinate with AND'>+ AND {xyz ? pointToken(xyz) : ''}</button>
          <button className='btn btn--ghost btn--sm' disabled={!xyz} onClick={() => onAddPoint(pointToken(xyz), 'OR')}>OR</button>
          <button className='btn btn--ghost btn--sm' disabled={!xyz} onClick={() => onAddPoint(pointToken(xyz), 'AND NOT')}>NOT</button>
          {points?.length > 0 && (
            <select className='input input--sm' value='' onChange={(e) => e.target.value && moveTo(JSON.parse(e.target.value))} aria-label='Jump to a query point'>
              <option value=''>Jump to…</option>
              {points.map((p, i) => <option key={i} value={JSON.stringify(p.xyz)}>{p.negated ? 'NOT ' : ''}[{p.xyz.join(', ')}]</option>)}
            </select>
          )}
        </span>
      </div>

      <div className='viewer__controls'>
        <label>Smoothing <span className='muted'>{fwhm} mm FWHM</span>
          <input type='range' min='0' max='16' step='2' value={fwhm} onChange={(e) => setFwhm(+e.target.value)} />
        </label>
        <label>Threshold <span className='muted'>{threshold}% of peak{density ? ` (${round1((threshold / 100) * density.max)}%)` : ''}</span>
          <input type='range' min='0' max='95' step='5' value={threshold} onChange={(e) => setThreshold(+e.target.value)} />
        </label>
        <label>Map opacity <span className='muted'>{Math.round(opacity * 100)}%</span>
          <input type='range' min='0.1' max='1' step='0.05' value={opacity} onChange={(e) => setOpacity(+e.target.value)} />
        </label>
        <label>Cut-away <span className='muted'>{cut === 0 ? 'off' : `${Math.round(cut * 100)}%`}</span>
          <input type='range' min='0' max='1' step='0.05' value={cut} onChange={(e) => setCut(+e.target.value)} />
        </label>
        <label className='inline'>
          <input type='checkbox' checked={glass} onChange={(e) => setGlass(e.target.checked)} /> Glass brain
        </label>
        <label className='inline'>Colormap
          <select className='input input--sm' value={colormap} onChange={(e) => setColormap(e.target.value)}>
            {COLORMAPS.map((c) => <option key={c}>{c}</option>)}
          </select>
        </label>
        <button className='btn btn--ghost btn--sm' disabled={!density} onClick={downloadNifti} title='Download the current density map as NIfTI'>Download .nii</button>
      </div>
      <p className='muted small viewer__note'>
        Map value = share of matching studies reporting a focus nearby (Gaussian-smoothed).
        Drag to rotate · scroll to zoom · click to set the crosshair.
      </p>
    </section>
  )
}
