"""
Build the region-name lookup used by the brain viewer (frontend/public/atlas/).

Harvard-Oxford cortical (lateralised) + subcortical atlases, max-probability at 25 %,
2 mm MNI152 (FSL), combined into one uint8 volume on the viewer's grid:
voxel (i, j, k) <-> MNI (x, y, z) = (-2i + 90, 2j - 126, 2k - 72), C order with i fastest.

    uv run --with nilearn python scripts/build_atlas.py <download_dir>

The atlas comes with FSL (Desikan et al. 2006, Makris et al. 2006, Frazier et al. 2005,
Goldstein et al. 2007) and is fetched by nilearn.
"""

import gzip
import json
import sys
from pathlib import Path

import nibabel as nib
import numpy as np
from nilearn import datasets

OUT = Path(__file__).resolve().parents[1] / "frontend" / "public" / "atlas"
# Subcortical labels that are tissue classes rather than regions: the cortical atlas covers cortex
SKIP_SUB = {"Left Cerebral White Matter", "Left Cerebral Cortex", "Left Lateral Ventricle",
            "Right Cerebral White Matter", "Right Cerebral Cortex", "Right Lateral Ventricle"}


def load(atlas):
    img = atlas.maps if hasattr(atlas.maps, "affine") else nib.load(atlas.maps)
    return img, np.asarray(img.get_fdata()).round().astype(int)


def to_viewer_grid(img, data):
    """Reorder so index i maps to x = -2i + 90 (whatever the file's own orientation is)."""
    aff = img.affine
    assert data.shape == (91, 109, 91) and np.allclose(np.abs(np.diag(aff)[:3]), 2), aff
    if aff[0, 0] > 0:  # x = 2i - 90 (RAS): flip to the viewer's x = -2i + 90
        data = data[::-1]
    assert np.isclose(aff[1, 1], 2) and np.isclose(aff[1, 3], -126) and np.isclose(aff[2, 3], -72), aff
    return data


def main(download_dir: str):
    cort = datasets.fetch_atlas_harvard_oxford("cort-maxprob-thr25-2mm", data_dir=download_dir, symmetric_split=True)
    sub = datasets.fetch_atlas_harvard_oxford("sub-maxprob-thr25-2mm", data_dir=download_dir)
    cimg, c = load(cort)
    simg, s = load(sub)
    c, s = to_viewer_grid(cimg, c), to_viewer_grid(simg, s)

    labels = ["" ] + list(cort.labels[1:])  # ids 1..96: cortical
    out = c.astype(np.uint8)
    for sid, name in enumerate(sub.labels):
        if sid == 0 or name in SKIP_SUB:
            continue
        labels.append(name)
        out[s == sid] = len(labels) - 1  # subcortical structures take precedence
    assert len(labels) < 256

    # Sanity: "Left ..." regions must sit at negative x in the viewer grid
    xs = -2 * np.arange(91) + 90
    for name in ("Left Amygdala", "Right Amygdala", "Left Insular Cortex"):
        i = labels.index(name)
        mean_x = xs[np.nonzero(out == i)[0]].mean()
        print(f"{name}: mean x = {mean_x:+.1f}")
        assert (mean_x < 0) == name.startswith("Left")

    OUT.mkdir(parents=True, exist_ok=True)
    raw = np.ascontiguousarray(out.transpose(2, 1, 0)).tobytes()  # k, j, i -> i fastest
    (OUT / "harvard-oxford-2mm.u8.gz").write_bytes(gzip.compress(raw, 9, mtime=0))
    (OUT / "harvard-oxford.json").write_text(json.dumps({
        "name": "Harvard-Oxford (cortical, lateralised + subcortical), max-prob 25%, 2 mm MNI152",
        "source": "FSL; Desikan et al. 2006, Makris et al. 2006, Frazier et al. 2005, Goldstein et al. 2007",
        "shape": [91, 109, 91],
        "labels": labels,
    }, indent=1))
    print(f"{len(labels) - 1} regions, {(out > 0).sum()} labelled voxels -> {OUT}")


if __name__ == "__main__":
    main(sys.argv[1])
