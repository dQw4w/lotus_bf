# LoTUS-BF

**Location-or-Term Unified Search for Brain Functions.** Search the 14,371 fMRI studies in
[Neurosynth](https://neurosynth.org) with one boolean query that mixes **terms** and **MNI
coordinates**, then see where the matching studies report activation on a **3D brain**.

```text
amygdala AND (fear OR anxiety) NOT [22, 0, -20]
"posterior cingulate" NOT "ventromedial prefrontal"
[0, -52, 26, 10] OR "default mode"
```

This is a rewrite of the original LoTUS-BF (`http://hpc.psy.ntu.edu.tw:3000/lotus-bf/`). It's a React
frontend on top of the FastAPI + Supabase backend in [`backend/`](backend/) (its own write-up is in
[`backend/README.md`](backend/README.md)), deployed as a single Render service.

---

## What changed from the original

### 1. The boolean query is actually boolean

The original split every query into a "terms" expression and a "coordinates" expression and always
**intersected** the two. It also dropped parentheses around terms and matched words by full-text
search instead of the Neurosynth term annotations. Measured on both services (study counts):

| Query | Original LoTUS-BF | Now |
| --- | --- | --- |
| `[0,-52,26] OR emotion` | 33, the same as `AND` | **1,474** (= 479 + 1,037 − 42 overlap) |
| `amygdala NOT (fear OR anxiety)` | 186, but its De Morgan twin `amygdala NOT fear NOT anxiety` gives 320 | **1,204** for both |
| `posterior cingulate` | 25 (word search) | **947** (the Neurosynth term) |
| `amygdal` (typo) | 0, with no warning | error with the word highlighted + *Did you mean: amygdala …* |

The new parser ([`backend/boolean_query.py`](backend/boolean_query.py)) is a small recursive-descent
parser. Terms and coordinates are leaves of **one** expression tree:

- precedence `NOT` > `AND` > `OR`, parentheses, and implicit AND (`reward [10, 12, -8]`)
- operators are case-insensitive; `&`, `|`, `!` also work
- bare words are grouped into vocabulary terms by longest match (`posterior cingulate emotion` →
  `"posterior cingulate" AND emotion`), or you can quote them
- `[x, y, z]` uses the radius selector (default 6 mm); `[x, y, z, r]` sets a radius for that point
- every error carries a character span, so the UI can highlight exactly what's wrong
- the response echoes the parse: the UI shows **Interpreted as** `amygdala AND (fear OR anxiety) AND NOT [22, 0, -20]`,
  so you always know what was run

Each distinct leaf compiles to one `MATERIALIZED` CTE (its set of study ids), and the tree becomes a
boolean `WHERE` over them. That guarantees each PostGIS sphere search runs once. Without
materializing, Postgres sometimes turned a leaf into a per-row semi-join and a simple query hit
Supabase's 2-minute statement timeout.

### 2. A query builder for people who don't write boolean logic

The query bar has two tabs. **Builder** (the default) has three boxes, the same layout as
Google's and PubMed's advanced search:

| Box | Means | Becomes |
| --- | --- | --- |
| **All of these** | must match every one | `a AND b` |
| **Any of these** | must match at least one | `(c OR d)` |
| **None of these** | must match none | `NOT e AND NOT f` |

- Each box takes terms (autocomplete with study counts) and locations typed as `x, y, z`
  (a 4th number sets the radius). Adding an item that is already in another box moves it.
- Each row shows how many studies are left after it and the rows above, so you see what every row does
  (`amygdala` → 1,579, `+ fear or anxiety` → 375, `none of [22, 0, -20]` → 298).
- The builder writes the text query, and the **Text** tab shows it. A text query, example,
  term-panel click or brain click that fits the three boxes appears in the builder; one that
  doesn't, such as `(A AND B) OR C`, shows a note with **Edit as text** / **Start over here**.

Under every query (in both tabs), a sentence says what will run in plain English, e.g. *Studies that
mention "amygdala", and mention "fear" or "anxiety", and report no peak within 6 mm of [22, 0, -20].*
It also states what "mention" (the phrase appears in the abstract) and "peak" (a coordinate in the
paper's results tables) mean.

### 3. A real 3D viewer

The old viewer was a hand-written 2D canvas slicer. The new one uses [Niivue](https://github.com/niivue/niivue)
(WebGL2) to volume-render the MNI152 template with the density map of the matching studies:

- **3D**, **3D + slices**, or single axial / coronal / sagittal views
- **Glass brain** (translucent template, so deep activations stay visible) and a **cut-away** clip plane
- query coordinates drawn as spheres of their search radius (green = included, red = `NOT`);
  clicking a study shows **its** foci in blue
- click anywhere to read the MNI coordinate and the map value there, then **+ AND / OR / NOT** it into the query
- smoothing (FWHM), threshold, opacity and colormap update instantly. The backend sends the foci
  binned on the 2 mm grid once, and the browser does the Gaussian smoothing, so there's no server round trip per slider move
- **Download .nii** exports the current map as NIfTI

The map value is the share of matching studies that report a focus nearby, so it reads on a "% of studies" scale.

### 4. Term search like ns-nano-hw08, but instant

The search box autocompletes the term you're typing, **wherever the cursor is in the expression**,
and shows how many studies each term has (`posterior cingulate — 947 studies`). Use ↑/↓ and Tab/Enter.
The whole vocabulary (3,228 terms with counts) loads once, so suggestions need no network round trip.
The **Terms** panel lists every term with its count. Click to AND it in, hover for OR / NOT,
and ≈ for related terms (ranked by Jaccard overlap of their study sets).

### 5. Filtering the returned studies

Above the study list:

- **Keyword:** words in the title, authors or journal. Each word matches as a prefix and all must
  match, so `eickh` finds Eickhoff and `emotional faces` needs both. It uses the existing full-text index.
- **Year:** pick a from/to range, or click a bar in the per-year histogram to pick a single year
  (click it again to clear).
- **Journal:** a searchable multi-select with study counts. Picking several journals means any of them.

Filters narrow the **brain map too**, so the map always shows the studies in the list. Counts are
faceted: the histogram applies the keyword and journal filters but not the year filter, so it still
shows every year you could pick (and the journal list works the same way). Filters are kept in the
URL (`&s=faces&y0=2010&j=NeuroImage`) and stay when you change the query.

### Smaller things

- Studies are sorted and paged **on the server** (the original downloaded every match, then sorted in the browser), and link to PubMed
- clicking a study shows its metadata, its top TF-IDF terms (click one to add it), and its foci on the brain
- the query lives in the URL (`?q=…&r=…`), so links are shareable and back/forward work
- light/dark theme, works on phones
- no database credentials in the source (the original `app.py` hard-codes them, which is why
  `lotus-bf.zip` is git-ignored)

---

## Project layout

```text
.
├── frontend/                  React + Vite app
│   ├── public/mni_2mm.nii.gz  MNI152 2 mm brain template (same file as the original)
│   └── src/
│       ├── App.jsx            state, URL sync, data fetching
│       ├── components/        QueryBar, QueryBuilder, TermsPanel, StudiesTable, StudyFilters, BrainViewer
│       └── lib/               api client, query-text and builder helpers, density map + NIfTI writer
├── backend/                   FastAPI (see backend/README.md)
│   ├── boolean_query.py       query language: lexer, parser, AST → SQL
│   ├── vocab.py               cached term vocabulary, ranking, suggestions
│   ├── routers/api.py         /api/* endpoints used by the frontend
│   ├── tests/                 parser tests
│   └── Dockerfile             builds the frontend, then the API image that serves it
├── data/                      Neurosynth Parquet files (for create_db.py)
├── docker-compose.yml
└── render.yaml
```

## API

Interactive docs: `/docs`. The new endpoints are all `GET`:

| Path | Returns |
| --- | --- |
| `/api/query?q=&r=&sort=&order=&limit=&offset=` | studies matching the boolean query, paged, plus the parse (`interpreted`, `ast`, `terms`, `points`) |
| `/api/query/map?q=&r=` | foci of all matching studies binned on the MNI 2 mm grid: flat `[i, j, k, n_studies, …]` |
| `/api/query/count?q=&q=&r=` | study counts for up to 5 queries at once (the builder's running totals) |
| `/api/query/facets?q=&r=` | year and journal counts of the matches, for the filter controls |
| `/api/terms?q=&limit=` | terms ranked exact → prefix → word-prefix → substring, each with `n_studies` |
| `/api/terms/{term}/related` | co-occurring terms with Jaccard similarity |
| `/api/studies/{pmid}` | one study: metadata, all foci, top terms |
| `/api/stats` | row counts |

`/api/query`, `/api/query/map` and `/api/query/facets` accept the same optional study filters: `search=` (keyword),
`year_min=`, `year_max=`, and `journal=` (repeat it for several). `/api/query` returns
`total` (after filters) and `query_total` (before them).

A bad query returns `400` with what went wrong and where:

```json
{"error": "invalid_query", "detail": "Unknown term 'amygdal'", "position": [0, 7],
 "term": "amygdal", "suggestions": ["amygdala", "amygdala hippocampus", "amygdala response", "..."]}
```

All the earlier endpoints (`/terms/{term}/studies`, `/dissociate/...`, the query-parameter mirrors, `/ui`, `/health`)
are unchanged.

## Running locally

Backend against Supabase (or any database loaded with `create_db.py`):

```bash
cd backend
uv venv && uv pip install -r requirements.txt pytest
.venv/bin/uvicorn main:app --reload --env-file ../.env     # http://localhost:8000
.venv/bin/python -m pytest tests                           # parser tests
```

Frontend with hot reload (proxies `/api` to `:8000`):

```bash
cd frontend
npm install
npm run dev                                                # http://localhost:5173
```

Or everything in Docker, exactly as on Render:

```bash
docker build -f backend/Dockerfile -t lotus-bf .
docker run --env-file .env -p 8000:8000 lotus-bf           # http://localhost:8000
```

`docker compose up --build` still works too, with a local PostGIS (see `backend/README.md` for seeding it).

## Deploying to Render

`render.yaml` is a Blueprint for one free Docker web service, `lotus-bf`. The image builds the
React app and FastAPI serves it next to the API, so there's no separate static site and no CORS.

1. Push this repo to GitHub.
2. In Render: **New → Blueprint**, pick the repo.
3. When prompted, set `DATABASE_URL` to the Supabase **session pooler** URL (the same one as in `.env`).
4. Open `https://lotus-bf.onrender.com/` (or whatever name Render assigns). `/health` is the health check.

The service is pinned to **Singapore** to sit next to the Supabase project (`ap-southeast-1`).
The free tier sleeps after ~15 minutes idle, and the page shows a "waking up the server" notice
while the first request spins it up.

## License

MIT. See [LICENSE](LICENSE).
