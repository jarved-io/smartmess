"""Where historical meal data comes from. Swap CSV for PostgreSQL/Supabase with HISTORY_SOURCE=postgres."""
from __future__ import annotations

import logging
import os
import time
from typing import Protocol

import pandas as pd

from . import config as C
from .preprocessing import load_raw

log = logging.getLogger(__name__)


class HistoryProvider(Protocol):
    def load(self) -> pd.DataFrame: ...


class CsvHistoryProvider:
    def __init__(self, path: str = C.HISTORY_CSV):
        self.path = path

    def load(self) -> pd.DataFrame:
        return load_raw(self.path)


class PostgresHistoryProvider:
    """Reads aggregated usage (mess_id, date, meal_type, served_meals[, active_students, ...]) via SQL.
    Needs DATABASE_URL (a read-only Supabase/Postgres connection string); sqlalchemy + psycopg2-binary are in requirements.txt."""

    def __init__(self, dsn: str | None = None, sql: str = C.HISTORY_SQL):
        dsn = dsn or os.environ["DATABASE_URL"]
        for prefix in ("postgresql://", "postgres://"):       # pin the psycopg2 driver (SQLAlchemy 2.1 would pick psycopg3)
            if dsn.startswith(prefix):
                dsn = "postgresql+psycopg2://" + dsn[len(prefix):]
        self.dsn, self.sql = dsn, sql

    def load(self) -> pd.DataFrame:
        from sqlalchemy import create_engine, text
        eng = create_engine(self.dsn, pool_pre_ping=True)
        with eng.connect() as con:
            return pd.read_sql(text(self.sql), con)


class CachedProvider:
    def __init__(self, inner: HistoryProvider, ttl: int = C.HISTORY_CACHE_SECONDS):
        self.inner, self.ttl, self._at, self._df = inner, ttl, 0.0, None

    def load(self) -> pd.DataFrame:
        if self._df is None or time.time() - self._at > self.ttl:
            self._df, self._at = self.inner.load(), time.time()
            log.info("History refreshed: %d rows", len(self._df))
        return self._df

    def invalidate(self) -> None:
        self._df = None


def get_history_provider() -> CachedProvider:
    inner = PostgresHistoryProvider() if C.HISTORY_SOURCE == "postgres" else CsvHistoryProvider()
    return CachedProvider(inner)
