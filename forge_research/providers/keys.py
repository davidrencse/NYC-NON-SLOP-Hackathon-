"""Server-side store for provider API keys entered in the studio.

Keys set through the setup screen live in this process's environment, so every
adapter (Gemini, Reducto, Pangram, Modal) reads them the same way it reads
keys from a shell or .env file. They are never returned to the browser: status
responses only say whether a key is set and show its last four characters.

When the user asks to remember them, keys are written to ``.forge-keys.local``
at the repository root (gitignored, mode 0600). Delete that file to forget them.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from .defaults import DEFAULT_GEMINI_MODEL, configured_gemini_model

KEYS_FILE = Path(os.getenv("FORGE_KEYS_FILE") or Path(__file__).resolve().parents[2] / ".forge-keys.local")

# field -> (env var, provider, label, secret)
FIELDS: dict[str, tuple[str, str, str, bool]] = {
    "gemini_api_key": ("GEMINI_API_KEY", "gemini", "Gemini API key", True),
    "gemini_model": ("FORGE_GEMINI_MODEL", "gemini", "Gemini model", False),
    "reducto_api_key": ("REDUCTO_API_KEY", "reducto", "Reducto API key", True),
    "pangram_api_key": ("PANGRAM_API_KEY", "pangram", "Pangram API key", True),
    "modal_cad_url": ("FORGE_MODAL_CAD_URL", "modal", "Modal CAD endpoint URL", False),
    "modal_token": ("FORGE_MODAL_TOKEN", "modal", "Modal endpoint token", True),
}

PROVIDERS: dict[str, dict[str, str]] = {
    "gemini": {"title": "Gemini", "role": "Agent reasoning and report writing", "needs": "gemini_api_key,gemini_model"},
    "reducto": {"title": "Reducto", "role": "Reads every datasheet for every part", "needs": "reducto_api_key"},
    "pangram": {"title": "Pangram", "role": "Authorship signals only; source evidence and Lean check design claims", "needs": "pangram_api_key"},
    "modal": {"title": "Modal", "role": "Cloud CadQuery enclosure generation", "needs": "modal_cad_url"},
}

_ENV_LINE = re.compile(r"^([A-Z0-9_]+)=(.*)$")


class KeyUpdate(BaseModel):
    """Values to set. Omitted fields are unchanged; an empty string clears a field."""

    gemini_api_key: str | None = Field(default=None, max_length=512)
    gemini_model: str | None = Field(default=None, max_length=200)
    reducto_api_key: str | None = Field(default=None, max_length=512)
    pangram_api_key: str | None = Field(default=None, max_length=512)
    modal_cad_url: str | None = Field(default=None, max_length=1000)
    modal_token: str | None = Field(default=None, max_length=512)
    remember: bool = False


def _clean(value: str) -> str:
    # One line only: keys are written to an env-style file.
    return value.strip().replace("\n", "").replace("\r", "")


def _hint(field: str, value: str) -> str:
    secret = FIELDS[field][3]
    if not secret:
        return value
    return f"…{value[-4:]}" if len(value) > 8 else "set"


def integrations_status() -> dict[str, Any]:
    fields: dict[str, dict[str, Any]] = {}
    for field, (env, provider, label, secret) in FIELDS.items():
        value = os.getenv(env, "").strip()
        if field == "gemini_model":
            value = configured_gemini_model()
        if field == "gemini_api_key" and not value:
            value = os.getenv("GOOGLE_API_KEY", "").strip()
        fields[field] = {
            "env": env,
            "provider": provider,
            "label": label,
            "secret": secret,
            "set": bool(value),
            "hint": _hint(field, value) if value else None,
        }
    providers = {}
    for name, meta in PROVIDERS.items():
        needed = meta["needs"].split(",")
        providers[name] = {**meta, "configured": all(fields[f]["set"] for f in needed)}
    if providers["gemini"]["configured"] and not configured_gemini_model().startswith("gemini-"):
        providers["gemini"]["configured"] = False
    return {"fields": fields, "providers": providers, "remembered": KEYS_FILE.exists(),
            "default_gemini_model": DEFAULT_GEMINI_MODEL}


def update_keys(update: KeyUpdate) -> dict[str, Any]:
    if update.modal_cad_url and not update.modal_cad_url.strip().startswith("https://"):
        from fastapi import HTTPException

        raise HTTPException(422, "The Modal endpoint must be an https:// URL.")
    if update.gemini_model and not update.gemini_model.strip().startswith("gemini-"):
        from fastapi import HTTPException

        raise HTTPException(422, "Gemini model names start with 'gemini-'.")
    for field, (env, *_rest) in FIELDS.items():
        value = getattr(update, field)
        if value is None:
            continue
        value = _clean(value)
        if value:
            os.environ[env] = value
        else:
            os.environ.pop(env, None)
            if field == "gemini_api_key":
                os.environ.pop("GOOGLE_API_KEY", None)
    if any(os.getenv(name, "").strip() for name in ("GEMINI_API_KEY", "GOOGLE_API_KEY")):
        os.environ["FORGE_GEMINI_MODEL"] = configured_gemini_model()
    if update.remember:
        save_keys()
    return integrations_status()


def save_keys() -> None:
    lines = [f"{env}={os.environ[env]}" for env, *_ in FIELDS.values() if os.getenv(env)]
    KEYS_FILE.write_text("\n".join(lines) + "\n")
    KEYS_FILE.chmod(0o600)


def forget_saved_keys() -> None:
    KEYS_FILE.unlink(missing_ok=True)


def load_saved_keys() -> None:
    """Load remembered keys without overriding values from the real environment."""
    try:
        text = KEYS_FILE.read_text()
    except OSError:
        return
    allowed = {env for env, *_ in FIELDS.values()}
    for line in text.splitlines():
        match = _ENV_LINE.match(line.strip())
        if match and match.group(1) in allowed and not os.getenv(match.group(1)):
            os.environ[match.group(1)] = match.group(2)
