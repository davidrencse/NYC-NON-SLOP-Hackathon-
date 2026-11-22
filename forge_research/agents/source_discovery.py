"""Parallel search-grounded specialists find PDF candidates for supported parts."""
from __future__ import annotations
import asyncio
import re
from urllib.parse import urlsplit
from pydantic import BaseModel, Field
from ..evidence.datasheets import BundleDocument
from ..models import Part
from ..providers.usage import record_usage
from ..providers.claude import claude_client, claude_key, text_of
from .swarm import swarm_model


class DiscoveredDocument(BaseModel):
    part_id: str
    document: BundleDocument
    specialist: str
    grounded_urls: list[str] = Field(default_factory=list)


async def discover_documents(brief: str, parts: list[Part], excluded: list[str], *, round_number: int) -> list[DiscoveredDocument]:
    if not claude_key():
        return []
    catalog = "\n".join(f"{p.id} | {p.manufacturer} | {p.sku} | {p.name}" for p in parts)
    prompt = (
        f"Research hardware manufacturer PDF sources for this brief: {brief}\nSupported parts:\n{catalog}\n"
        f"Discovery round {round_number}. Avoid these rejected/already-read URLs:\n" + "\n".join(excluded[:30]) +
        "\nUse web search. Find original manufacturer datasheets and board manuals for the exact SKUs. "
        "Prefer full board documents. No resellers, AI rewrites or invented specifications. "
        "Return up to 3 direct HTTPS PDF URLs, one line each in exactly this format: "
        "part_id | https://manufacturer/path.pdf | document title. Omit sources you cannot find."
    )
    async def scout(role: str):
        try:
            async with claude_client(timeout=150.0) as client:
                response = await asyncio.wait_for(client.messages.create(
                    model=swarm_model(), max_tokens=8000,
                    system=f"You are the FORGE {role} research specialist. Discover real source documents, not answers from memory. "
                           "Finish with only the result lines in the requested format.",
                    messages=[{"role": "user", "content": prompt}],
                    tools=[{"type": "web_search_20260209", "name": "web_search", "max_uses": 4}],
                    output_config={"effort": "low"},
                ), 160)
            grounding = []
            for block in response.content:
                if getattr(block, "type", None) == "web_search_tool_result" and isinstance(block.content, list):
                    grounding.extend(r.url for r in block.content if getattr(r, "url", None))
            text = text_of(response)
            found = []
            for line in text.splitlines():
                fields = line.strip().strip("*").split("|")
                if len(fields) != 3: continue
                pid, url, title = (v.strip().strip("` ") for v in fields)
                pid = re.sub(r"^[-*\d. ]+", "", pid)
                if pid not in {p.id for p in parts} or url in excluded: continue
                parsed = urlsplit(url)
                if parsed.scheme != "https" or not parsed.path.lower().endswith(".pdf"): continue
                found.append(DiscoveredDocument(part_id=pid, document=BundleDocument(url=url, title=title or url), specialist=role, grounded_urls=grounding))
            record_usage("claude", f"research.discover.{role}", model=swarm_model(), detail=f"round {round_number}")
            return found
        except Exception as error:
            record_usage("claude", f"research.discover.{role}", model=swarm_model(), ok=False, detail=type(error).__name__)
            return []
    batches = await asyncio.gather(*(scout(role) for role in ("sourcing", "electrical", "mechanical")))
    unique = {}
    for batch in batches:
        for doc in batch:
            unique.setdefault((doc.part_id, doc.document.url), doc)
    return list(unique.values())[:9]
