import asyncio
import json
import os
import struct
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from forge_research.catalog import review_proposal
from forge_research.geometry import GeometryError
from forge_research.offline import DEMO_BRIEF
from forge_research.studio import ResearchRequest, app, projects, research_events

os.environ.setdefault("FORGE_ENCLOSURE", "off")  # skip the CadQuery enclosure job in fast tests

CONTROLLER = "esp32-devkitc-32e"
SENSOR = "myoware-2-dev-27924"
STALE = "This prototype changed. Reload your report before editing it."
UNSUPPORTED_WRIST = "Enter a supported wrist size."
LIVE_UNAVAILABLE = (
    "Live research needs a Claude API key (ANTHROPIC_API_KEY) on the server. You can run the offline sample."
)


def source_parts(manifest):
    return [
        {
            "id": node["id"],
            "catalog_id": node["catalog_id"],
            "part_instance_id": node["part_instance_id"],
            "source": node["source"],
            "position_mm": node["position_mm"],
            "geometry": node["geometry"],
            "material": node["material"],
            "fidelity": node["fidelity"],
        }
        for node in manifest["nodes"]
        if node["catalog_id"] or node["part_instance_id"] or node["source"]
    ]


def strap(manifest):
    return next(node for node in manifest["nodes"] if node["id"] == "strap")


class StudioApiTests(unittest.TestCase):
    def setUp(self):
        projects.clear()
        self.addCleanup(projects.clear)
        # Blank credentials so a developer shell cannot turn a test into a live call.
        env = patch.dict(
            os.environ,
            {"GEMINI_API_KEY": "", "GOOGLE_API_KEY": "", "FORGE_GEMINI_MODEL": "", "NOUS_API_KEY": "", "ANTHROPIC_API_KEY": ""},
        )
        env.start()
        self.addCleanup(env.stop)
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def sample_prototype(self):
        response = self.client.post("/api/research", json={"mode": "sample"})
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertIsNone(body["prototype_error"])
        self.assertIsNotNone(body["prototype"])
        return body

    def stream_events(self, request):
        with self.client.stream("POST", "/api/research/stream", json=request) as response:
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.headers["content-type"], "application/x-ndjson")
            events = [json.loads(line) for line in response.iter_lines()]
        # The advisory agent swarm and compute jobs stream alongside; covered elsewhere.
        return [event for event in events if event["type"] not in ("swarm", "compute")]



    def test_stream_exposes_actual_research_and_build_steps(self):
        events = self.stream_events({"mode": "sample"})
        self.assertEqual(events[0], {"type": "run", "mode": "sample"})
        stages = [
            (event["stage"], event["status"]) for event in events if event["type"] == "stage"
        ]
        self.assertEqual(
            stages,
            [
                (stage, status)
                for stage in (
                    "requirements",
                    "sourcing",
                    "compatibility",
                    "reviewer",
                    "geometry",
                    "export",
                )
                for status in ("running", "completed")
            ],
        )
        lookups = [event for event in events if event["type"] == "catalog_lookup"]
        self.assertCountEqual(
            [event["role"] for event in lookups], ["controller", "emg_sensor"]
        )
        self.assertTrue(
            all(part["technical_sources"] for event in lookups for part in event["parts"])
        )
        self.assertEqual(events[-2]["data"]["format"], "GLB")
        self.assertEqual(events[-1]["type"], "report")
        glb = self.client.get(events[-1]["report"]["prototype"]["glb_url"])
        self.assertEqual(events[-2]["data"]["byte_count"], len(self.assert_glb(glb)))

    def test_stream_retains_report_when_geometry_fails(self):
        with patch(
            "forge_research.studio.build_assembly", side_effect=GeometryError("Fit failed.")
        ):
            events = self.stream_events({"mode": "sample"})
        self.assertEqual(
            [(event["stage"], event["status"]) for event in events[-4:-1]],
            [("geometry", "running"), ("geometry", "failed"), ("export", "skipped")],
        )
        self.assertEqual(events[-1]["report"]["prototype_error"], "Fit failed.")
        self.assertIsNone(events[-1]["report"]["prototype"])
        self.assertEqual(len(projects), 0)

    def test_stream_reports_blocked_parts_and_skips_assembly(self):
        def review_under_tighter_budget(requirements, proposal, evidence):
            return review_proposal(
                requirements.model_copy(update={"budget_usd_cents": 100}), proposal, evidence
            )

        with patch("forge_research.workflow.review_proposal", review_under_tighter_budget):
            events = self.stream_events({"mode": "sample"})
        decision = next(
            event
            for event in events
            if event.get("stage") == "compatibility" and event.get("status") == "completed"
        )
        self.assertEqual(decision["data"]["outcome"], "blocked")
        self.assertEqual(
            [(event["stage"], event["status"]) for event in events[-3:-1]],
            [("geometry", "skipped"), ("export", "skipped")],
        )
        self.assertIsNone(events[-1]["report"]["prototype"])
        self.assertEqual(len(projects), 0)

    def test_stream_closes_with_a_user_facing_configuration_error(self):
        events = self.stream_events({"mode": "live", "brief": DEMO_BRIEF})
        self.assertEqual(
            events,
            [
                {"type": "run", "mode": "live"},
                {"type": "error", "message": LIVE_UNAVAILABLE},
            ],
        )

    def revise(self, project_id, base_revision, wrist):
        return self.client.post(
            f"/api/prototypes/{project_id}/revisions",
            json={"base_revision": base_revision, "wrist_circumference_mm": wrist},
        )

    def assert_source_parts(self, parts):
        catalog_ids = {part["catalog_id"] for part in parts if part["catalog_id"]}
        instances = {part["part_instance_id"] for part in parts}
        self.assertEqual(catalog_ids, {CONTROLLER, SENSOR})
        self.assertTrue({"board", "sensor-1"} <= instances)
        for part in parts:
            if part["catalog_id"]:
                self.assertTrue(part["source"].startswith("https://"))

    def assert_glb(self, response):
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-type"], "model/gltf-binary")
        body = response.content
        self.assertGreaterEqual(len(body), 28)
        magic, version, length = struct.unpack_from("<4sII", body, 0)
        self.assertEqual(magic, b"glTF")
        self.assertEqual(version, 2)
        self.assertEqual(length, len(body))
        chunk_length, chunk_type = struct.unpack_from("<I4s", body, 12)
        self.assertEqual(chunk_type, b"JSON")
        self.assertLessEqual(20 + chunk_length + 8, len(body))
        document = json.loads(body[20 : 20 + chunk_length])
        self.assertEqual(document["asset"]["version"], "2.0")
        names = {node["name"] for node in document["nodes"]}
        self.assertTrue({"board", "sensor-1", "strap"} <= names)
        bin_offset = 20 + chunk_length
        bin_length, bin_type = struct.unpack_from("<I4s", body, bin_offset)
        self.assertEqual(bin_type, b"BIN\0")
        self.assertEqual(12 + 8 + chunk_length + 8 + bin_length, length)
        return body

    def assert_published(self, url, body):
        response = self.client.get(url)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-type"], "model/gltf-binary")
        self.assertEqual(response.content, body)

    def test_sample_research_returns_report_and_prototype(self):
        body = self.sample_prototype()

        self.assertEqual(body["mode"], "offline")
        self.assertEqual(body["model"], "offline-wristband-fixture")
        self.assertEqual(body["brief"], DEMO_BRIEF)
        self.assertEqual(body["schema_version"], 1)
        self.assertEqual(body["review"]["status"], "candidate")
        self.assertCountEqual(
            [part["id"] for part in body["review"]["selected_parts"]],
            [CONTROLLER, SENSOR],
        )
        for part_id in (CONTROLLER, SENSOR):
            self.assertIn(part_id, body["catalog_snapshot"])

        prototype = body["prototype"]
        self.assertEqual(prototype["revision"], 1)
        self.assertEqual(
            prototype["glb_url"],
            f"/api/prototypes/{prototype['project_id']}/model.glb?revision=1",
        )
        manifest = prototype["manifest"]
        self.assertEqual(manifest["schema_version"], 1)
        self.assertEqual(manifest["units"], "mm")
        self.assertEqual(manifest["parameters"]["wrist_circumference_mm"], 170)
        self.assert_source_parts(source_parts(manifest))
        wrist = next(item for item in manifest["findings"] if item["check"] == "wrist_size")
        self.assertEqual(wrist["status"], "unknown")
        self.assertIn("preview default", wrist["detail"])

    def test_versioned_glb_uses_gltf_magic_and_media_type(self):
        prototype = self.sample_prototype()["prototype"]
        published = self.assert_glb(self.client.get(prototype["glb_url"]))

        revised = self.revise(prototype["project_id"], 1, 185)
        self.assertEqual(revised.status_code, 200, revised.text)
        updated = revised.json()
        self.assertEqual(updated["revision"], 2)
        refreshed = self.assert_glb(self.client.get(updated["glb_url"]))
        self.assertNotEqual(published, refreshed)

        stale = self.client.get(prototype["glb_url"])
        self.assertEqual(stale.status_code, 409)
        self.assertEqual(stale.json()["detail"], STALE)
        self.assert_published(updated["glb_url"], refreshed)

    def test_accepted_wrist_revision_preserves_source_parts(self):
        prototype = self.sample_prototype()["prototype"]
        original = source_parts(prototype["manifest"])
        self.assert_source_parts(original)
        original_strap = strap(prototype["manifest"])

        response = self.revise(prototype["project_id"], 1, 185)
        self.assertEqual(response.status_code, 200, response.text)
        revised = response.json()
        self.assertEqual(revised["project_id"], prototype["project_id"])
        self.assertEqual(revised["revision"], 2)
        self.assertEqual(
            revised["glb_url"],
            f"/api/prototypes/{prototype['project_id']}/model.glb?revision=2",
        )
        parameters = revised["manifest"]["parameters"]
        previous = prototype["manifest"]["parameters"]
        self.assertEqual(parameters["wrist_circumference_mm"], 185)
        self.assertEqual(parameters["wall_mm"], previous["wall_mm"])
        self.assertEqual(parameters["clearance_mm"], previous["clearance_mm"])
        self.assertEqual(source_parts(revised["manifest"]), original)
        revised_strap = strap(revised["manifest"])
        self.assertNotEqual(revised_strap["geometry"], original_strap["geometry"])
        self.assertNotEqual(revised_strap["position_mm"], original_strap["position_mm"])
        wrist = next(
            item for item in revised["manifest"]["findings"] if item["check"] == "wrist_size"
        )
        self.assertEqual(wrist["status"], "pass")
        self.assertIn("edited", wrist["detail"])

    def test_stale_revision_and_invalid_wrist_keep_published_object(self):
        prototype = self.sample_prototype()["prototype"]
        accepted = self.revise(prototype["project_id"], 1, 185)
        self.assertEqual(accepted.status_code, 200, accepted.text)
        published = accepted.json()
        glb_url = published["glb_url"]
        published_glb = self.assert_glb(self.client.get(glb_url))

        stale = self.revise(prototype["project_id"], 1, 160)
        self.assertEqual(stale.status_code, 409)
        self.assertEqual(stale.json()["detail"], STALE)
        self.assert_published(glb_url, published_glb)

        for wrist in (90, 241, None):
            with self.subTest(wrist=wrist):
                rejected = self.revise(prototype["project_id"], 2, wrist)
                self.assertEqual(rejected.status_code, 422)
                if wrist is not None:
                    self.assertEqual(rejected.json()["detail"], UNSUPPORTED_WRIST)
                self.assert_published(glb_url, published_glb)

        expired = self.client.get(prototype["glb_url"])
        self.assertEqual(expired.status_code, 409)
        self.assertEqual(expired.json()["detail"], STALE)
        self.assert_published(glb_url, published_glb)

        follow_up = self.revise(prototype["project_id"], 2, 160)
        self.assertEqual(follow_up.status_code, 200, follow_up.text)
        restored = follow_up.json()
        self.assertEqual(restored["revision"], 3)
        self.assertEqual(
            source_parts(restored["manifest"]), source_parts(published["manifest"])
        )
        wrist = restored["manifest"]["parameters"]["wrist_circumference_mm"]
        self.assertEqual(wrist, 160)

    def test_live_research_without_credentials_is_unavailable(self):
        session = self.client.get("/api/session")
        self.assertEqual(session.status_code, 200)
        self.assertIs(session.json()["live"], False)
        self.assertEqual(session.json()["sample_brief"], DEMO_BRIEF)

        response = self.client.post(
            "/api/research",
            json={"mode": "live", "brief": "Design a BLE EMG wristband under $80."},
        )
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["detail"], LIVE_UNAVAILABLE)
        self.assertEqual(len(projects), 0)

        with patch.dict(
            os.environ,
            {"GOOGLE_API_KEY": "local-fixture", "FORGE_GEMINI_MODEL": "local-fixture"},
        ):
            configured = self.client.get("/api/session")
            self.assertIs(configured.json()["live"], False)
            rejected = self.client.post(
                "/api/research",
                json={"mode": "live", "brief": "Design a BLE EMG wristband under $80."},
            )
            self.assertEqual(rejected.status_code, 503)
            self.assertEqual(rejected.json()["detail"], LIVE_UNAVAILABLE)
            self.assertEqual(len(projects), 0)


class ResearchStreamCancellationTests(unittest.IsolatedAsyncioTestCase):
    async def test_closing_stream_cancels_running_producer(self):
        cancelled = asyncio.Event()

        async def wait_for_research(request, progress):
            progress({"type": "stage", "stage": "requirements", "status": "running"})
            try:
                await asyncio.Future()
            finally:
                cancelled.set()

        with patch("forge_research.studio.run_studio_research", wait_for_research):
            stream = research_events(ResearchRequest(mode="sample"))
            self.assertEqual(json.loads(await anext(stream))["type"], "run")
            self.assertEqual(json.loads(await anext(stream))["status"], "running")
            await stream.aclose()
            self.assertTrue(cancelled.is_set())
