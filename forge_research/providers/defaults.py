"""Shared Gemini default, with explicit user configuration taking precedence."""

import os

DEFAULT_GEMINI_MODEL = "gemini-4-argon"


def configured_gemini_model() -> str:
    return os.getenv("FORGE_GEMINI_MODEL", "").strip() or DEFAULT_GEMINI_MODEL
