"""Minimal Claude Messages API client for the Modal workers (httpx only, no SDK).

Content uses the Messages API block format:
  {"type": "text", "text": ...}
  {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": ...}}
"""

from __future__ import annotations

import json
import os
import time
from typing import Any

ENDPOINT = "https://api.anthropic.com/v1/messages"
VERSION = "2023-06-01"


def default_model() -> str:
    return os.environ.get("FORGE_BODY_MODEL") or os.environ.get("FORGE_CLAUDE_MODEL") or "claude-opus-5-5"


def _headers(api_key: str) -> dict[str, str]:
    return {"x-api-key": api_key, "anthropic-version": VERSION, "content-type": "application/json"}


def text_block(text: str) -> dict[str, Any]:
    return {"type": "text", "text": text}


def image_block(png_b64: str) -> dict[str, Any]:
    return {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": png_b64}}


def complete(api_key: str, model: str, system: str, content: list[dict], *, max_tokens: int = 8000, timeout: float = 20) -> tuple[str, dict]:
    """One non-streamed call. Returns (text, {prompt, output})."""
    import httpx

    response = httpx.post(
        ENDPOINT,
        headers=_headers(api_key),
        json={"model": model, "max_tokens": max_tokens, "system": system, "messages": [{"role": "user", "content": content}]},
        timeout=timeout,
    )
    if response.status_code != 200:
        raise RuntimeError(f"Claude {response.status_code}: {response.text[:300]}")
    data = response.json()
    text = "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text")
    usage = data.get("usage", {})
    return text, {"prompt": usage.get("input_tokens") or 0, "output": usage.get("output_tokens") or 0}


def stream(api_key: str, model: str, system: str, content: list[dict], *, max_tokens: int = 32000, timeout: float = 600) -> tuple[str, dict]:
    """Streamed call so a long code answer keeps the connection alive. Returns (text, {prompt, output})."""
    import httpx

    body = {"model": model, "max_tokens": max_tokens, "system": system, "stream": True,
            "messages": [{"role": "user", "content": content}]}
    text: list[str] = []
    usage = {"prompt": 0, "output": 0}
    with httpx.stream("POST", ENDPOINT, headers=_headers(api_key), json=body, timeout=httpx.Timeout(300, connect=20)) as response:
        if response.status_code != 200:
            raise RuntimeError(f"Claude {response.status_code}: {response.read().decode()[:300]}")
        started = time.monotonic()
        for line in response.iter_lines():
            if not line.startswith("data:"):
                continue
            event = json.loads(line[5:])
            kind = event.get("type")
            if kind == "content_block_delta" and event.get("delta", {}).get("type") == "text_delta":
                text.append(event["delta"].get("text", ""))
            elif kind == "message_start":
                usage["prompt"] = event.get("message", {}).get("usage", {}).get("input_tokens") or 0
            elif kind == "message_delta":
                usage["output"] = event.get("usage", {}).get("output_tokens") or usage["output"]
            elif kind == "error":
                raise RuntimeError(f"Claude stream error: {str(event.get('error'))[:300]}")
            if time.monotonic() - started > timeout:
                raise RuntimeError(f"Claude answer took longer than {timeout:.0f} s.")
    return "".join(text), usage


def extract_json(text: str) -> Any:
    """Parse a JSON answer, tolerating a ```json fence or prose around the object."""
    import re

    fenced = re.search(r"```(?:json)?\s*\n(.*?)```", text, re.S)
    if fenced:
        text = fenced.group(1)
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end < start:
        raise ValueError("Claude answer contained no JSON object.")
    return json.loads(text[start:end + 1])
