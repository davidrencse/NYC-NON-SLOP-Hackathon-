"""Regression tests for independent reads and the live-design evidence gate."""
import asyncio
import copy
import os
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

from forge_research.catalog import PARTS
from forge_research.evidence import datasheets as ds
from forge_research.providers.datasheet_review import IndependentRead, ReviewUnavailable
from tests.test_evidence import cited

PART = next(p for p in PARTS if p.role == "emg_sensor")


def fixture():
    lo, hi = PART.supply_range_mv
    ranges = {
        "supply_voltage_recommended": {"min": lo, "typ": None, "max": hi, "unit": "mV"},
        "supply_voltage_absolute_max": {"min": None, "typ": None, "max": hi, "unit": "mV"},
        "operating_current": {"min": None, "typ": None, "max": PART.max_current_ma or 10, "unit": "mA"},
    }
    result = {"document_revision": cited("v1", 1), "part_number": cited(PART.sku, 1),
              "manufacturer": cited(PART.manufacturer, 1)}
    observations = []
    for field, block in ranges.items():
        block.update(conditions="", subject=PART.sku)
        result[field] = cited(block, 2)
        observations.append(dict(field=field, **block, page=2, quote="Manufacturer table row",
                                 conditions_complete=True))
    dims = dict(zip(("length", "width", "height"), PART.dimensions_mm))
    result["dimensions"] = cited({**dims, "unit": "mm", "conditions": "", "subject": PART.sku}, 3)
    for axis, value in dims.items():
        observations.append(dict(field=f"dimension_{axis}", value=value, unit="mm", page=3,
                                 quote="Board outline drawing", conditions="", conditions_complete=True,
                                 subject=PART.sku))
    read = IndependentRead(manufacturer=PART.manufacturer, part_number=PART.sku, revision="v1",
                           identity_matches=True, identity_page=1, identity_quote="Exact manufacturer SKU",
                           identity_reason="Exact board and revision", facts=observations)
    return {"result": result, "usage": {"num_pages": 4}}, read


class IndependentComparisonTests(unittest.TestCase):
    def compare(self, mutate=None):
        raw, read = fixture()
        if mutate:
            mutate(raw, read)
        facts, _ = ds.facts_from_extraction(raw["result"])
        ds.compare_independent(facts, read)
        return facts

    def test_matching_readings_are_agreed(self):
        self.assertTrue(all(f.verification == "agreed" for f in self.compare()))

    def test_unit_equivalence_is_accepted(self):
        def change(raw, read):
            f = read.facts[0]
            f.min /= 1000
            f.max /= 1000
            f.unit = "V"
        self.assertEqual(self.compare(change)[0].verification, "agreed")

    def test_value_conditions_subject_page_identity_and_missing_limits_block(self):
        mutations = [
            lambda raw, read: setattr(read.facts[0], "max", 9000),
            lambda raw, read: setattr(read.facts[0], "conditions", "Wi-Fi disabled"),
            lambda raw, read: setattr(read.facts[0], "conditions_complete", False),
            lambda raw, read: setattr(read.facts[0], "subject", "bare chip"),
            lambda raw, read: setattr(read.facts[0], "page", 3),
            lambda raw, read: setattr(read, "identity_matches", False),
            lambda raw, read: setattr(read.facts[0], "min", None),
            lambda raw, read: raw["result"]["supply_voltage_recommended"].update(citations=[]),
            lambda raw, read: read.facts.append(read.facts[0].model_copy()),
        ]
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                self.assertNotEqual(self.compare(mutate)[0].verification, "agreed")

    def test_small_critical_disagreement_is_not_merged_as_corroboration(self):
        a = self.compare()[0]
        b = a.model_copy(update={"max": a.max * 1.01})
        merged = ds.merge_facts([[a], [b]])
        self.assertEqual(len(merged), 2)
        self.assertTrue(all(f.verification == "disputed" for f in merged))

    def test_nonfinite_numbers_rejected(self):
        raw, _ = fixture()
        raw["result"]["operating_current"]["value"]["max"] = float("nan")
        with self.assertRaises(ValueError):
            ds.facts_from_extraction(raw["result"])


class VerificationPipelineTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        env = patch.dict(os.environ, {"FORGE_CACHE_DIR": self.tmp.name, "REDUCTO_API_KEY": "fake",
                                      "ANTHROPIC_API_KEY": "fake", "GOOGLE_API_KEY": ""})
        env.start()
        self.addCleanup(env.stop)
        self.raw, self.read = fixture()
        self.fetch = AsyncMock(return_value=b"%PDF-test")
        self.extract = AsyncMock(side_effect=lambda *a, **k: copy.deepcopy(self.raw))
        self.review = AsyncMock(side_effect=lambda *a, **k: self.read.model_copy(deep=True))
        for attr, mock in (("fetch_pdf", self.fetch), ("extract", self.extract), ("read_pdf", self.review)):
            p = patch.object(ds, attr, mock)
            p.start()
            self.addCleanup(p.stop)
        # Isolate a single full-board document from catalog bundles.
        p = patch.object(ds, "documents_for", return_value=[ds.BundleDocument(url="https://manufacturer.test/board.pdf", title="Board datasheet")])
        p.start()
        self.addCleanup(p.stop)

    async def test_complete_evidence_unblocks_and_readers_receive_same_bytes(self):
        ev = await ds.extract_part_evidence(PART)
        self.assertTrue(ev.design_ready, ev.blocking_reasons)
        self.assertEqual(self.extract.call_args.args[0], self.review.call_args.args[0])
        self.assertNotIn("result", self.review.call_args.kwargs)
        self.assertNotIn("facts", self.review.call_args.kwargs)
        again = await ds.extract_part_evidence(PART)
        self.assertTrue(again.design_ready)
        self.assertEqual(self.extract.call_count, 1)
        self.assertEqual(self.review.call_count, 1)

    async def test_wrong_variant_revision_missing_facts_and_provider_failure_block(self):
        for case in ("variant", "revision", "missing", "failure", "identity", "no_key", "conditions"):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"FORGE_CACHE_DIR": directory}):
                raw, read = fixture()
                if case == "variant":
                    read.part_number = "wrong-variant"
                elif case == "revision":
                    read.revision = "v2"
                elif case == "missing":
                    raw["result"].pop("dimensions")
                elif case == "identity":
                    read.identity_matches = False
                elif case == "conditions":
                    read.facts[0].conditions = "Only at 25 C"
                self.raw, self.read = raw, read
                self.review.side_effect = ReviewUnavailable("Gemini unavailable") if case == "failure" else lambda *a, **k: self.read.model_copy(deep=True)
                with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "" if case == "no_key" else "fake"}):
                    ev = await ds.extract_part_evidence(PART)
                self.assertFalse(ev.design_ready)
                self.assertTrue(ev.blocking_reasons)

    async def test_model_change_invalidates_only_independent_cache(self):
        await ds.extract_part_evidence(PART)
        with patch.dict(os.environ, {"FORGE_DATASHEET_REVIEW_MODEL": "different-model"}):
            await ds.extract_part_evidence(PART)
        self.assertEqual(self.extract.call_count, 1)
        self.assertEqual(self.review.call_count, 2)

    async def test_catalog_fallback_and_live_gate_fail_closed(self):
        registry = ds.EvidenceRegistry()
        with patch.object(ds, "evidence_registry", registry):
            with patch.dict(os.environ, {"REDUCTO_API_KEY": ""}):
                with self.assertRaises(ds.EvidenceBlocked):
                    await ds.require_design_evidence([PART])
                with self.assertRaises(ds.EvidenceBlocked):
                    ds.require_cached_design_evidence([PART])
            await ds.require_design_evidence([PART])
            ds.require_cached_design_evidence([PART])
            with patch.dict(os.environ, {"ANTHROPIC_API_KEY": ""}):
                with self.assertRaises(ds.EvidenceBlocked):
                    ds.require_cached_design_evidence([PART])

    async def test_changed_catalog_snapshot_cannot_reuse_approval(self):
        registry = ds.EvidenceRegistry()
        with patch.object(ds, "evidence_registry", registry):
            await ds.require_design_evidence([PART])
            changed = PART.model_copy(update={"dimensions_mm": (999, 999, 999)})
            with self.assertRaises(ds.EvidenceBlocked):
                ds.require_cached_design_evidence([changed])
            with self.assertRaises(ds.EvidenceBlocked):
                await ds.require_design_evidence([changed])

    async def test_inflight_reads_cannot_restore_cleared_results(self):
        entered, release = asyncio.Event(), asyncio.Event()
        async def slow(part, **kwargs):
            entered.set()
            await release.wait()
            return ds.catalog_evidence(part)
        registry = ds.EvidenceRegistry()
        with patch.object(ds, "extract_part_evidence", slow):
            registry.prefetch([PART])
            await entered.wait()
            task = registry._tasks[PART.id]
            registry.clear()
            release.set()
            await asyncio.gather(task, return_exceptions=True)
            self.assertEqual(registry.status(), {})


def _claude_client(method: str, mock):
    from types import SimpleNamespace
    from unittest.mock import MagicMock
    client = MagicMock()
    client.__aenter__ = AsyncMock(return_value=SimpleNamespace(messages=SimpleNamespace(**{method: mock})))
    client.__aexit__ = AsyncMock(return_value=False)
    return client


class ClaudeAdapterTests(unittest.IsolatedAsyncioTestCase):
    async def test_sdk_receives_pdf_and_independent_schema_without_candidate_answers(self):
        import base64
        from types import SimpleNamespace
        from forge_research.providers import claude, datasheet_review as provider
        _, read = fixture()
        parse = AsyncMock(return_value=SimpleNamespace(parsed_output=read, usage=SimpleNamespace(input_tokens=1, output_tokens=1)))
        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "fake"}), patch.object(claude, "claude_client", return_value=_claude_client("parse", parse)):
            result = await provider.read_pdf(b"%PDF-same-original", subject=PART.sku, manufacturer=PART.manufacturer)
        self.assertEqual(result, read)
        request = parse.call_args.kwargs
        content = request["messages"][0]["content"]
        document = next(block for block in content if block["type"] == "document")
        self.assertEqual(base64.b64decode(document["source"]["data"]), b"%PDF-same-original")
        self.assertEqual(document["source"]["media_type"], "application/pdf")
        self.assertIs(request["output_format"], provider.IndependentRead)
        self.assertNotIn("Reducto", str(content))

    async def test_malformed_output_is_unavailable_and_does_not_leak_exception_text(self):
        from types import SimpleNamespace
        from forge_research.providers import claude, datasheet_review as provider
        parse = AsyncMock(side_effect=ValueError("secret parser detail"))
        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "fake"}), patch.object(claude, "claude_client", return_value=_claude_client("parse", parse)):
            with self.assertRaises(provider.ReviewUnavailable) as caught:
                await provider.read_pdf(b"%PDF", subject=PART.sku, manufacturer=PART.manufacturer)
        self.assertNotIn("secret parser detail", str(caught.exception))


class LiveDesignGateTests(unittest.IsolatedAsyncioTestCase):
    async def test_live_research_keeps_report_but_does_not_publish_unverified_design(self):
        from types import SimpleNamespace
        from forge_research import studio
        from forge_research.offline import DEMO_BRIEF, DemoModel
        from forge_research.workflow import run_research

        report = await run_research(DEMO_BRIEF, DemoModel(), mode="offline")
        report.mode = "gemini"
        registry = ds.EvidenceRegistry()
        events = []
        with patch.dict(os.environ, {"REDUCTO_API_KEY": ""}), \
             patch.object(ds, "evidence_registry", registry), \
             patch.object(studio, "evidence_registry", registry), \
             patch.object(studio, "live_model", return_value=SimpleNamespace(mode="gemini", adk_model=lambda: "test-model")), \
             patch.object(studio, "run_research", AsyncMock(return_value=report)), \
             patch.object(studio, "publish_prototype") as publish:
            result = await studio._run_catalog_research(studio.ResearchRequest(mode="live", brief=DEMO_BRIEF, source_policy={"enabled": False}), events.append)
        publish.assert_not_called()
        self.assertTrue(result.evidence_blocked)
        self.assertIsNone(result.prototype)
        self.assertIsNone(result.project)
        self.assertTrue(result.evidence)
        self.assertTrue(any(e.get("stage") == "evidence" and e.get("status") == "failed" for e in events))

    async def test_sync_publication_guard_runs_before_geometry(self):
        from types import SimpleNamespace
        from uuid import uuid4
        from forge_research import studio
        report = SimpleNamespace(mode="gemini", review=SimpleNamespace(selected_parts=[PART]))
        with patch.object(ds, "evidence_registry", ds.EvidenceRegistry()), \
             patch.object(studio, "build_assembly") as build:
            with self.assertRaises(ds.EvidenceBlocked):
                studio.publish_prototype(report, uuid4(), 1)
        build.assert_not_called()

    async def test_revision_gate_runs_before_mutating_project_state(self):
        from types import SimpleNamespace
        from forge_research.project import evaluate_and_commit_revision
        project = SimpleNamespace(report=SimpleNamespace(mode="gemini"), catalog_snapshot={PART.id: PART})
        spec = SimpleNamespace(components=[SimpleNamespace(catalog_id=PART.id)])
        with patch.dict(os.environ, {"REDUCTO_API_KEY": ""}), \
             patch.object(ds, "evidence_registry", ds.EvidenceRegistry()):
            with self.assertRaises(ds.EvidenceBlocked):
                await evaluate_and_commit_revision(project, spec, label="Blocked change")
        # No access to current revision, procurement or geometry was needed.
        self.assertFalse(hasattr(project, "current_revision"))


if __name__ == "__main__":
    unittest.main()
