"""Claude (Anthropic API) as FORGE's live provider.

One place decides the model, the key and the client so every agent (ADK
workflow, swarm, source discovery, datasheet review, report writing) talks to
Claude the same way. The client is pinned to api.anthropic.com so an
``ANTHROPIC_BASE_URL`` inherited from a developer shell never reroutes traffic.
"""

from __future__ import annotations

import os
from typing import Any, Literal

from anthropic import AsyncAnthropic
from google.adk.models.anthropic_llm import AnthropicLlm

DEFAULT_CLAUDE_MODEL = "claude-opus-5-5"
API_BASE = "https://api.anthropic.com"
Effort = Literal["low", "medium", "high", "xhigh", "max"]


def claude_key() -> str | None:
    return os.getenv("ANTHROPIC_API_KEY", "").strip() or None


def claude_model() -> str:
    return os.getenv("FORGE_CLAUDE_MODEL", "").strip() or DEFAULT_CLAUDE_MODEL


def claude_effort(default: Effort = "medium") -> Effort:
    value = os.getenv("FORGE_CLAUDE_EFFORT", "").strip()
    return value if value in ("low", "medium", "high", "xhigh", "max") else default  # type: ignore[return-value]


def claude_client(timeout: float = 120.0) -> AsyncAnthropic:
    key = claude_key()
    if key is None:
        raise RuntimeError("ANTHROPIC_API_KEY is not configured on the server.")
    return AsyncAnthropic(api_key=key, base_url=API_BASE, timeout=timeout, max_retries=2)


def text_of(message: Any) -> str:
    return "".join(b.text for b in message.content if getattr(b, "type", None) == "text")


class ForgeClaude(AnthropicLlm):
    """ADK model adapter tuned for current Claude models.

    Current models reject sampling parameters and forced tool choice, so those
    are dropped; structured output still rides on ADK's output-schema tool,
    offered with ``auto`` and an explicit instruction to call it.
    """

    effort: Effort = "medium"

    def _build_anthropic_kwargs(self, llm_request, messages, tools, tool_choice, thinking) -> dict[str, Any]:  # type: ignore[override]
        kwargs = super()._build_anthropic_kwargs(llm_request, messages, tools, tool_choice, thinking)
        for name in ("temperature", "top_p", "top_k"):
            kwargs.pop(name, None)
        choice = kwargs.get("tool_choice")
        if isinstance(choice, dict) and choice.get("type") in ("any", "tool"):
            forced = choice.get("name")
            kwargs["tool_choice"] = {"type": "auto"}
            nudge = (
                f"\n\nAnswer only by calling the `{forced}` tool exactly once with your complete result."
                if forced
                else "\n\nAnswer by calling one of the provided tools."
            )
            system = kwargs.get("system")
            if isinstance(system, str):
                kwargs["system"] = system + nudge
            elif isinstance(system, list):
                kwargs["system"] = [*system, {"type": "text", "text": nudge.strip()}]
            else:
                kwargs["system"] = nudge.strip()
        kwargs.setdefault("output_config", {"effort": self.effort})
        kwargs["max_tokens"] = max(int(kwargs.get("max_tokens") or 0), 16000)
        return kwargs


def adk_claude(effort: Effort | None = None) -> ForgeClaude:
    return ForgeClaude(model=claude_model(), client=claude_client(timeout=180.0), effort=effort or claude_effort())
