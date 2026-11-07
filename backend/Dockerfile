# Build context: repository root (see render.yaml / docker-compose.yml)

# ---- 1. React frontend -------------------------------------------------------
FROM node:22-alpine AS frontend
WORKDIR /frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ---- 2. FastAPI backend (serves the API and the built frontend) -------------
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# WITH_TOOLS=1 adds pandas/pyarrow for create_db.py (used by the compose `seed` service)
ARG WITH_TOOLS=0
COPY backend/requirements.txt backend/requirements-tools.txt ./
RUN pip install -r requirements.txt \
 && if [ "$WITH_TOOLS" = "1" ]; then pip install -r requirements-tools.txt; fi

COPY backend/ .
COPY --from=frontend /frontend/dist ./static/app

RUN useradd --create-home --uid 10001 app
USER app

# Render injects $PORT; default to 8000 locally.
EXPOSE 8000
CMD exec uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000} \
    --workers ${WEB_CONCURRENCY:-2} --proxy-headers --forwarded-allow-ips='*'
