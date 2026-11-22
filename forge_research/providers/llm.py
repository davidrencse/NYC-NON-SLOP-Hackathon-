"""Gemini selection for live research and documentation.

Offline paths remain available when Gemini is not configured. Legacy provider
preferences and Nous credentials do not affect model selection.
"""

from __future__ import annotations

import asyncio
import os
import time
from dataclasses import dataclass
from typing import Literal

from google.adk.models import BaseLlm

from .usage import record_usage
from .defaults import configured_gemini_model

LiveMode = Literal["gemini"]


class ProviderUnavailable(RuntimeError):
    pass


def gemini_model() -> str | None:
    model = configured_gemini_model()
    has_key = any(os.getenv(name, "").strip() for name in ("GEMINI_API_KEY", "GOOGLE_API_KEY"))
    return model if has_key and model.startswith("gemini-") else None


@dataclass(frozen=True)
class LiveModel:
    mode: LiveMode
    name: str

    def adk_model(self) -> str | BaseLlm:
        os.environ["GOOGLE_GENAI_USE_ENTERPRISE"] = "false"
        os.environ["GOOGLE_GENAI_USE_VERTEXAI"] = "false"
        return self.name


def live_model() -> LiveModel | None:
    if model := gemini_model():
        return LiveModel("gemini", model)
    return None


async def _gemini_complete(model: str, system: str, prompt: str, *, operation: str, json_mode: bool) -> str:
    from google import genai
    from google.genai import types

    os.environ["GOOGLE_GENAI_USE_VERTEXAI"] = "false"
    client = genai.Client()
    started = time.monotonic()
    config = types.GenerateContentConfig(
        system_instruction=system,
        temperature=0.3,
        response_mime_type="application/json" if json_mode else None,
    )
    try:
        response = await asyncio.wait_for(
            client.aio.models.generate_content(model=model, contents=prompt, config=config),
            timeout=60,
        )
    except Exception as error:
        record_usage("gemini", operation, model=model, ok=False, detail=type(error).__name__)
        raise
    meta = response.usage_metadata
    record_usage(
        "gemini",
        operation,
        model=model,
        duration_ms=int((time.monotonic() - started) * 1000),
        prompt_tokens=meta.prompt_token_count if meta else None,
        output_tokens=meta.candidates_token_count if meta else None,
    )
    return response.text or ""


async def complete_text(
    system: str, prompt: str, *, operation: str, json_mode: bool = False
) -> tuple[str, LiveModel]:
    """One text completion on the configured live provider."""
    model = live_model()
    if model is None:
        raise ProviderUnavailable("No live LLM provider is configured on the server.")
    return (
        await _gemini_complete(model.name, system, prompt, operation=operation, json_mode=json_mode),
        model,
    )
