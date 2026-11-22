import asyncio
import copy
import os
import shutil
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from forge_research import source_research as sr
from forge_research.agents import source_discovery
from forge_research.evidence import datasheets as ds
from forge_research.providers.pangram import AuthorshipScan
from tests.test_datasheet_verification import PART, fixture


REAL_SCAN = sr.scan_original
REAL_FETCH = sr.fetch_source


def scan(ai, *, status="completed", assisted=0):
    return AuthorshipScan(subject="Original source", scope="Original PDF", status=status,
                          fraction_ai=ai, fraction_ai_assisted=assisted,
                          fraction_human=1-ai-assisted, characters_scanned=1000)


def parsed(part, doc, data):
    raw, read = fixture()
    facts, _ = ds.facts_from_extraction(raw["result"])
    ds.compare_independent(facts, read)
    for fact in facts: fact.document_url = doc.url
    return ds.SourceDocument(url=doc.url, title=doc.title, revision="v1", sha256="a"*64,
                             independent_read=read), facts


class PolicyTests(unittest.TestCase):
    def test_inclusive_cutoff_and_optional_assisted_metric(self):
        policy = sr.SourcePolicy(exclude_at_ai_fraction=.5)
        self.assertEqual(sr.admission_decision([scan(.5)], policy)[0], "excluded")
        self.assertEqual(sr.admission_decision([scan(.49)], policy)[0], "accepted")
        self.assertEqual(sr.admission_decision([scan(.3, assisted=.3)], policy)[0], "accepted")
        policy.include_ai_assisted = True
        self.assertEqual(sr.admission_decision([scan(.3, assisted=.3)], policy)[0], "excluded")

    def test_missing_truncated_and_incomplete_scans_cannot_pass(self):
        for scans in ([], [scan(0, status="error")], [scan(0).model_copy(update={"truncated": True})], [scan(0), scan(0, status="skipped")]):
            self.assertEqual(sr.admission_decision(scans, sr.SourcePolicy())[0], "unverified")

    def test_character_weighted_fraction_uses_every_scanned_section(self):
        a, b = scan(.1), scan(.9)
        b.characters_scanned = 3000
        result = sr.admission_decision([a, b], sr.SourcePolicy())
        self.assertAlmostEqual(result[2], .7)
        self.assertEqual(result[0], "excluded")

    def test_invalid_threshold_and_unbounded_retries_are_rejected(self):
        for args in ({"exclude_at_ai_fraction": 1.1}, {"exclude_at_ai_fraction": float("nan")}, {"max_retries": 3}):
            with self.assertRaises(ValueError): sr.SourcePolicy(**args)

    @unittest.skipUnless(shutil.which("pdftotext"), "Poppler not installed")
    def test_original_pdf_text_is_extracted_without_gemini_rewriting(self):
        stream = b"BT /F1 12 Tf 50 100 Td (Original source evidence.) Tj ET"
        objects = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
                   b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
                   b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
                   b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream"]
        data = b"%PDF-1.4\n"
        offsets = [0]
        for i, obj in enumerate(objects, 1):
            offsets.append(len(data))
            data += str(i).encode() + b" 0 obj\n" + obj + b"\nendobj\n"
        xref = len(data)
        data += b"xref\n0 6\n0000000000 65535 f \n" + b"".join(f"{n:010d} 00000 n \n".encode() for n in offsets[1:])
        data += f"trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF".encode()
        self.assertIn("Original source evidence.", sr.pdf_text(data))


class SourceLoopTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        env = patch.dict(os.environ, {"REDUCTO_API_KEY": "fake", "PANGRAM_API_KEY": "fake", "GEMINI_API_KEY": "fake", "ANTHROPIC_API_KEY": "fake"})
        env.start(); self.addCleanup(env.stop)
        self.bad = ds.BundleDocument(url="https://manufacturer.test/ai.pdf", title="Excluded source")
        self.good = ds.BundleDocument(url="https://manufacturer.test/original.pdf", title="Original source")
        self.discovery = AsyncMock(side_effect=[[], [source_discovery.DiscoveredDocument(part_id=PART.id, document=self.good, specialist="sourcing")]])
        self.fetch = AsyncMock(side_effect=lambda url, hosts: ("%PDF-" + url).encode())
        self.parse = AsyncMock(side_effect=parsed)
        self.detector = AsyncMock(side_effect=lambda data, doc: [scan(.8 if doc.url == self.bad.url else .1)])
        for module, attr, replacement in ((sr, "discover_documents", self.discovery), (sr, "fetch_source", self.fetch),
                                           (sr, "scan_original", self.detector), (ds, "_parse_pdf", self.parse),
                                           (ds, "documents_for", MagicMock(return_value=[self.bad]))):
            p = patch.object(module, attr, replacement); p.start(); self.addCleanup(p.stop)

    async def test_high_ai_source_is_excluded_retry_finds_replacement_and_audit_is_retained(self):
        events = []
        result = await sr.research_sources("brief", [PART], sr.SourcePolicy(), emit=events.append)
        self.assertEqual(result.status, "accepted", result.reasons)
        self.assertEqual(result.rounds, 2)
        self.assertEqual([s.decision for s in result.sources], ["excluded", "accepted"])
        self.assertTrue(any(e.get("event") == "retry" for e in events))
        evidence = sr.admitted_evidence(PART, result)
        self.assertTrue(evidence.design_ready, evidence.blocking_reasons)
        self.assertEqual([d.url for d in evidence.documents], [self.good.url])
        self.assertIn(self.bad.url, self.discovery.call_args.args[2])

    async def test_parse_and_detector_start_in_parallel(self):
        parse_started, scan_started = asyncio.Event(), asyncio.Event()
        async def parse_both(part, doc, data):
            parse_started.set(); await scan_started.wait()
            return parsed(part, doc, data)
        async def scan_both(data, doc):
            scan_started.set(); await parse_started.wait()
            return [scan(.1)]
        self.parse.side_effect, self.detector.side_effect = parse_both, scan_both
        result = await asyncio.wait_for(sr.research_sources("brief", [PART], sr.SourcePolicy(max_retries=0)), 2)
        self.assertEqual(result.status, "accepted")

    async def test_retry_budget_stops_with_no_admitted_sources(self):
        result = await sr.research_sources("brief", [PART], sr.SourcePolicy(max_retries=0))
        self.assertEqual(result.status, "needs_review")
        self.assertEqual(result.rounds, 1)
        self.assertEqual(self.discovery.call_count, 1)
        self.assertTrue(result.reasons)
        with self.assertRaises(ds.EvidenceBlocked):
            sr.require_admitted_evidence(SimpleNamespace(source_research=result), [PART])

    async def test_identical_pdf_at_new_url_does_not_reset_a_rejection(self):
        self.fetch.side_effect = None
        self.fetch.return_value = b"%PDF-identical"
        result = await sr.research_sources("brief", [PART], sr.SourcePolicy())
        self.assertEqual(result.status, "needs_review")
        self.assertEqual(self.detector.call_count, 1)
        self.assertEqual(result.sources[-1].decision, "unverified")

    async def test_missing_key_stops_before_search_or_fetch(self):
        with patch.dict(os.environ, {"PANGRAM_API_KEY": ""}):
            result = await sr.research_sources("brief", [PART], sr.SourcePolicy())
        self.assertEqual(result.status, "needs_review")
        self.discovery.assert_not_called(); self.fetch.assert_not_called()

    async def test_original_text_not_summaries_goes_to_detector_and_no_tail_is_lost(self):
        text = "Original manufacturer sentence. " * 1000
        chunks = []
        async def capture(chunk, **kwargs):
            chunks.append(chunk)
            return scan(.1)
        with patch.object(sr, "pdf_text", return_value=text), patch.object(sr, "analyze_text", side_effect=capture):
            await REAL_SCAN(b"%PDF", self.good)
        self.assertEqual("".join(chunks), text)
        self.assertTrue(all(len(c) <= 24_000 for c in chunks))

    async def test_private_or_unknown_source_hosts_are_not_fetched(self):
        with self.assertRaises(ValueError):
            await REAL_FETCH("http://127.0.0.1/private", {"manufacturer.test"})


class DiscoveryTests(unittest.IsolatedAsyncioTestCase):
    async def test_three_specialists_have_search_tools_and_return_pdf_candidates(self):
        text = f"{PART.id} | https://manufacturer.test/source.pdf | Manufacturer guide"
        create = AsyncMock(return_value=SimpleNamespace(content=[SimpleNamespace(type="text", text=text)], usage=SimpleNamespace(input_tokens=1, output_tokens=1)))
        client = MagicMock()
        client.__aenter__ = AsyncMock(return_value=SimpleNamespace(messages=SimpleNamespace(create=create)))
        client.__aexit__ = AsyncMock(return_value=False)
        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "fake"}), patch.object(source_discovery, "claude_client", return_value=client):
            docs = await source_discovery.discover_documents("brief", [PART], ["https://excluded.test/x.pdf"], round_number=2)
        self.assertEqual(create.call_count, 3)
        self.assertEqual(len(docs), 1)
        for call in create.call_args_list:
            self.assertEqual(call.kwargs["tools"][0]["type"], "web_search_20260209")
            self.assertIn("https://excluded.test/x.pdf", str(call.kwargs["messages"]))
