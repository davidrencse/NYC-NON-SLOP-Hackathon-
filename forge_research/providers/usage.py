"""Server-side ledger of external provider calls.

Every adapter records one entry per billable call so the studio can show what a
run used. Credentials never enter this ledger.
"""

from __future__ import annotations

import threading
from collections import deque
from datetime import UTC, datetime
from typing import Literal

from pydantic import BaseModel, Field

Provider = Literal["claude", "nous", "gemini", "reducto", "pangram", "modal"]


class UsageEntry(BaseModel):
    timestamp: datetime
    provider: Provider
    operation: str
    model: str | None = None
    ok: bool = True
    duration_ms: int = 0
    prompt_tokens: int | None = None
    output_tokens: int | None = None
    pages: int | None = None
    credits: float | None = None
    characters: int | None = None
    cache_hit: bool = False
    detail: str | None = None


class UsageSummary(BaseModel):
    entries: list[UsageEntry] = Field(default_factory=list)
    totals: dict[str, dict[str, float]] = Field(default_factory=dict)


_LOCK = threading.Lock()
_ENTRIES: deque[UsageEntry] = deque(maxlen=500)


def record_usage(provider: Provider, operation: str, **fields: object) -> UsageEntry:
    entry = UsageEntry(
        timestamp=datetime.now(UTC), provider=provider, operation=operation, **fields
    )
    with _LOCK:
        _ENTRIES.append(entry)
    return entry


def usage_summary(limit: int = 100) -> UsageSummary:
    with _LOCK:
        entries = list(_ENTRIES)
    totals: dict[str, dict[str, float]] = {}
    for entry in entries:
        bucket = totals.setdefault(entry.provider, {"calls": 0, "failures": 0, "cache_hits": 0})
        bucket["calls"] += 1
        bucket["failures"] += 0 if entry.ok else 1
        bucket["cache_hits"] += 1 if entry.cache_hit else 0
        for name in ("prompt_tokens", "output_tokens", "pages", "credits", "characters", "duration_ms"):
            value = getattr(entry, name)
            if value:
                bucket[name] = bucket.get(name, 0) + value
    return UsageSummary(entries=entries[-limit:], totals=totals)


def reset_usage() -> None:
    with _LOCK:
        _ENTRIES.clear()
