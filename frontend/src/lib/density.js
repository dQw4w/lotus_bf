// Turns the backend's binned foci (/api/query/map) into a smoothed density volume
// on the MNI152 2mm grid, and wraps it as an in-memory NIfTI-1 file for Niivue.
//
// Value at a voxel ≈ % of matching studies that report a focus nearby: each
// study's focus contributes a Gaussian with peak 1, so smoothing stays on the
// "number of studies" scale instead of being diluted by kernel normalisation.

export const SHAPE = [91, 109, 91]
export const VOXEL_MM = 2
// voxel i,j,k -> MNI mm (FSL MNI152 2mm)
export const AFFINE = [
  [-2, 0, 0, 90],
  [0, 2, 0, -126],
  [0, 0, 2, -72],
]

export function mmToVoxel ([x, y, z]) {
  return [Math.round((90 - x) / 2), Math.round((y + 126) / 2), Math.round((z + 72) / 2)]
}

function kernel1d (sigmaVox) {
  const half = Math.max(1, Math.ceil(3 * sigmaVox))
  const k = new Float32Array(2 * half + 1)
  for (let i = -half; i <= half; i++) k[i + half] = Math.exp(-(i * i) / (2 * sigmaVox * sigmaVox))
  return { k, half }
}

// One separable pass along `axis` (0=x, 1=y, 2=z) from src into dst.
function convolveAxis (src, dst, [nx, ny, nz], axis, { k, half }) {
  const stride = axis === 0 ? 1 : axis === 1 ? nx : nx * ny
  const n = axis === 0 ? nx : axis === 1 ? ny : nz
  dst.fill(0)
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      const row = y * nx + z * nx * ny
      for (let x = 0; x < nx; x++) {
        const idx = row + x
        const v = src[idx]
        if (v === 0) continue // sparse input: scatter non-zero voxels only
        const pos = axis === 0 ? x : axis === 1 ? y : z
        const lo = Math.max(-half, -pos)
        const hi = Math.min(half, n - 1 - pos)
        for (let o = lo; o <= hi; o++) dst[idx + o * stride] += v * k[o + half]
      }
    }
  }
}

/**
 * @param {number[]} voxels flat [i, j, k, nStudies, ...] from /api/query/map
 * @param {number} totalStudies matching studies (for the % scale)
 * @param {number} fwhmMm Gaussian FWHM in mm (0 = no smoothing)
 * @returns {{data: Float32Array, max: number}}
 */
export function buildDensity (voxels, totalStudies, fwhmMm) {
  const [nx, ny, nz] = SHAPE
  const a = new Float32Array(nx * ny * nz)
  for (let p = 0; p < voxels.length; p += 4) {
    a[voxels[p] + voxels[p + 1] * nx + voxels[p + 2] * nx * ny] += voxels[p + 3]
  }
  let out = a
  if (fwhmMm > 0) {
    const sigmaVox = fwhmMm / (2 * Math.sqrt(2 * Math.log(2))) / VOXEL_MM
    const kern = kernel1d(sigmaVox)
    const b = new Float32Array(a.length)
    convolveAxis(a, b, SHAPE, 0, kern)
    convolveAxis(b, a, SHAPE, 1, kern)
    convolveAxis(a, b, SHAPE, 2, kern)
    out = b
  }
  const scale = totalStudies > 0 ? 100 / totalStudies : 0
  let max = 0
  for (let i = 0; i < out.length; i++) {
    const v = out[i] * scale
    out[i] = v
    if (v > max) max = v
  }
  return { data: out, max }
}

/** Minimal NIfTI-1 (.nii) writer: float32 volume with an MNI sform. */
export function toNifti (data, description = 'LoTUS-BF density (% studies)') {
  const [nx, ny, nz] = SHAPE
  const voxOffset = 352
  const buf = new ArrayBuffer(voxOffset + data.length * 4)
  const dv = new DataView(buf)
  const le = true
  dv.setInt32(0, 348, le) // sizeof_hdr
  ;[3, nx, ny, nz, 1, 1, 1, 1].forEach((d, i) => dv.setInt16(40 + 2 * i, d, le)) // dim
  dv.setInt16(70, 16, le) // datatype FLOAT32
  dv.setInt16(72, 32, le) // bitpix
  ;[1, VOXEL_MM, VOXEL_MM, VOXEL_MM, 1, 1, 1, 1].forEach((d, i) => dv.setFloat32(76 + 4 * i, d, le)) // pixdim
  dv.setFloat32(108, voxOffset, le) // vox_offset
  dv.setFloat32(112, 1, le) // scl_slope
  dv.setUint8(123, 2 + 8) // xyzt_units: mm + s
  const descr = new TextEncoder().encode(description.slice(0, 79))
  new Uint8Array(buf, 148, descr.length).set(descr)
  dv.setInt16(252, 0, le) // qform_code: unused
  dv.setInt16(254, 4, le) // sform_code: MNI152
  AFFINE.forEach((row, r) => row.forEach((v, c) => dv.setFloat32(280 + 16 * r + 4 * c, v, le))) // srow_x/y/z
  new Uint8Array(buf, 344, 4).set([0x6e, 0x2b, 0x31, 0]) // magic "n+1\0"
  new Float32Array(buf, voxOffset).set(data)
  return buf
}
