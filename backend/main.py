import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.exceptions import RequestValidationError
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.responses import JSONResponse
from loguru import logger
from starlette.concurrency import run_in_threadpool

from db import check_database
from errors import AppError
from logging_setup import setup_logging
from routers import api, dissociate, health, query, studies
from routers.health import SPA_DIR
from vocab import get_vocabulary

setup_logging()


@asynccontextmanager
async def lifespan(app: FastAPI):
    await run_in_threadpool(check_database)
    try:
        await run_in_threadpool(get_vocabulary)  # warm the autocomplete cache
    except AppError as e:
        logger.error("Could not load the term vocabulary: {}", e.message)
    yield


app = FastAPI(
    title="LoTUS-BF",
    description="Location-or-Term Unified Search for Brain Functions: boolean term/coordinate "
                "queries over a Neurosynth-backed PostgreSQL database.",
    lifespan=lifespan,
)
# /api/query/map responses are large lists of integers; they compress ~5x
app.add_middleware(GZipMiddleware, minimum_size=1024)


@app.middleware("http")
async def log_requests(request: Request, call_next):
    start = time.perf_counter()
    try:
        response = await call_next(request)
    except Exception:
        # Unhandled errors are logged by unhandled_error(); still record the request
        logger.info("{} {} -> 500 ({:.0f} ms)", request.method, request.url.path,
                    (time.perf_counter() - start) * 1000)
        raise
    logger.info("{} {} -> {} ({:.0f} ms)", request.method, request.url.path,
                response.status_code, (time.perf_counter() - start) * 1000)
    return response


@app.exception_handler(AppError)
async def app_error(request: Request, exc: AppError):
    where = f"{request.method} {request.url.path}"
    if exc.status_code >= 500:
        cause = exc.__cause__
        logger.opt(exception=cause).error("{} failed [{}]: {}", where, exc.code, exc.message)
    else:
        logger.warning("{} rejected [{}]: {}", where, exc.code, exc.message)
    return JSONResponse({"error": exc.code, "detail": exc.message, **exc.extra}, status_code=exc.status_code)


@app.exception_handler(RequestValidationError)
async def validation_error(request: Request, exc: RequestValidationError):
    logger.warning("{} {} rejected [validation]: {}", request.method, request.url.path, exc.errors())
    return await request_validation_exception_handler(request, exc)


@app.exception_handler(Exception)
async def unhandled_error(request: Request, exc: Exception):
    logger.opt(exception=exc).error("{} {} crashed", request.method, request.url.path)
    return JSONResponse({"error": "internal_error", "detail": "Internal server error."}, status_code=500)


app.include_router(health.router)
app.include_router(studies.router)
app.include_router(dissociate.router)
app.include_router(query.router)
app.include_router(api.router)

# Built React frontend (frontend/dist, copied here by the Dockerfile). Mounted last so
# every API route above takes precedence; `/` itself is served by routers/health.py.
if SPA_DIR.is_dir():
    app.mount("/", StaticFiles(directory=SPA_DIR), name="spa")
