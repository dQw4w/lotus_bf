"""Route all logging (ours, uvicorn's, SQLAlchemy's) through loguru."""

import inspect
import logging
import os
import sys

from loguru import logger

LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()


class InterceptHandler(logging.Handler):
    """Forward stdlib logging records to loguru (recipe from the loguru docs)."""

    def emit(self, record: logging.LogRecord) -> None:
        try:
            level: str | int = logger.level(record.levelname).name
        except ValueError:
            level = record.levelno

        # Find the caller outside the logging module so loguru reports the right origin
        frame, depth = inspect.currentframe(), 0
        while frame and (depth == 0 or frame.f_code.co_filename == logging.__file__):
            frame = frame.f_back
            depth += 1

        logger.opt(depth=depth, exception=record.exc_info).log(level, record.getMessage())


def setup_logging() -> None:
    logger.remove()
    logger.add(
        sys.stderr,
        level=LOG_LEVEL,
        format=(
            "<green>{time:YYYY-MM-DD HH:mm:ss.SSS}</green> | <level>{level: <8}</level> | "
            "<cyan>{name}</cyan>:<cyan>{line}</cyan> - <level>{message}</level>"
        ),
        backtrace=False,  # keep tracebacks to our frames + the failing call
        diagnose=False,   # don't print local variable values (may contain secrets)
    )

    logging.basicConfig(handlers=[InterceptHandler()], level=0, force=True)
    # Uvicorn installs its own handlers before importing the app; replace them
    for name in ("uvicorn", "uvicorn.error", "sqlalchemy"):
        std_logger = logging.getLogger(name)
        std_logger.handlers = [InterceptHandler()]
        std_logger.propagate = False
    # Requests are logged by main.log_requests (with timing) instead
    logging.getLogger("uvicorn.access").disabled = True
