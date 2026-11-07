# Neurosynth Backend

> This is the write-up of the ns-nano backend that LoTUS-BF is built on. Everything here still
> works; the LoTUS-BF frontend and its `/api/*` endpoints are described in the [main README](../README.md).
> Paths below are relative to the repository root.

A lightweight FastAPI backend that exposes study lookup and **functional dissociation** endpoints on top of a Neurosynth-backed PostgreSQL (PostGIS) database.

Dissociation endpoints return studies that match one term/coordinate **but not** the other (A \ B). Swap the arguments to get B \ A.

**Live demo:** <https://chenyu-ns-nano.onrender.com/ui>

---

## What I changed from the original template

A quick note before the list: everything in this repository was written with AI (Claude Code) including most parts of this README file (Although I wrote this sentence on my own), but most of the refactor ideas come from me and my own engineering experience. I decided what to change and why, and the AI did most of the typing.

### 1. Plain Python → Docker

The app now runs in a Docker container (`backend/Dockerfile`), and there's a `docker-compose.yml` that also starts a local PostGIS database and a one-off job for loading the data.

The main reason is a **fixed environment**: same Python version, same pinned package versions, on my laptop and on Render. No more "works on my machine". To be honest, this backend is simple and doesn't have complicated dependencies, so it would survive without Docker. But it costs very little, and it also means I can spin up a full local copy (database included) with one command instead of setting up Postgres + PostGIS by hand.

### 2. Logging with loguru

All logs (mine, uvicorn's, SQLAlchemy's) now go through [loguru](https://github.com/Delgan/loguru), and database errors get wrapped in my own error classes (`backend/errors.py`). This is mainly for **easier debugging**. This change paid off right away: when the deployed site first returned 500 errors, the logs were just a huge raw stack trace. Now the service checks on startup that the tables exist and logs exactly what's wrong (e.g. `Schema 'ns' is missing tables [...]; run create_db.py`), and the API returns a readable error instead of a generic 500.

### 3. Supabase instead of Render Postgres

The database lives on Supabase instead of Render's Postgres. Why:

- **Render's free Postgres expires after 30 days.**  Supabase's free database doesn't expire. I simply just did not want my data deleted.
- Supabase supports **PostGIS**, which the location queries need.
- It has a web dashboard and SQL editor, which is handy for poking at the data.
- The free tier (500 MB) is plenty: the whole dataset loaded is about 250 MB.

### 4. Flask → FastAPI

Switched the web framework from Flask to FastAPI, simply because FastAPI is more efficient. A nice bonus is the auto-generated API docs at `/docs`. (As mentioned in lecture slides)

### 5. A small test page (`/ui`)

There's a simple frontend at `/ui` with a form for each of the four endpoints, plus separate "Extras" rows for the extra endpoints I added (the query-parameter mirrors, the both-directions dissociation and `/health`). It's purely for testing convenience, because I'm too lazy to open Postman every time. It isn't part of the assignment itself.

### 6. Keeping the free Render service awake

Render's free tier puts the service to sleep after about 15 minutes with no traffic, and the first request after that takes 30–60 seconds while it wakes up. I'm planning to set up a cron job that pings the service regularly so it stays awake. (Pinging an endpoint that touches the database also keeps the Supabase project from being paused for inactivity.)

**Heads-up:** I might forget to set it up, or the cron job might die or get blocked for sending too many requests. Hopefully I don't forget.

---

## Table of Contents

- [What I changed from the original template](#what-i-changed-from-the-original-template)
- [Project Layout](#project-layout)
- [Endpoints](#endpoints)
- [Local Development (Docker)](#local-development-docker)
- [Deploying (Supabase + Render)](#deploying-supabase--render)
- [Environment Variables](#environment-variables)
- [Reflection](#reflection)
- [License](#license)

---

## Project Layout

```text
.
├── backend/
│   ├── Dockerfile
│   ├── main.py               # FastAPI app
│   ├── config.py             # env-driven settings
│   ├── db.py                 # SQLAlchemy engine / connections
│   ├── queries.py            # SQL for study sets and A \ B
│   ├── params.py             # term / x_y_z parsing
│   ├── errors.py             # custom error classes
│   ├── logging_setup.py      # loguru setup
│   ├── routers/              # health, studies, dissociate
│   ├── static/               # index.html (the /ui test page), amygdala.gif
│   ├── create_db.py          # loads data/*.parquet into the DB
│   ├── check_db.py           # checks DB extensions (PostGIS, tsvector, pgvector)
│   ├── requirements.txt      # web image deps
│   └── requirements-tools.txt  # extra deps for create_db.py
├── data/                     # Neurosynth Parquet files
├── docker-compose.yml        # local PostGIS + API + seed job
└── render.yaml               # Render Blueprint
```

---

## Endpoints

A browser UI for trying the four assignment endpoints (and, in a separate Extras row, the extra ones) is served at **`/ui`**: fill in terms or coordinates, then **Run** to see the studies inline or **Open endpoint** to view the raw JSON. Interactive API docs are at `/docs`.

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/terms/<term>/studies` | Studies mentioning `term` |
| GET | `/locations/<x_y_z>/studies` | Studies reporting a coordinate near `[x, y, z]` |
| GET | `/dissociate/terms/<term_a>/<term_b>` | Studies mentioning `term_a` but **not** `term_b` |
| GET | `/dissociate/locations/<x1_y1_z1>/<x2_y2_z2>` | Studies near `[x1, y1, z1]` but **not** near `[x2, y2, z2]` |
| GET | `/studies/by-term?term=<term>` | Query-parameter mirror of `/terms/<term>/studies` (paginated) |
| GET | `/studies/by-location?x=&y=&z=&r=` | Query-parameter mirror of `/locations/<x_y_z>/studies` (paginated) |
| GET | `/dissociate/terms?term_a=&term_b=` | Query-parameter mirror of `/dissociate/terms/<term_a>/<term_b>` (paginated) |
| GET | `/dissociate/locations?x1=&y1=&z1=&x2=&y2=&z2=&r=` | Query-parameter mirror of `/dissociate/locations/<x1_y1_z1>/<x2_y2_z2>` (paginated) |
| GET | `/dissociate/terms/<term_a>/<term_b>/both` | Both directions at once: `a_not_b` and `b_not_a` |
| GET | `/dissociate/locations/<x1_y1_z1>/<x2_y2_z2>/both` | Both directions at once: `a_not_b` and `b_not_a` |
| GET | `/health` | Plain-text liveness ping (used by the keep-awake cron job) |
| GET | `/` , `/img`, `/test_db` | Server check, sample image, DB connectivity report |

**Terms** are case-insensitive; spaces may be sent as `%20` or `_` (`posterior_cingulate`).

**Coordinates** are MNI `x_y_z` with underscores (`0_-52_26`). A study matches a location if any of its reported foci lies within a sphere of radius `r` mm (default **6**, max 20). Pass `?r=0` for exact matches only.

### Why the query-parameter mirrors?

(I told AI to implement this, it's my own idea)
The four assignment endpoints pack their inputs into the URL path (`0_-52_26`, `posterior_cingulate`). That works, but it's not really how filters are usually passed:

- `x_y_z` is just one string as far as the framework is concerned, so I have to split and validate it by hand, and `/docs` can only say "string".
- Spaces in terms need `%20` or the `_` → space hack, which means a term that really contains `_` couldn't be searched. None of the current Neurosynth terms do, so this doesn't break anything today.
- A term containing `/` can't go in a path segment at all, even encoded (`%2F` is often rejected or decoded by proxies).
- Path segments usually identify a resource (`/studies/123`); search inputs normally go in the query string.

So each of the four also has a mirror that takes the same inputs as separate, typed query parameters, e.g. `/studies/by-location?x=0&y=-52&z=26&r=6`. They match exactly the same studies, and FastAPI validates every parameter itself (bad numbers get a 422) and documents each one in `/docs`. The original four stay as they are, since that's the format the assignment asks for.

Since I was already designing these with a frontend in mind, the mirrors are also **sorted and paginated**. Dumping 1,500 studies in one response is fine for an assignment, but a real UI would show a page at a time:

| Parameter | Default | Notes |
| --- | --- | --- |
| `sort` | `year` | `year`, `title`, `journal`, `study_id`; the location mirrors also accept `distance` |
| `order` | per key | `asc` or `desc`; defaults to newest first for `year`, ascending for everything else |
| `limit` | `50` | 1–500 |
| `offset` | `0` | Results to skip |

```jsonc
{
  "term": "amygdala",
  "total": 1579,         // all matches
  "count": 50,           // rows in this page
  "offset": 0,
  "limit": 50,
  "next_offset": 50,     // null on the last page
  "sort": "year",
  "order": "desc",
  "studies": [ ... ]
}
```

The location mirrors also add `distance_mm` to each study: how far its closest reported focus is from the point (from point 1 for the dissociation). That's what `sort=distance` sorts by. Ties are always broken by PMID, so pages don't overlap or skip studies.

The assignment endpoints' responses include `count` and a `studies` list of `{study_id, title, authors, journal, year}`, newest first.

Errors return `{"error": <code>, "detail": <message>}`:

| Status | `error` | Meaning |
| --- | --- | --- |
| 400 | `invalid_parameter` | Malformed term or coordinates |
| 422 | — | Query validation failed (e.g. `r` out of range; FastAPI's default body) |
| 503 | `schema_not_initialized` | Tables missing: run `create_db.py` against this `DATABASE_URL` |
| 503 | `database_unavailable` | Can't connect (bad host, password, or network) |
| 503 | `database_not_configured` | `DATABASE_URL` not set |
| 500 | `database_query_failed` / `internal_error` | Anything else; full traceback is in the logs |

### Default Mode Network examples

```bash
curl "http://localhost:8000/dissociate/terms/posterior_cingulate/ventromedial_prefrontal"
curl "http://localhost:8000/dissociate/terms/ventromedial_prefrontal/posterior_cingulate"
curl "http://localhost:8000/dissociate/locations/0_-52_26/-2_50_-6"
curl "http://localhost:8000/dissociate/locations/-2_50_-6/0_-52_26?r=10"
```

---

## Local Development (Docker)

```bash
docker compose up -d --build                    # PostGIS on :54322, API on :8000
docker compose --profile seed run --rm seed     # load data/*.parquet (~1 min)
open http://localhost:8000/docs
```

The `seed` service uses the same image built with `WITH_TOOLS=1`, which adds pandas/pyarrow.

---

## Deploying (Supabase + Render)

### 1) Create the Supabase database

Create a Supabase project, then copy the **Session pooler** connection string from *Project Settings → Database → Connection string*. Use the pooler host (`aws-0-<region>.pooler.supabase.com`), not the direct `db.<ref>.supabase.co` host: the direct host is IPv6-only, and Render can't reach it.

```bash
cp .env.example .env    # paste the pooler URL into DATABASE_URL
```

### 2) Verify and populate

Both commands read `DATABASE_URL` from `.env`:

```bash
docker compose --profile seed run --rm seed python check_db.py
docker compose --profile seed run --rm seed
```

The loaded data takes about 250 MB, which fits Supabase's free tier.

### 3) Deploy to Render

Push the repo, then in Render choose **New → Blueprint** and select it. `render.yaml` builds `backend/Dockerfile`. When prompted, set `DATABASE_URL` to the same Supabase pooler URL.

After the deploy, open `https://<your-app>.onrender.com/test_db` to confirm the counts.

On startup the service logs the database it connects to (password masked) and whether all tables exist. If it logs `missing tables`, the database at that URL hasn't been seeded.

---

## Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `DATABASE_URL` (or `DB_URL`) | — | PostgreSQL connection string |
| `DB_SCHEMA` | `ns` | Schema created by `create_db.py` |
| `DB_SRID` | `4326` | Must match `create_db.py --srid` |
| `DEFAULT_RADIUS_MM` | `6` | Default sphere radius for location queries |
| `MAX_RADIUS_MM` | `20` | Upper bound for `?r=` |
| `DEFAULT_PAGE_SIZE` | `50` | Default `?limit=` for the paginated mirrors |
| `MAX_PAGE_SIZE` | `500` | Upper bound for `?limit=` |
| `PORT` | `8000` | Set automatically by Render |
| `WEB_CONCURRENCY` | `2` | Uvicorn worker processes |
| `LOG_LEVEL` | `INFO` | Loguru log level (`DEBUG`, `INFO`, `WARNING`, …) |

> **Security note:** Never commit real credentials. `.env` is git-ignored.

---

## Reflection

The four endpoints themselves were honestly the easy part. The dissociation logic is basically "studies with A, minus studies with B", and PostGIS does the hard work for the distance part with `ST_3DDWithin`. Most of my time went into everything around the endpoints.

Some things I learned, mostly the hard way:

- **Deploying is where things actually break.** Everything worked locally, and then the first time I opened the Render URL I got a 500 with `relation "metadata" does not exist`. The code was fine. I just never loaded the data into Supabase. Then I ran the seed command, felt good about it, and it *still* didn't work, because my `.env` was missing the `DATABASE_URL=` part, so the data quietly went into my local Docker database instead. Two tiny mistakes, and both just looked like "the server is broken" from the outside. That's a big part of why I added the startup check and the readable error messages.
- **Most of the problems were config, not code.** I created the Render service as a normal Web Service instead of a Blueprint, so it ignored my `render.yaml` and couldn't even find `requirements.txt`. Supabase's direct database host turned out to be IPv6-only, which Render can't reach, so I had to use the pooler (and switch from the transaction pooler to the session pooler). None of that shows up in the Python files, but it ate a lot of time.
- **Different doesn't mean wrong.** I compared my results with another student's implementation (their repo was public, so I could call their endpoints). At first glance the two outputs looked nothing alike: different JSON format, different order of studies. After actually checking, the counts were identical (406 and 424 for PCC vs. vmPFC) and the studies matched. Theirs were just sorted by distance, and mine are sorted by year. So now I compare the contents, not how the output looks.
- **The required format isn't always the nicest one.** Putting `0_-52_26` in the URL path works, but it means splitting and validating the string by hand, and some terms can't be expressed cleanly. I kept the assignment format as asked and added the query-parameter versions next to it, instead of replacing anything.
- **Small thing, but:** forking a public template made my repo public and linked to the original. I didn't think about that at all until I got curious and looked through the template's public forks, where I found my own repo next to some other students' repos. I had to leave the fork network to sort of fix it. (That's also how I found the implementation I compared my results with above.)

---

## License

This project is licensed under the MIT License. See [LICENSE](../LICENSE) for details.
