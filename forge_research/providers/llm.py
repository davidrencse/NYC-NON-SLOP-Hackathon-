"""Live provider selection for research and documentation.

Claude (ANTHROPIC_API_KEY) is the primary provider; Gemini is used only when
no Claude key is configured. Offline paths remain available without either.
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

LiveMode = Literal["claude", "gemini"]


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
        if self.mode == "claude":
            from .claude import adk_claude

            return adk_claude()
        os.environ["GOOGLE_GENAI_USE_ENTERPRISE"] = "false"
        os.environ["GOOGLE_GENAI_USE_VERTEXAI"] = "false"
        return self.name


def live_model() -> LiveModel | None:
    from .claude import claude_key, claude_model

    if claude_key():
        return LiveModel("claude", claude_model())
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


async def _claude_complete(model: str, system: str, prompt: str, *, operation: str, json_mode: bool) -> str:
    from .claude import claude_client, claude_effort, text_of

    started = time.monotonic()
    if json_mode:
        system += "\n\nReply with one JSON value only: no prose, no markdown fences."
    try:
        async with claude_client() as client:
            message = await client.messages.create(
                model=model,
                max_tokens=16000,
                system=system,
                messages=[{"role": "user", "content": prompt}],
                output_config={"effort": claude_effort("low")},
            )
    except Exception as error:
        record_usage("claude", operation, model=model, ok=False, detail=type(error).__name__)
        raise
    record_usage(
        "claude",
        operation,
        model=model,
        duration_ms=int((time.monotonic() - started) * 1000),
        prompt_tokens=message.usage.input_tokens,
        output_tokens=message.usage.output_tokens,
    )
    text = text_of(message).strip()
    if json_mode and text.startswith("```"):
        text = text.strip("`").removeprefix("json").strip()
    return text


async def complete_text(
    system: str, prompt: str, *, operation: str, json_mode: bool = False
) -> tuple[str, LiveModel]:
    """One text completion on the configured live provider."""
    model = live_model()
    if model is None:
        raise ProviderUnavailable("No live LLM provider is configured on the server.")
    if model.mode == "claude":
        return (
            await _claude_complete(model.name, system, prompt, operation=operation, json_mode=json_mode),
            model,
        )
    return (
        await _gemini_complete(model.name, system, prompt, operation=operation, json_mode=json_mode),
        model,
    )


def provider_error_status(error: BaseException) -> int | None:
    """HTTP status of a provider API failure (Claude or Gemini), else None."""
    try:
        import anthropic

        if isinstance(error, anthropic.APIStatusError):
            return error.status_code
        if isinstance(error, anthropic.APIConnectionError):
            return 503
    except ImportError:
        pass
    from google.genai.errors import APIError

    if isinstance(error, APIError):
        return int(error.code or 502)
    return None
